<?php
/*
 * GTFS-Realtime protobuf decoder, used only for the vehicle positions fallback.
 *
 * WHY THIS EXISTS. CapMetro publishes vehicle positions twice: as JSON (cuc7-ywmd) and as
 * protobuf (eiei-9rpf). On 2026-09-01 the JSON publication froze at 12:40:09 CDT for over four
 * hours while the protobuf copy stayed current to the second. The data was never missing; only
 * one of the two publish jobs had stopped. See issue 14.
 *
 * WHAT IT DECODES. The header and VehiclePosition entities, and nothing else. TripUpdate and
 * Alert entities are skipped: the trip updates JSON has never been the thing that breaks, and
 * the alerts feed is not GTFS-RT at all (see alerts.php). Decoding messages we do not use would
 * be surface area with no caller.
 *
 * OUTPUT SHAPE. Deliberately identical to what the Socrata JSON export produces, so join.php,
 * adherence.php and everything downstream cannot tell which source they were handed. That means
 * camelCase keys, enums as their NAMES rather than integers, and timestamps as STRINGS, all of
 * which is what the JSON export does and none of which is what the wire format does:
 *
 *   wire                         JSON export / this decoder
 *   field 4 = 2                  "currentStatus": "IN_TRANSIT_TO"
 *   field 4 = 3 (trip)           "scheduleRelationship": "CANCELED"
 *   uint64 1788284407            "timestamp": "1788284407"
 *
 * The enum mapping is load-bearing, not cosmetic: adherence.php compares scheduleRelationship
 * against CANCELED by name. An enum mapped to the wrong name changes lateness silently, which
 * is the worst failure available here, so the maps below are indexed by the wire number and a
 * value not in the map is passed through as an integer rather than guessed at.
 *
 * NOTHING HERE MAY RAISE. Every decode path returns null on bad input instead of throwing. The
 * caller is a cron job whose only job is to keep writing files, and a fatal in a decoder that
 * exists to survive a bad upstream would defeat the entire point of having it. That is why the
 * enum and string readers below check the type they were handed rather than declaring it: the
 * wire is free to put a length-delimited field where an enum belongs, and a signature of
 * `?int` would turn that into an uncaught TypeError.
 *
 * FLOATS ARE NOT EXACTLY COMPARABLE TO THE JSON. Position fields are protobuf `float`, i.e.
 * 32-bit. Widened to a PHP double, float32(30.26187) is 30.261869430541992, while the JSON
 * export's "30.26187" parses to a different double. The gap is under a millionth of a degree
 * (~7cm on the ground) and irrelevant to anything the board draws, but it means a differential
 * test must compare positions with a tolerance and never with ===.
 *
 * Pure functions. No I/O.
 */

/* TripDescriptor.ScheduleRelationship. Numbers are the wire values, not array order. */
const CM_PB_TRIP_SCHEDULE_RELATIONSHIP = [
    0 => 'SCHEDULED',
    1 => 'ADDED',
    2 => 'UNSCHEDULED',
    3 => 'CANCELED',
    5 => 'REPLACEMENT',
    6 => 'DUPLICATED',
    7 => 'DELETED',
];

/* VehiclePosition.VehicleStopStatus. */
const CM_PB_VEHICLE_STOP_STATUS = [
    0 => 'INCOMING_AT',
    1 => 'STOPPED_AT',
    2 => 'IN_TRANSIT_TO',
];

/* FeedHeader.Incrementality. */
const CM_PB_INCREMENTALITY = [
    0 => 'FULL_DATASET',
    1 => 'DIFFERENTIAL',
];

/* Protobuf wire types this decoder understands. Anything else aborts the parse. */
const CM_PB_WIRE_VARINT = 0;
const CM_PB_WIRE_64BIT  = 1;
const CM_PB_WIRE_LEN    = 2;
const CM_PB_WIRE_32BIT  = 5;

/*
 * Read one base-128 varint starting at $i, advancing $i past it.
 *
 * Returns null on a truncated or over-long varint rather than throwing, so a corrupt feed
 * degrades to "could not decode" instead of a fatal. Ten groups is the maximum for a 64-bit
 * value; an eleventh means the bytes are not a varint and there is no point continuing.
 */
function cm_pb_varint(string $b, int &$i): ?int
{
    $result = 0;
    $shift  = 0;
    $len    = strlen($b);

    while ($i < $len) {
        $byte = ord($b[$i]);
        $i++;
        if ($shift < 64) {
            $result |= ($byte & 0x7F) << $shift;
        }
        $shift += 7;
        if (($byte & 0x80) === 0) {
            return $result;
        }
        if ($shift >= 70) {
            return null;
        }
    }

    return null;
}

/*
 * Split one message into its fields.
 *
 * Returns [fieldNumber => [value, value, ...]] where a value is an int for varints, a raw
 * byte string for length-delimited fields, and a float for the fixed-width ones. Repeated
 * fields keep every occurrence, which is what `entity` needs; scalar readers below just take
 * the last one, matching protobuf's own last-wins rule.
 *
 * Returns null if the bytes are not a well-formed message.
 */
function cm_pb_fields(string $b): ?array
{
    $out = [];
    $i   = 0;
    $len = strlen($b);

    while ($i < $len) {
        $tag = cm_pb_varint($b, $i);
        if ($tag === null) {
            return null;
        }
        $field = $tag >> 3;
        $wire  = $tag & 0x07;
        if ($field === 0) {
            return null;
        }

        switch ($wire) {
            case CM_PB_WIRE_VARINT:
                $v = cm_pb_varint($b, $i);
                if ($v === null) {
                    return null;
                }
                break;

            case CM_PB_WIRE_LEN:
                $n = cm_pb_varint($b, $i);
                if ($n === null || $n < 0 || $i + $n > $len) {
                    return null;
                }
                $v = substr($b, $i, $n);
                $i += $n;
                break;

            case CM_PB_WIRE_32BIT:
                if ($i + 4 > $len) {
                    return null;
                }
                /* 'g' is little-endian float32, which is what protobuf fixed32 floats are. */
                $u = unpack('g', substr($b, $i, 4));
                $v = $u === false ? null : $u[1];
                /*
                 * NAN and INF are representable on the wire and are not encodable as JSON:
                 * json_encode() fails on them outright, and write.php then refuses to write.
                 * That is the same hole invalid UTF-8 opens on the string side, reached
                 * through the float side, so it closes the same way — a message carrying one
                 * is corrupt, not merely unusual.
                 */
                if ($v === null || !is_finite($v)) {
                    return null;
                }
                $i += 4;
                break;

            case CM_PB_WIRE_64BIT:
                if ($i + 8 > $len) {
                    return null;
                }
                /* 'e' is little-endian float64. Only `odometer` uses this and we drop it. */
                $u = unpack('e', substr($b, $i, 8));
                $v = $u === false ? null : $u[1];
                if ($v === null || !is_finite($v)) {
                    return null;
                }
                $i += 8;
                break;

            default:
                /* Groups (3, 4) are deprecated and absent from GTFS-RT. */
                return null;
        }

        $out[$field][] = $v;
    }

    return $out;
}

/* Last occurrence of a scalar field, or null when absent. */
function cm_pb_scalar(array $fields, int $number)
{
    if (!isset($fields[$number]) || $fields[$number] === []) {
        return null;
    }
    $values = $fields[$number];

    return $values[count($values) - 1];
}

/*
 * Map an enum's wire number to its GTFS-RT name.
 *
 * An unknown number is returned as-is rather than defaulted to anything. A future
 * ScheduleRelationship value must not silently become SCHEDULED; a caller comparing against
 * names will simply not match, which is the honest outcome.
 *
 * Anything that is not an integer is treated as absent. An enum field arriving with a
 * non-varint wire type is a corrupt message, and the value is untyped rather than `?int`
 * precisely so that case returns null instead of raising a TypeError out of the cron.
 */
function cm_pb_enum($value, array $map)
{
    if (!is_int($value)) {
        return null;
    }

    return $map[$value] ?? $value;
}

/*
 * A length-delimited field read as a string: the string, null when the field is absent, or
 * false when it is present but unusable.
 *
 * The three-way return is the point. GTFS-RT strings are UTF-8 by specification, so bytes that
 * are not valid UTF-8 are a corrupt field rather than an exotic one, and it matters that a
 * corrupt field is not quietly reported as an absent one: absent fields carry meaning here. A
 * vehicle with no `trip` is not an error downstream, it is a deadhead — join.php reads it as a
 * bus running out of service — so dropping an unreadable tripId would publish an in-service
 * bus as out of service, stating something false rather than admitting a gap.
 *
 * Validating at all is what keeps the run alive: write.php refuses to write a document
 * json_encode() could not encode, and json_encode() fails outright on invalid UTF-8, so one
 * bad byte in one vehicle would otherwise cost every file that vehicle appears in. The JSON
 * publication cannot reach this path — json_decode() rejects it upstream — so the protobuf is
 * what makes it reachable at all.
 */
function cm_pb_string($value)
{
    if ($value === null) {
        return null;
    }
    if (!is_string($value) || !mb_check_encoding($value, 'UTF-8')) {
        return false;
    }

    return $value;
}

/*
 * Put a string field, reporting whether it was usable.
 *
 * Returns false when the field was present but corrupt, which every caller turns into a failed
 * message rather than a message with a hole in it.
 */
function cm_pb_put_string(array &$out, string $key, $value): bool
{
    $s = cm_pb_string($value);
    if ($s === false) {
        return false;
    }
    cm_pb_put($out, $key, $s);

    return true;
}

/* A numeric field of the expected PHP type, or null when it is absent or the wrong wire type. */
function cm_pb_int($value): ?int
{
    return is_int($value) ? $value : null;
}

function cm_pb_float($value): ?float
{
    return is_float($value) ? $value : null;
}

/* Set $out[$key] only when $value is non-null, so absent fields stay absent as in the JSON. */
function cm_pb_put(array &$out, string $key, $value): void
{
    if ($value !== null) {
        $out[$key] = $value;
    }
}

/* TripDescriptor -> the JSON export's trip object. */
function cm_pb_trip_descriptor(string $bytes): ?array
{
    $f = cm_pb_fields($bytes);
    if ($f === null) {
        return null;
    }

    $out = [];
    if (!cm_pb_put_string($out, 'tripId', cm_pb_scalar($f, 1))
        || !cm_pb_put_string($out, 'startTime', cm_pb_scalar($f, 2))
        || !cm_pb_put_string($out, 'startDate', cm_pb_scalar($f, 3))
        || !cm_pb_put_string($out, 'routeId', cm_pb_scalar($f, 5))
    ) {
        return null;
    }
    cm_pb_put($out, 'scheduleRelationship', cm_pb_enum(
        cm_pb_scalar($f, 4),
        CM_PB_TRIP_SCHEDULE_RELATIONSHIP
    ));
    cm_pb_put($out, 'directionId', cm_pb_int(cm_pb_scalar($f, 6)));

    return $out;
}

/*
 * Position -> the JSON export's position object.
 *
 * odometer (field 4) is decoded by cm_pb_fields and then dropped: CapMetro does not publish it
 * and nothing here reads it.
 */
function cm_pb_position(string $bytes): ?array
{
    $f = cm_pb_fields($bytes);
    if ($f === null) {
        return null;
    }

    $out = [];
    cm_pb_put($out, 'latitude', cm_pb_float(cm_pb_scalar($f, 1)));
    cm_pb_put($out, 'longitude', cm_pb_float(cm_pb_scalar($f, 2)));
    cm_pb_put($out, 'bearing', cm_pb_float(cm_pb_scalar($f, 3)));
    cm_pb_put($out, 'speed', cm_pb_float(cm_pb_scalar($f, 5)));

    return $out;
}

/* VehicleDescriptor -> the JSON export's nested vehicle object. */
function cm_pb_vehicle_descriptor(string $bytes): ?array
{
    $f = cm_pb_fields($bytes);
    if ($f === null) {
        return null;
    }

    $out = [];
    if (!cm_pb_put_string($out, 'id', cm_pb_scalar($f, 1))
        || !cm_pb_put_string($out, 'label', cm_pb_scalar($f, 2))
        || !cm_pb_put_string($out, 'licensePlate', cm_pb_scalar($f, 3))
    ) {
        return null;
    }

    return $out;
}

/*
 * VehiclePosition -> the JSON export's vehicle object.
 *
 * timestamp is emitted as a STRING because that is what the JSON export does. Downstream casts
 * it with (int); handing back an int here would work today and diverge the moment anything
 * compares the two sources field by field.
 *
 * A submessage that is present but does not decode fails the whole vehicle rather than being
 * dropped. A vehicle with no `trip` is not an error downstream, it is a deadhead — join.php
 * reads it as a bus running out of service — so quietly omitting an unparseable TripDescriptor
 * would turn a corrupt field into a confident, wrong statement about that bus. Failing the
 * vehicle is the honest outcome; cm_gtfsrt_decode() then fails the feed and the JSON is kept.
 */
function cm_pb_vehicle_position(string $bytes): ?array
{
    $f = cm_pb_fields($bytes);
    if ($f === null) {
        return null;
    }

    $out = [];

    $trip = cm_pb_scalar($f, 1);
    if (is_string($trip)) {
        $decoded = cm_pb_trip_descriptor($trip);
        if ($decoded === null) {
            return null;
        }
        cm_pb_put($out, 'trip', $decoded);
    }

    $position = cm_pb_scalar($f, 2);
    if (is_string($position)) {
        $decoded = cm_pb_position($position);
        if ($decoded === null) {
            return null;
        }
        cm_pb_put($out, 'position', $decoded);
    }

    cm_pb_put($out, 'currentStopSequence', cm_pb_int(cm_pb_scalar($f, 3)));
    cm_pb_put($out, 'currentStatus', cm_pb_enum(
        cm_pb_scalar($f, 4),
        CM_PB_VEHICLE_STOP_STATUS
    ));

    $ts = cm_pb_scalar($f, 5);
    cm_pb_put($out, 'timestamp', is_int($ts) ? (string) $ts : null);

    if (!cm_pb_put_string($out, 'stopId', cm_pb_scalar($f, 7))) {
        return null;
    }

    $vehicle = cm_pb_scalar($f, 8);
    if (is_string($vehicle)) {
        $decoded = cm_pb_vehicle_descriptor($vehicle);
        if ($decoded === null) {
            return null;
        }
        cm_pb_put($out, 'vehicle', $decoded);
    }

    return $out;
}

/*
 * Decode a FeedMessage into the shape the Socrata JSON export produces.
 *
 * Returns ['header' => [...], 'entity' => [...]] or null when the bytes are not a decodable
 * FeedMessage. Entities carrying anything other than a VehiclePosition are dropped, so a feed
 * of trip updates decodes to an empty entity list rather than to an error: that is a feed we
 * have no use for, not a corrupt one.
 */
function cm_gtfsrt_decode(string $bytes): ?array
{
    if ($bytes === '') {
        return null;
    }

    $f = cm_pb_fields($bytes);
    if ($f === null) {
        return null;
    }

    $header_bytes = cm_pb_scalar($f, 1);
    if (!is_string($header_bytes)) {
        return null;
    }
    $hf = cm_pb_fields($header_bytes);
    if ($hf === null) {
        return null;
    }

    $header = [];
    cm_pb_put($header, 'gtfsRealtimeVersion', cm_pb_string(cm_pb_scalar($hf, 1)));
    cm_pb_put($header, 'incrementality', cm_pb_enum(
        cm_pb_scalar($hf, 2),
        CM_PB_INCREMENTALITY
    ));
    $header_ts = cm_pb_scalar($hf, 3);
    cm_pb_put($header, 'timestamp', is_int($header_ts) ? (string) $header_ts : null);

    /*
     * A vehicle that will not decode is dropped, not fatal to the feed. One corrupt field in
     * one of 413 buses should cost that bus, not the rescue: failing the whole feed would hand
     * the board back four-hour-old data over a single bad byte. A dropped bus is simply absent,
     * which the board already knows how to mean; the thing that must never happen is a bus
     * present with a hole in it, and the message decoders above return null rather than do that.
     *
     * The floor is what keeps "drop the bad ones" from becoming "publish whatever survived". A
     * handful of failures is field corruption. Most of them failing means we are reading the
     * message wrongly, and a confident partial fleet is worse than no fallback at all, so the
     * feed loses and the stale JSON is kept.
     */
    $entities = [];
    $failed   = 0;
    foreach (($f[2] ?? []) as $entity_bytes) {
        if (!is_string($entity_bytes)) {
            $failed++;
            continue;
        }
        $ef = cm_pb_fields($entity_bytes);
        if ($ef === null) {
            $failed++;
            continue;
        }

        $vp = cm_pb_scalar($ef, 4);
        if (!is_string($vp)) {
            /* A TripUpdate or Alert entity. Not ours, and not a failure. */
            continue;
        }
        $vehicle = cm_pb_vehicle_position($vp);
        if ($vehicle === null) {
            $failed++;
            continue;
        }

        $entity = [];
        if (!cm_pb_put_string($entity, 'id', cm_pb_scalar($ef, 1))) {
            $failed++;
            continue;
        }
        $entity['vehicle'] = $vehicle;
        $entities[] = $entity;
    }

    if ($failed > count($entities)) {
        return null;
    }

    return ['header' => $header, 'entity' => $entities];
}
