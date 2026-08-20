<?php
/*
 * The scheduled-departure board, api-contract.md section 16.
 *
 * Why this exists at all. A saved watch is the tuple (route, direction, stop, scheduled
 * time) -- "the 7:50a 800 SB from Simond/Berkman" -- and the client has to let a user pick
 * that time from a list before there is anything to watch. Nothing already published can
 * answer it:
 *
 *   route.schedule (§3.2) is windowed to generated_at -900 .. +2700 and is timepoint-only.
 *     At 6am it does not contain the 7:50, and stop 6293 Simond SB is a MINOR stop that
 *     never appears in it at any hour.
 *   route.timepoints (§3) is the ladder row set, not a list of times.
 *   route.next_departure (§1) is exactly one trip.
 *
 * So this document trades the two restrictions that keep §3.2 small -- the window and the
 * timepoint filter -- for the two properties a picker needs: every stop, and the whole
 * service day. It is a different document rather than a bigger route file precisely
 * because of that: the route file is re-fetched every 60 seconds and this one changes only
 * when the service date or the feed version does.
 *
 * Every function here is pure. The caller supplies an already-loaded shard and its
 * schedule.json; nothing in this file reads a file or calls time().
 */

require_once __DIR__ . '/servicetime.php';
require_once __DIR__ . '/shards.php';

/*
 * Today's trips on this route, in publication order.
 *
 * Only trips whose service_id is active for the service date survive. On route 800 for
 * 20260819 that is 196 of the 903 trips in the extract; publishing all 903 would be four
 * and a half times the bytes and every extra row would be a departure that does not
 * happen today, which is worse than useless on a picker.
 *
 * Order is scheduled start ascending, then trip_id, where the start is the arrival at the
 * trip's FIRST stop -- the same value §3.2 calls start_epoch and the same one
 * Vehicle.trip.start_epoch carries -- so a trip index is stable across two runs on the
 * same feed and a diff is readable.
 *
 * Returns a list of ['id' => trip_id, 'start_s' => int, 'trip' => the shard row].
 */
function cm_departure_trips(?array $times, array $active_services): array
{
    $selected = [];
    foreach (($times['trips'] ?? []) as $tid => $trip) {
        if (!is_array($trip)) {
            continue;
        }
        $service_id = (string) ($trip['service_id'] ?? '');
        if ($service_id === '' || !isset($active_services[$service_id])) {
            continue;
        }
        $stops = $trip['stops'] ?? null;
        if (!is_array($stops) || $stops === []) {
            continue;
        }
        /*
         * The first stop with a time, not literally stops[0]: a trip whose opening rows
         * carry a null arrival still starts somewhere, and a trip with no time at all is
         * not a departure anyone can catch and is dropped.
         */
        $start_s = null;
        foreach ($stops as $row) {
            if (isset($row[2]) && $row[2] !== null) {
                $start_s = (int) $row[2];
                break;
            }
        }
        if ($start_s === null) {
            continue;
        }
        $selected[] = ['id' => (string) $tid, 'start_s' => $start_s, 'trip' => $trip];
    }

    /* strcmp on the id, not <=>: PHP compares two numeric strings numerically, and a feed
       whose trip ids were all digits would leave equal-start trips in load order. */
    usort(
        $selected,
        static fn(array $a, array $b): int =>
            ($a['start_s'] <=> $b['start_s']) ?: strcmp($a['id'], $b['id'])
    );

    return $selected;
}

/*
 * The whole document for one route.
 *
 * $route_shard   cm_shard_route() output; supplies the stop table and the pattern
 *                classification is_special reads
 * $times         cm_shard_times() output, that route's schedule.json; null is a route with
 *                no stop times, which yields an empty but well-formed document
 * $active_services   cm_shard_active_services() for the service date, as a set
 * $service_date  the GTFS service date these times belong to
 * $feed_version  the shard feed version, so a client can tell a stale cached copy from a
 *                current one without diffing the payload
 * $now           generated_at
 *
 * Three shape decisions, each of which a client would otherwise have to guess at:
 *
 * 1. arrival_s is seconds since the START of the service day, never an epoch and never
 *    wrapped at 86400. A 25:10:00 arrival is 90600 and stays 90600. Wrapping it would
 *    silently sort the small hours to the top of the list and would make the last trip of
 *    the night look like the first of the morning. The client resolves it the same way
 *    everything else in this contract resolves a GTFS clock (§2), and the document carries
 *    service_date so it can.
 *
 * 2. stops carries one entry per (stop, direction). Two of route 800's stops serve both
 *    directions, and a single row could only name one of them, so a direction filter built
 *    on this document would quietly drop half a stop's service.
 *
 * 3. departures is keyed by stop_id ALONE, not by (stop, direction). A rider standing at a
 *    stop wants the departures from that stop; the direction is a property of the trip
 *    they pick, and trips[trip_index].direction_id gives it to them in one lookup with no
 *    second index and no duplicated arrival rows. Keying by the pair would have duplicated
 *    every arrival at those two shared stops into a key the client had to build by string
 *    concatenation.
 *
 * service_day_start_epoch and day_type are both published rather than left to the client
 * for the same reason: each is a timezone trap the server has already solved exactly once.
 * Service-day midnight is noon-in-America/Chicago minus twelve hours, which is the only
 * form that survives both DST transitions (cm_service_day_midnight explains why), and
 * "which day type is today" is cm_day_type's answer, the same one the watch tuple in §9 is
 * spelled with. Re-deriving either in a browser from a YYYYMMDD string is two chances to
 * be an hour wrong on two days a year, on a document whose whole purpose is telling a
 * parent when to be at a stop.
 *
 * Both are null only when $service_date is not a valid YYYYMMDD, which the cron job cannot
 * produce -- it passes cm_service_date_for()'s output. Null rather than a plausible-looking
 * 0 or "weekday" because §0 is explicit that 0 must never stand for unknown, and because a
 * wrong absolute time here is the one failure mode this endpoint exists to prevent.
 */
function cm_build_departures(
    array $route_shard,
    ?array $times,
    array $active_services,
    string $service_date,
    string $feed_version,
    int $now,
    array $canceled = []
): array {
    $selected = cm_departure_trips($times, $active_services);
    $table = $times['stop_ids'] ?? [];
    $stop_meta = $route_shard['stops'] ?? [];

    $trips = [];
    $departures = [];
    /* Per (stop, direction): how many of today's trips place it at each stop_sequence,
       and whether any of them calls it a timepoint. See the two blocks below. */
    $sequence_votes = [];
    $timepoint_at = [];

    foreach ($selected as $index => $s) {
        $trip = $s['trip'];
        $direction_id = (int) ($trip['direction_id'] ?? 0);

        $trips[] = [
            'id'           => $s['id'],
            'direction_id' => $direction_id,
            'headsign'     => isset($trip['headsign']) && $trip['headsign'] !== null
                ? (string) $trip['headsign']
                : null,
            'start_time'   => isset($trip['start_time']) && $trip['start_time'] !== null
                ? (string) $trip['start_time']
                : cm_seconds_to_clock($s['start_s']),
            'block_id'     => isset($trip['block_id']) && $trip['block_id'] !== null
                ? (string) $trip['block_id']
                : null,
            /* One definition of "special", shared with §2 pattern.is_special. */
            'is_special'   => cm_trip_is_special(
                $route_shard,
                isset($trip['pattern_id']) ? (string) $trip['pattern_id'] : null,
                $direction_id,
                (string) ($trip['service_id'] ?? '')
            ),
            /*
             * A canceled trip stays IN this document rather than being filtered
             * out of it. "The 5:40 is canceled" is a usable answer; a 5:40 that
             * silently does not exist looks like a gap in the timetable and
             * tells a reader standing at the stop nothing at all.
             */
            'canceled'     => isset($canceled[(string) $s['id']]),
        ];

        foreach ($trip['stops'] as $row) {
            if (!isset($row[2]) || $row[2] === null) {
                continue;
            }
            $stop_index = (int) ($row[1] ?? -1);
            if (!isset($table[$stop_index])) {
                continue;
            }
            $stop_id = (string) $table[$stop_index];
            $departures[$stop_id][] = [(int) $row[2], $index];

            $key = $stop_id . "\x1f" . $direction_id;
            $sequence = (int) ($row[0] ?? 0);
            $sequence_votes[$key][$sequence] = ($sequence_votes[$key][$sequence] ?? 0) + 1;
            $timepoint_at[$key] = ($timepoint_at[$key] ?? false) || ((int) ($row[3] ?? 0) === 1);
        }
    }

    foreach ($departures as $stop_id => $rows) {
        usort($rows, static fn(array $a, array $b): int => [$a[0], $a[1]] <=> [$b[0], $b[1]]);
        $departures[$stop_id] = $rows;
    }

    $stops = [];
    foreach ($sequence_votes as $key => $votes) {
        [$stop_id, $direction_id] = explode("\x1f", (string) $key, 2);
        $meta = $stop_meta[$stop_id] ?? null;
        $stops[] = [
            'stop_id'        => $stop_id,
            /* Names come from the shard's stop table, which has already been through
               cm_shorten_stop_name(). §7 has one implementation and this is not a second
               one. */
            'stop_name'      => (string) ($meta['name'] ?? $stop_id),
            'stop_name_full' => (string) ($meta['name_full'] ?? ($meta['name'] ?? $stop_id)),
            'direction_id'   => (int) $direction_id,
            'stop_sequence'  => cm_modal_stop_sequence($votes),
            'lat'            => (float) ($meta['lat'] ?? 0),
            'lon'            => (float) ($meta['lon'] ?? 0),
            /* A stop is a timepoint when ANY of today's trips treats it as one. GTFS
               marks the flag per stop_time, and a short-turn pattern that omits the
               timepoint would otherwise demote a stop the timetable prints in bold. */
            'is_timepoint'   => (bool) ($timepoint_at[$key] ?? false),
        ];
    }
    usort(
        $stops,
        static fn(array $a, array $b): int =>
            ($a['direction_id'] <=> $b['direction_id'])
            ?: (($a['stop_sequence'] <=> $b['stop_sequence'])
            ?: strcmp($a['stop_id'], $b['stop_id']))
    );

    return [
        'schema'                  => 1,
        'generated_at'            => $now,
        'route_id'                => (string) ($route_shard['route_id'] ?? ($route_shard['route']['id'] ?? '')),
        'service_date'            => $service_date,
        /* The anchor every arrival_s below is measured from. A client adds the two and has
           an absolute epoch it can compare against generated_at or a live prediction,
           without reimplementing noon-minus-12 in the browser. */
        'service_day_start_epoch' => cm_service_day_midnight($service_date),
        'day_type'                => cm_day_type($service_date),
        'feed_version'            => $feed_version,
        'stops'                   => $stops,
        'trips'                   => $trips,
        /*
         * Cast so the encoder cannot decide for itself. departures is a map keyed by stop
         * id; PHP turns "6293" into the integer key 6293 on the way in, and an empty map
         * or one whose keys happened to run 0,1,2 would encode as a JSON array. The schema
         * says object, and a route with no service today must still answer with {}.
         */
        'departures'              => (object) $departures,
    ];
}

/*
 * The stop_sequence to publish for a (stop, direction) pair.
 *
 * A stop does not have one sequence number: a short-turn or special pattern that starts
 * mid-route gives the same stop a much lower one. Taking the minimum would let a handful
 * of Austin-High-style runs reorder the whole list; taking the first seen would make the
 * answer depend on trip id ordering. The modal value -- the sequence the greatest number
 * of today's trips agree on -- is the ordinary run's answer by construction, and ties
 * break toward the lower sequence so the result is deterministic.
 *
 * The number is published for ordering and for display next to a stop, not as a key: a
 * departure is joined to its trip through the trip index, never through this.
 */
function cm_modal_stop_sequence(array $votes): int
{
    ksort($votes, SORT_NUMERIC);
    $best = 0;
    $best_count = -1;
    foreach ($votes as $sequence => $count) {
        if ($count > $best_count) {
            $best_count = $count;
            $best = (int) $sequence;
        }
    }
    return $best;
}
