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
 * be surface with no caller.
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
                if ($v === null) {
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
                if ($v === null) {
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
 */
function cm_pb_enum(?int $value, array $map)
{
    if ($value === null) {
        return null;
    }

    return $map[$value] ?? $value;
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
    cm_pb_put($out, 'tripId', cm_pb_scalar($f, 1));
    cm_pb_put($out, 'startTime', cm_pb_scalar($f, 2));
    cm_pb_put($out, 'startDate', cm_pb_scalar($f, 3));
    cm_pb_put($out, 'scheduleRelationship', cm_pb_enum(
        cm_pb_scalar($f, 4),
        CM_PB_TRIP_SCHEDULE_RELATIONSHIP
    ));
    cm_pb_put($out, 'routeId', cm_pb_scalar($f, 5));
    cm_pb_put($out, 'directionId', cm_pb_scalar($f, 6));

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
    cm_pb_put($out, 'latitude', cm_pb_scalar($f, 1));
    cm_pb_put($out, 'longitude', cm_pb_scalar($f, 2));
    cm_pb_put($out, 'bearing', cm_pb_scalar($f, 3));
    cm_pb_put($out, 'speed', cm_pb_scalar($f, 5));

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
    cm_pb_put($out, 'id', cm_pb_scalar($f, 1));
    cm_pb_put($out, 'label', cm_pb_scalar($f, 2));
    cm_pb_put($out, 'licensePlate', cm_pb_scalar($f, 3));

    return $out;
}

/*
 * VehiclePosition -> the JSON export's vehicle object.
 *
 * timestamp is emitted as a STRING because that is what the JSON export does. Downstream casts
 * it with (int); handing back an int here would work today and diverge the moment anything
 * compares the two sources field by field.
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
        cm_pb_put($out, 'trip', cm_pb_trip_descriptor($trip));
    }

    $position = cm_pb_scalar($f, 2);
    if (is_string($position)) {
        cm_pb_put($out, 'position', cm_pb_position($position));
    }

    cm_pb_put($out, 'currentStopSequence', cm_pb_scalar($f, 3));
    cm_pb_put($out, 'currentStatus', cm_pb_enum(
        cm_pb_scalar($f, 4),
        CM_PB_VEHICLE_STOP_STATUS
    ));

    $ts = cm_pb_scalar($f, 5);
    cm_pb_put($out, 'timestamp', $ts === null ? null : (string) $ts);

    cm_pb_put($out, 'stopId', cm_pb_scalar($f, 7));

    $vehicle = cm_pb_scalar($f, 8);
    if (is_string($vehicle)) {
        cm_pb_put($out, 'vehicle', cm_pb_vehicle_descriptor($vehicle));
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
    cm_pb_put($header, 'gtfsRealtimeVersion', cm_pb_scalar($hf, 1));
    cm_pb_put($header, 'incrementality', cm_pb_enum(
        cm_pb_scalar($hf, 2),
        CM_PB_INCREMENTALITY
    ));
    $header_ts = cm_pb_scalar($hf, 3);
    cm_pb_put($header, 'timestamp', $header_ts === null ? null : (string) $header_ts);

    $entities = [];
    foreach (($f[2] ?? []) as $entity_bytes) {
        if (!is_string($entity_bytes)) {
            continue;
        }
        $ef = cm_pb_fields($entity_bytes);
        if ($ef === null) {
            return null;
        }

        $vp = cm_pb_scalar($ef, 4);
        if (!is_string($vp)) {
            continue;
        }
        $vehicle = cm_pb_vehicle_position($vp);
        if ($vehicle === null) {
            return null;
        }

        $entity = [];
        cm_pb_put($entity, 'id', cm_pb_scalar($ef, 1));
        $entity['vehicle'] = $vehicle;
        $entities[] = $entity;
    }

    return ['header' => $header, 'entity' => $entities];
}
