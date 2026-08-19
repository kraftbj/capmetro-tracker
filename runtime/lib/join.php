<?php
/*
 * The join: realtime feeds x schedule shards -> the contract's Vehicle and Timepoint
 * objects.
 *
 * Every function here is pure. The caller supplies already-parsed feed data, an
 * already-loaded shard, and the staleness decision; nothing in this file fetches, reads a
 * file, or calls time().
 */

require_once __DIR__ . '/servicetime.php';
require_once __DIR__ . '/adherence.php';
require_once __DIR__ . '/stopstatus.php';
require_once __DIR__ . '/shards.php';

/*
 * Index the trip updates feed by trip id.
 *
 * 912 entries in the 2026-08-19 capture, of which 100 are CANCELED with no stopTimeUpdate
 * at all and 683 carry a vehicle. The index is keyed on tripId because that is the only
 * field present on all of them.
 */
function cm_index_trip_updates($feed): array
{
    $out = [];
    foreach (($feed['entity'] ?? []) as $e) {
        $tu = $e['tripUpdate'] ?? null;
        if (!is_array($tu)) {
            continue;
        }
        $tid = $tu['trip']['tripId'] ?? null;
        if ($tid === null || $tid === '') {
            continue;
        }
        $out[(string) $tid] = $tu;
    }
    return $out;
}

/*
 * Count realtime SKIPPED events per stop id, restricted to the trips of one route.
 *
 * Counting window is section 3.1: the trips of the current service date present in the
 * live trip updates feed at generated_at. The number moves during the day on purpose.
 */
function cm_count_realtime_skips(array $trip_updates, ?string $route_id = null): array
{
    $counts = [];
    foreach ($trip_updates as $tu) {
        if ($route_id !== null && (string) ($tu['trip']['routeId'] ?? '') !== $route_id) {
            continue;
        }
        foreach (($tu['stopTimeUpdate'] ?? []) as $stu) {
            if (($stu['scheduleRelationship'] ?? '') !== 'SKIPPED') {
                continue;
            }
            $sid = $stu['stopId'] ?? null;
            if ($sid === null || $sid === '') {
                continue;
            }
            $counts[(string) $sid] = ($counts[(string) $sid] ?? 0) + 1;
        }
    }
    return $counts;
}

/*
 * Stop ids served by at least one pattern that has a trip in the live feed today, keyed by
 * direction. A baseline stop missing from this set is a pattern_skip: the schedule serves
 * it on the normal run, but nothing running today does.
 */
function cm_live_served_stops(array $trip_updates, array $route_shard): array
{
    $served = [];
    foreach ($trip_updates as $tid => $tu) {
        $trip = $route_shard['trips'][(string) $tid] ?? null;
        if ($trip === null || $trip['pattern'] === null) {
            continue;
        }
        $pattern = $route_shard['patterns'][$trip['pattern']] ?? null;
        if ($pattern === null) {
            continue;
        }
        $dir = (string) $trip['direction_id'];
        foreach ($pattern['stop_ids'] ?? [] as $sid) {
            $served[$dir][(string) $sid] = true;
        }
    }
    return $served;
}

/*
 * Project the shard's delta entries onto the contract's stopRef shape. The build already
 * emits {stop_id, stop_name}; this drops anything else so additionalProperties: false
 * cannot be violated by a future field.
 */
function cm_stop_refs(array $entries, array $stops): array
{
    $out = [];
    foreach ($entries as $e) {
        if (!is_array($e) || !isset($e['stop_id'])) {
            continue;
        }
        $sid = (string) $e['stop_id'];
        $out[] = [
            'stop_id'   => $sid,
            /* Names come from the stop table, never from the embedded copy, so every
               stop_name in the payload has been through the same section 7 transform. */
            'stop_name' => (string) ($stops[$sid]['name'] ?? ($e['stop_name'] ?? $sid)),
        ];
    }
    return $out;
}

/*
 * Build one Vehicle.
 *
 * $entity        one element of vehiclepositions.json entity[]
 * $route_shard   the shard for the vehicle's route, or null when it is a deadhead or the
 *                route has no shard
 * $times         that route's schedule.json, or null
 * $trip_update   the matching tripUpdate, or null
 * $suppress      staleness.suppress_adherence, authoritative
 * $short_name    route_short_name from the shard index, or null
 */
function cm_build_vehicle(
    array $entity,
    ?array $route_shard,
    ?array $times,
    ?array $trip_update,
    bool $suppress,
    ?string $short_name
): ?array {
    $v = $entity['vehicle'] ?? null;
    if (!is_array($v)) {
        return null;
    }
    $vid = (string) ($v['vehicle']['id'] ?? $entity['id'] ?? '');
    if ($vid === '') {
        return null;
    }
    $pos = $v['position'] ?? [];
    $trip = $v['trip'] ?? null;
    $trip_id = is_array($trip) ? (string) ($trip['tripId'] ?? '') : '';
    $in_service = $trip_id !== '';

    $out = [
        'vehicle_id'       => $vid,
        'label'            => isset($v['vehicle']['label']) ? (string) $v['vehicle']['label'] : null,
        /*
         * The schema requires route_id to be a string, and a deadhead has no route. The
         * empty string is the only in-type way to say "no route assigned"; in_service is
         * the field that actually carries the meaning. See runtime/NOTES.md.
         */
        'route_id'         => $in_service ? (string) ($trip['routeId'] ?? '') : '',
        'route_short_name' => $in_service ? $short_name : null,
        'position'         => [
            'lat'       => (float) ($pos['latitude'] ?? 0),
            'lon'       => (float) ($pos['longitude'] ?? 0),
            /* 208 of 392 vehicles report no bearing. Absent means unknown, so: null. */
            'bearing'   => isset($pos['bearing']) ? (float) $pos['bearing'] : null,
            'speed_mps' => isset($pos['speed']) ? max(0.0, (float) $pos['speed']) : null,
        ],
        'position_at'      => (int) ($v['timestamp'] ?? 0),
        'in_service'       => $in_service,
    ];

    if (!$in_service) {
        $out['adherence'] = cm_adherence_evaluate(['in_service' => false]);
        return $out;
    }

    /*
     * Per-trip time resolution uses the feed's own startDate, not our idea of today. A
     * trip that began before midnight is still on yesterday's service date and its clock
     * strings must resolve against yesterday's service-day midnight.
     */
    $service_date = (string) ($trip['startDate'] ?? '');
    $start_time = (string) ($trip['startTime'] ?? '');
    $shard_trip = $route_shard['trips'][$trip_id] ?? null;

    /*
     * Cancellations are published on the trip updates feed, not on the positions feed: in
     * the 2026-08-19 capture 100 of 912 trip updates are CANCELED and not one of the 249
     * vehicle trip descriptors is. Honouring only the positions descriptor would make row
     * 2 of the decision table dead code and compute lateness against canceled trips, so
     * the trip update wins and the emitted schedule_relationship says so too.
     */
    $relationship = (string) ($trip['scheduleRelationship'] ?? 'SCHEDULED');
    if (($trip_update['trip']['scheduleRelationship'] ?? null) === 'CANCELED') {
        $relationship = 'CANCELED';
    }

    $sched_trip = $times['trips'][$trip_id] ?? null;
    $start_epoch = cm_clock_to_epoch($start_time, $service_date);
    $out['trip'] = [
        'trip_id'               => $trip_id,
        'start_time'            => $start_time,
        'start_epoch'           => $start_epoch ?? 0,
        'direction_id'          => isset($trip['directionId'])
            ? (int) $trip['directionId']
            : (int) ($shard_trip['direction_id'] ?? 0),
        'headsign'              => $sched_trip['headsign'] ?? null,
        'schedule_relationship' => $relationship,
    ];

    $css = array_key_exists('currentStopSequence', $v) && $v['currentStopSequence'] !== null
        ? (int) $v['currentStopSequence']
        : null;
    $out['progress'] = [
        'current_stop_sequence' => $css,
        'current_stop_id'       => isset($v['stopId']) ? (string) $v['stopId'] : null,
        'current_status'        => isset($v['currentStatus']) ? (string) $v['currentStatus'] : null,
    ];

    $scheduled = ($route_shard !== null && $shard_trip !== null)
        ? cm_shard_scheduled_map($route_shard, $times, $trip_id, $service_date)
        : [];
    $service_id = (string) ($shard_trip['service_id'] ?? ($sched_trip['service_id'] ?? ''));

    $out['adherence'] = cm_adherence_evaluate([
        'in_service'            => true,
        'schedule_relationship' => $out['trip']['schedule_relationship'],
        'trip_update'           => $trip_update,
        'trip_in_schedule'      => $shard_trip !== null,
        'suppress_adherence'    => $suppress,
        'current_stop_sequence' => $css,
        'scheduled'             => $scheduled,
    ]);

    /*
     * pattern and block are required whenever in_service is true, so a trip missing from
     * the shard still gets both, in their least-committal form. The client reads
     * adherence.reason "trip_not_in_schedule" to know why they are empty.
     *
     * Which stops a pattern adds and skips depends on WHICH baseline is in force, and on
     * route 4 direction 0 that changes with the service date: five services run a 17-stop
     * baseline and three run a 19-stop one. The shard therefore keys its deltas by
     * baseline pattern id and publishes no top-level adds/skips, so the only way to get
     * this wrong is to look up the wrong baseline. Resolve it from the trip's own
     * service_id.
     */
    $pattern_id = $shard_trip['pattern'] ?? null;
    $pattern = ($route_shard !== null && $pattern_id !== null)
        ? ($route_shard['patterns'][$pattern_id] ?? null)
        : null;
    if ($pattern !== null) {
        $baseline_id = cm_shard_baseline_pattern(
            $route_shard,
            (int) $out['trip']['direction_id'],
            $service_id
        );
        $delta = $pattern['deltas'][$baseline_id] ?? ['adds' => [], 'skips' => []];
        $is_baseline = $baseline_id !== null && (string) $pattern_id === $baseline_id;
        $out['pattern'] = [
            'is_baseline'      => $is_baseline,
            /* A pattern the build calls special is still the normal run on the days it is
               the baseline, so is_special never fires on today's baseline. That rule lives
               in cm_trip_is_special() because the departures document (§15) publishes the
               same flag per trip and the two must not drift apart. */
            'is_special'       => cm_trip_is_special(
                $route_shard,
                (string) $pattern_id,
                (int) $out['trip']['direction_id'],
                $service_id
            ),
            /* Contract section 2: "how many trips share this stop signature today". */
            'trips_in_pattern' => max(1, (int) (
                $pattern['trips_by_service'][$service_id]
                ?? $pattern['trips_in_pattern']
                ?? 1
            )),
            'adds'             => cm_stop_refs($delta['adds'] ?? [], $route_shard['stops'] ?? []),
            'skips'            => cm_stop_refs($delta['skips'] ?? [], $route_shard['stops'] ?? []),
        ];
    } else {
        $out['pattern'] = [
            'is_baseline'      => false,
            'is_special'       => false,
            'trips_in_pattern' => 1,
            'adds'             => [],
            'skips'            => [],
        ];
    }

    if ($shard_trip !== null) {
        $next = $shard_trip['next_trip'] ?? null;
        if (is_array($next)) {
            $next_epoch = cm_clock_to_epoch((string) $next['start_time'], $service_date);
            $next = [
                'trip_id'           => (string) $next['trip_id'],
                'direction_id'      => (int) $next['direction_id'],
                'start_time'        => (string) $next['start_time'],
                'start_epoch'       => $next_epoch ?? 0,
                'start_stop_id'     => (string) $next['start_stop_id'],
                'start_stop_name'   => (string) (
                    $route_shard['stops'][(string) $next['start_stop_id']]['name']
                    ?? $next['start_stop_name']
                ),
                'is_direction_flip' => (bool) $next['is_direction_flip'],
            ];
        } else {
            $next = null;
        }
        $out['block'] = [
            'block_id'   => $shard_trip['block_id'] ?? null,
            'confidence' => (string) ($shard_trip['block_confidence'] ?? 'low'),
            'next_trip'  => $next,
        ];
    } else {
        $out['block'] = ['block_id' => null, 'confidence' => 'low', 'next_trip' => null];
    }

    return $out;
}

/*
 * Merge the stop lists of the route's other patterns onto the ladder, preserving order.
 *
 * The ladder's rows come from the baseline, per contract section 3. Which stops appear at
 * all is a wider question: a stop only a variant serves still has to be on the ladder,
 * because on route 4 stops 1967 and 1971 exist only on a variant and both sit under an
 * active NO_SERVICE alert. A ladder built strictly from one pattern could never show that,
 * which the contract calls a correctness requirement rather than a nicety.
 *
 * Each entry is [stop_id, stop_sequence]. Extra stops are inserted immediately after the
 * last stop of their own pattern that the merged order already contains, and carry their
 * own pattern's GTFS sequence. A stop with no such predecessor -- one that runs BEFORE the
 * ladder's first row -- is dropped rather than promoted, so the emitted rows stay exactly
 * the baseline timepoints and their sequences stay the GTFS ones.
 */
function cm_merge_stop_order(array $ladder_stops, array $other_patterns): array
{
    $order = $ladder_stops;
    foreach ($other_patterns as $stops) {
        $pos = [];
        foreach ($order as $i => $entry) {
            $pos[$entry[0]] = $i;
        }
        $anchor = null;
        foreach ($stops as $i => $sid) {
            $sid = (string) $sid;
            if (isset($pos[$sid])) {
                $anchor = $pos[$sid];
                continue;
            }
            if ($anchor === null) {
                continue;
            }
            $at = $anchor + 1;
            array_splice($order, $at, 0, [[$sid, $i + 1]]);
            $pos = [];
            foreach ($order as $j => $entry) {
                $pos[$entry[0]] = $j;
            }
            $anchor = $at;
        }
    }
    return $order;
}

/*
 * Build the flat timepoint array for a route: BOTH directions in one array, each row
 * carrying its own direction_id. The client filters for the A / B / BOTH toggle, which is
 * why there is one fetch per route rather than one per direction.
 *
 * The ROWS are the ladder the build emitted for the baseline in force today, straight from
 * stop_times.timepoint = 1 per contract section 3. Which stops appear at all is a wider
 * question: a stop only a variant serves still has to be on the ladder, because on route 4
 * stops 1967 and 1971 exist only on a variant and both sit under an active NO_SERVICE
 * alert. A ladder built strictly from one pattern could never show that, which the
 * contract calls a correctness requirement rather than a nicety. So every other pattern on
 * the direction is merged into the stop order and its extra stops appear as minor stops.
 *
 * Consequence a client author needs to know: stop_sequence here is ladder ordering, not a
 * GTFS join key. It is monotonic within a direction and equals the GTFS stop_sequence
 * whenever today's patterns agree with the ladder's baseline, which is the common case.
 * Use adherence.against.stop_sequence when a real GTFS sequence is needed.
 */
function cm_build_timepoints(
    array $route_shard,
    array $active_services,
    array $realtime_skips,
    array $alert_closed_stops,
    array $live_served
): array {
    $status = static function (
        string $sid,
        string $dir
    ) use ($realtime_skips, $alert_closed_stops, $live_served): array {
        $pattern_skip = isset($live_served[$dir]) && !isset($live_served[$dir][$sid]);
        return cm_stop_service_status(
            (int) ($realtime_skips[$sid] ?? 0),
            isset($alert_closed_stops[$sid]),
            $pattern_skip,
            'Not served by any trip running today'
        );
    };
    $stops = $route_shard['stops'] ?? [];

    $rows = [];
    foreach ($route_shard['ladders'] ?? [] as $dir => $ladders) {
        $dir = (string) $dir;
        if (!is_array($ladders) || $ladders === []) {
            continue;
        }

        /*
         * Pick the ladder for the baseline in force today. Several services can run today
         * on one route; they agree on the baseline in every case in this feed, and the
         * first match is taken deterministically after sorting. Falling back to the
         * feed-wide default keeps a route with an unknown service from losing its ladder.
         */
        $service_ids = array_keys($active_services);
        sort($service_ids);
        $baseline_id = null;
        foreach ($service_ids as $sid) {
            $candidate = $route_shard['baseline_by_service'][$dir][$sid] ?? null;
            if ($candidate !== null && isset($ladders[$candidate])) {
                $baseline_id = (string) $candidate;
                break;
            }
        }
        if ($baseline_id === null) {
            $default = (string) ($route_shard['baseline_pattern_id'][$dir] ?? '');
            $baseline_id = isset($ladders[$default]) ? $default : (string) array_key_first($ladders);
        }
        $ladder = $ladders[$baseline_id] ?? null;
        if (!is_array($ladder)) {
            continue;
        }

        /* Flatten the ladder back to a stop order, remembering which stops are rows. */
        $order = [];
        $is_timepoint = [];
        foreach ($ladder['timepoints'] ?? [] as $tp) {
            $order[] = [(string) $tp['stop_id'], (int) $tp['stop_sequence']];
            $is_timepoint[(string) $tp['stop_id']] = true;
            foreach ($tp['minor_stops'] ?? [] as $ms) {
                $order[] = [(string) $ms['stop_id'], (int) $ms['stop_sequence']];
            }
        }
        if ($order === []) {
            continue;
        }

        /*
         * Merge in every other pattern on this direction, busiest first so the result is
         * stable across rebuilds.
         */
        $others = [];
        foreach ($route_shard['patterns'] ?? [] as $pid => $pat) {
            if ((string) $pid === $baseline_id || (string) $pat['direction_id'] !== $dir) {
                continue;
            }
            $others[(string) $pid] = $pat;
        }
        uasort($others, static fn($a, $b) => ($b['trips_in_pattern'] ?? 0) <=> ($a['trips_in_pattern'] ?? 0));
        $order = cm_merge_stop_order(
            $order,
            array_values(array_map(static fn($p) => $p['stop_ids'] ?? [], $others))
        );

        $current = null;
        foreach ($order as [$sid, $seq]) {
            $sid = (string) $sid;
            $stop = $stops[$sid] ?? null;
            if (isset($is_timepoint[$sid])) {
                if ($current !== null) {
                    $rows[] = $current;
                }
                $current = [
                    'stop_id'        => $sid,
                    'stop_name'      => (string) ($stop['name'] ?? $sid),
                    'stop_name_full' => (string) ($stop['name_full'] ?? ($stop['name'] ?? $sid)),
                    'stop_sequence'  => $seq,
                    'direction_id'   => (int) $dir,
                    'lat'            => (float) ($stop['lat'] ?? 0),
                    'lon'            => (float) ($stop['lon'] ?? 0),
                    'service_status' => $status($sid, $dir),
                    'minor_stops'    => [],
                ];
                continue;
            }
            if ($current === null) {
                continue;
            }
            $current['minor_stops'][] = [
                'stop_id'        => $sid,
                'stop_name'      => (string) ($stop['name'] ?? $sid),
                'stop_sequence'  => $seq,
                'lat'            => (float) ($stop['lat'] ?? 0),
                'lon'            => (float) ($stop['lon'] ?? 0),
                'service_status' => $status($sid, $dir),
            ];
        }
        if ($current !== null) {
            $rows[] = $current;
        }
    }

    usort($rows, static fn($a, $b) => $a['direction_id'] <=> $b['direction_id']
        ?: $a['stop_sequence'] <=> $b['stop_sequence']);

    return $rows;
}

/*
 * The windowed schedule block, and the route's next departure.
 *
 * The ladder shows where buses are; the schedule block is what lets the client draw the
 * scheduled diagonals behind them, so a bus that has fallen a whole headway behind reads as
 * such rather than as a number. It is windowed because a whole service day of trips is a
 * lot of rows to send every minute for a chart that shows an hour.
 *
 * Column order is taken from the emitted timepoints[] rows for that direction rather than
 * recomputed, so timepoint_stop_ids and the ladder can never drift apart.
 *
 * A trip is included when its scheduled span overlaps the window at all, not merely when
 * it starts inside it: a trip that began before the window is still drawing a diagonal
 * across it.
 */
const CM_SCHEDULE_BEFORE_S = 900;
const CM_SCHEDULE_AFTER_S = 2700;

function cm_build_schedule(
    ?array $times,
    array $timepoints,
    array $route_directions,
    array $active_services,
    array $trip_updates,
    string $service_date,
    int $now,
    int $before_s = CM_SCHEDULE_BEFORE_S,
    int $after_s = CM_SCHEDULE_AFTER_S
): array {
    $from = max(0, $now - $before_s);
    $until = $now + $after_s;
    $window = ['from' => $from, 'until' => $until, 'before_s' => $before_s, 'after_s' => $after_s];

    /*
     * Column order per direction, taken from the rows the client will render rather than
     * recomputed, so timepoint_stop_ids and the ladder can never drift apart. Every
     * direction the route runs gets an entry even when it has no timepoints and no trips,
     * so the client never has to tell "absent" from "nothing scheduled".
     */
    $columns = [];
    foreach ($route_directions as $d) {
        $columns[(string) $d['id']] = [];
    }
    foreach ($timepoints as $tp) {
        $columns[(string) $tp['direction_id']][] = (string) $tp['stop_id'];
    }

    $midnight = cm_service_day_midnight($service_date);
    $table = $times['stop_ids'] ?? [];
    $rows = [];
    $next_departure = null;

    foreach ($times['trips'] ?? [] as $tid => $trip) {
        if ($midnight === null || !is_array($trip['stops'] ?? null) || $trip['stops'] === []) {
            continue;
        }
        if (!isset($active_services[(string) ($trip['service_id'] ?? '')])) {
            continue;
        }
        $dir = (string) ($trip['direction_id'] ?? 0);

        $first = $trip['stops'][0];
        $last = $trip['stops'][count($trip['stops']) - 1];
        if ($first[2] === null || $last[2] === null) {
            continue;
        }
        $start_epoch = $midnight + (int) $first[2];
        $end_epoch = $midnight + (int) $last[2];

        /*
         * Next departure is over the whole service day, not the window, and skips anything
         * the agency has already canceled: a canceled departure is not a promise the board
         * should make. Ties break toward the lower direction_id, then the smallest trip id.
         */
        $canceled = (($trip_updates[(string) $tid]['trip']['scheduleRelationship'] ?? null) === 'CANCELED');
        if ($start_epoch > $now && !$canceled) {
            $candidate = [
                'scheduled_at' => $start_epoch,
                'stop_id'      => (string) ($table[(int) $first[1]] ?? ''),
                'direction_id' => (int) $dir,
                'headsign'     => $trip['headsign'] ?? null,
                'trip_id'      => (string) $tid,
            ];
            if (
                $next_departure === null
                || [$candidate['scheduled_at'], $candidate['direction_id'], $candidate['trip_id']]
                    < [$next_departure['scheduled_at'], $next_departure['direction_id'], $next_departure['trip_id']]
            ) {
                $next_departure = $candidate;
            }
        }

        if ($start_epoch > $until || $end_epoch < $from || !isset($columns[$dir]) || $columns[$dir] === []) {
            continue;
        }

        $by_stop = [];
        foreach ($trip['stops'] as $row) {
            $sid = (string) ($table[(int) $row[1]] ?? '');
            if ($sid !== '' && !isset($by_stop[$sid]) && $row[2] !== null) {
                $by_stop[$sid] = (int) $row[2];
            }
        }
        $offsets = [];
        $served = false;
        foreach ($columns[$dir] as $sid) {
            if (isset($by_stop[$sid])) {
                $offsets[] = $by_stop[$sid] - (int) $first[2];
                $served = true;
            } else {
                $offsets[] = null;
            }
        }
        /* A trip serving none of the columns is omitted, not carried as an all-null row. */
        if (!$served) {
            continue;
        }
        $rows[$dir][] = [(string) $tid, $start_epoch, $offsets];
    }

    $directions = [];
    foreach ($columns as $dir => $stop_ids) {
        $trips = $rows[$dir] ?? [];
        usort($trips, static fn($a, $b) => $a[1] <=> $b[1] ?: strcmp($a[0], $b[0]));
        $directions[] = [
            'direction_id'       => (int) $dir,
            'timepoint_stop_ids' => $stop_ids,
            'trips'              => $trips,
        ];
    }
    usort($directions, static fn($a, $b) => $a['direction_id'] <=> $b['direction_id']);

    return [
        'window'         => $window,
        'directions'     => $directions,
        'next_departure' => $next_departure,
    ];
}
