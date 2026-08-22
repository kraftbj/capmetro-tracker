<?php
/*
 * Schedule shard reader.
 *
 * The Linode never parses GTFS. Shards are built by build/ (node-gtfs, GitHub Actions) and
 * committed to data/; this module only reads them. Layout, per build/NOTES.md:
 *
 *   data/manifest.json                  feed version, built_at, per-route index
 *   data/calendar.json                  service date -> service ids, exception flags
 *   data/stops.json                     stop_id -> shortened + full name, lat, lon
 *   data/routes/<dir>/schedule.json     every trip's stop times, interned and compact
 *   data/routes/<dir>/patterns.json     pattern classification, per-service baselines
 *   data/routes/<dir>/blocks.json       block chains and continuation grades
 *   data/routes/<dir>/timepoints.json   one ladder per distinct baseline
 *   data/routes/<dir>/calendar.json     this route's service dates
 *
 * Two things about that layout drive the shape of this file.
 *
 * First, baselines are per service date. Route 4 direction 0 runs a 17-stop baseline on
 * five services and a 19-stop one on three others, so "the baseline" is only meaningful
 * once today's service is known. Pattern deltas are therefore keyed by baseline pattern id
 * and there is deliberately no top-level adds/skips to grab by accident.
 *
 * Second, schedule.json is by far the largest file (410 KB on route 4, 1.3 MB on route 10)
 * and is the only one a route without a bus does not need. It is loaded separately by
 * cm_shard_times() so a run pays for it only where it is used, and the caller frees each
 * route before loading the next.
 */

require_once __DIR__ . '/servicetime.php';
require_once __DIR__ . '/stopnames.php';

function cm_shard_read(string $path): ?array
{
    if (!is_file($path)) {
        return null;
    }
    $raw = file_get_contents($path);
    if ($raw === false) {
        return null;
    }
    $doc = json_decode($raw, true);
    return is_array($doc) ? $doc : null;
}

/*
 * The manifest, calendar and stop table, merged into one index.
 *
 * Memoized per directory: generate-api.php would otherwise re-read a 200 KB stop table
 * once per route. The memo is a read cache of immutable build output, so it changes
 * nothing observable; pass $fresh to bypass it.
 */
function cm_shard_index(string $dir, bool $fresh = false): ?array
{
    static $memo = [];
    $dir = rtrim($dir, '/');
    if (!$fresh && isset($memo[$dir])) {
        return $memo[$dir];
    }

    $manifest = cm_shard_read($dir . '/manifest.json');
    if ($manifest === null) {
        return null;
    }
    $calendar = cm_shard_read($dir . '/calendar.json') ?? ['dates' => []];
    $stops_doc = cm_shard_read($dir . '/stops.json') ?? ['stops' => []];

    $routes = [];
    foreach ($manifest['routes'] ?? [] as $r) {
        $rid = (string) ($r['route_id'] ?? '');
        if ($rid === '') {
            continue;
        }
        $directions = [];
        foreach ($r['directions'] ?? [] as $d) {
            $directions[] = ['id' => (int) $d['id'], 'headsign' => $d['headsign'] ?? null];
        }
        usort($directions, static fn($a, $b) => $a['id'] <=> $b['id']);
        $routes[$rid] = [
            'short_name' => (string) ($r['short_name'] ?? $rid),
            'long_name'  => (string) ($r['long_name'] ?? ''),
            /* Route directory names are escaped by the build; the manifest records the
               mapping. No escaping is needed for the current feed, but relying on that
               would break silently on a route id with a slash in it. */
            'dir'        => (string) ($r['dir'] ?? $rid),
            'directions' => $directions === [] ? [['id' => 0, 'headsign' => null]] : $directions,
        ];
    }

    /*
     * Shortened names are re-derived here from the full upstream name rather than taken from
     * the build's stop_name. Section 7 then has exactly one implementation, in
     * cm_shorten_stop_name(), and a rule added to the contract takes effect on the next cron
     * run instead of waiting for a shard rebuild. The transform is deterministic, so when
     * both sides implement the same rules the two strings are identical.
     */
    $stops = [];
    foreach ($stops_doc['stops'] ?? [] as $sid => $s) {
        $full = (string) ($s['stop_name_full'] ?? ($s['stop_name'] ?? $sid));
        $stops[(string) $sid] = [
            'name'      => cm_shorten_stop_name($full),
            'name_full' => $full,
            'lat'       => (float) ($s['lat'] ?? 0),
            'lon'       => (float) ($s['lon'] ?? 0),
        ];
    }

    $index = [
        'schema'          => 1,
        'feed_version'    => (string) ($manifest['feed_version'] ?? 'unknown'),
        'built_at'        => (int) ($manifest['built_at'] ?? 0),
        'feed_start_date' => (string) ($manifest['feed_start_date'] ?? ''),
        'feed_end_date'   => (string) ($manifest['feed_end_date'] ?? ''),
        'routes'          => $routes,
        'calendar'        => $calendar['dates'] ?? [],
        'stops'           => $stops,
    ];
    $memo[$dir] = $index;
    return $index;
}

/*
 * Service ids running on a GTFS date, as a set. The feed ships no calendar.txt; every
 * service is expressed through calendar_dates, which the build has already collapsed into
 * a date -> service ids map.
 */
function cm_shard_active_services(?array $index, string $service_date): array
{
    $out = [];
    foreach ($index['calendar'][$service_date]['service_ids'] ?? [] as $sid) {
        $out[(string) $sid] = true;
    }
    return $out;
}

/*
 * True when any service active that date runs on exactly one date, per contract section 1.
 * 8 of the 145 dates in this feed qualify, which is why the fixtures were captured on one.
 */
function cm_shard_is_exception_day(?array $index, string $service_date): bool
{
    return (bool) ($index['calendar'][$service_date]['is_exception_day'] ?? false);
}

/*
 * Everything about a route except its stop times. Roughly 340 KB on route 4.
 *
 * Returns null when the route has no shard. $index supplies the stop table and the route
 * directory name; it is loaded if not passed.
 */

/*
 * The successor's trip id for the service variants running today.
 *
 * next_trip carries the facts once -- direction, time, stop -- because across this feed they
 * never vary by date, and trip_id_by_service carries the identifier, which does: CapMetro
 * mints the same physical run once per service variant, so the trip a rider will board has a
 * different id on a Monday than on a Friday. Publishing one of them unconditionally names the
 * right bus on one weekday in five.
 *
 * With no active services (no date, or a date the calendar does not cover) the scalar stands.
 * That is the honest fallback: the run is right and only the identifier is unresolved.
 */
function cm_shard_next_trip($next, array $active_services): ?array
{
    if (!is_array($next)) {
        return null;
    }
    $by_service = $next['trip_id_by_service'] ?? null;
    if (is_array($by_service) && $active_services !== []) {
        foreach ($by_service as $sid => $tid) {
            if (isset($active_services[(string) $sid])) {
                $next['trip_id'] = (string) $tid;
                break;
            }
        }
    }
    unset($next['trip_id_by_service']);
    return $next;
}

function cm_shard_route(string $dir, string $route_id, ?array $index = null, ?string $service_date = null): ?array
{
    $dir = rtrim($dir, '/');
    $index ??= cm_shard_index($dir);
    $meta = $index['routes'][$route_id] ?? null;
    $base = $dir . '/routes/' . ($meta['dir'] ?? $route_id);

    $patterns_doc = cm_shard_read($base . '/patterns.json');
    if ($patterns_doc === null) {
        return null;
    }
    $blocks_doc = cm_shard_read($base . '/blocks.json') ?? ['trips' => []];
    $tp_doc     = cm_shard_read($base . '/timepoints.json') ?? ['directions' => []];
    $cal_doc    = cm_shard_read($base . '/calendar.json') ?? ['dates' => [], 'service_ids' => []];

    /*
     * Which services run on the date being generated.
     *
     * A service_id in this feed is not a service day: calendar_dates puts SEVERAL on one
     * date, and CapMetro splits a physical block across them by direction. The build chains
     * a block per co-active set and mints the successor's id once per service variant, so
     * picking the right one needs to know which variants are running today. Without a date
     * the first id stands, which is what a caller with no calendar can honestly say.
     */
    $active_services = [];
    if ($service_date !== null) {
        foreach ($cal_doc['dates'][$service_date]['service_ids'] ?? [] as $sid) {
            $active_services[(string) $sid] = true;
        }
    }

    $patterns = [];
    $baseline_by_service = [];
    $baseline_default = [];
    foreach ($patterns_doc['directions'] ?? [] as $d) {
        $dir_key = (string) $d['direction_id'];
        $baseline_default[$dir_key] = (string) ($d['baseline_pattern_id'] ?? '');
        foreach ($d['baseline_by_service'] ?? [] as $sid => $pid) {
            $baseline_by_service[$dir_key][(string) $sid] = (string) $pid;
        }
        foreach ($d['patterns'] ?? [] as $p) {
            $patterns[(string) $p['pattern_id']] = $p;
        }
    }

    $ladders = [];
    foreach ($tp_doc['directions'] ?? [] as $d) {
        $ladders[(string) $d['direction_id']] = $d['ladders'] ?? [];
    }

    /*
     * A trip index that does not need schedule.json: blocks.json names every trip with its
     * service and continuation, and patterns.json names every trip's pattern. Headsign and
     * start time do need schedule.json and are picked up in the join.
     */
    $trips = [];
    foreach ($blocks_doc['trips'] ?? [] as $tid => $b) {
        $trips[(string) $tid] = [
            'service_id'       => (string) ($b['service_id'] ?? ''),
            'block_id'         => $b['block_id'] ?? null,
            'block_confidence' => (string) ($b['confidence'] ?? 'low'),
            'next_trip'        => cm_shard_next_trip($b['next_trip'] ?? null, $active_services),
            /*
             * The successor's route, as the build resolved it. A block that interlines puts
             * its next trip on a different route_id, and that route is a fact about the
             * successor, not about the bus reading this record -- so it is carried here
             * rather than re-derived from the current route downstream.
             */
            'next_route_id'    => isset($b['next_route_id']) && $b['next_route_id'] !== null
                ? (string) $b['next_route_id']
                : null,
            /*
             * Kept for one reason: "last_trip_of_block" is the build stating that this trip
             * ENDS the block. Without it a null next_trip is ambiguous between "pulling in"
             * and "we could not resolve a successor". See cm_trip_is_last_of_block().
             */
            'grade_reasons'    => array_map('strval', $b['grade_reasons'] ?? []),
            'pattern'          => null,
            'direction_id'     => 0,
        ];
    }
    foreach ($patterns as $pid => $p) {
        foreach ($p['trip_ids'] ?? [] as $tid) {
            $tid = (string) $tid;
            if (!isset($trips[$tid])) {
                $trips[$tid] = [
                    'service_id' => '', 'block_id' => null, 'block_confidence' => 'low',
                    'next_trip' => null, 'next_route_id' => null, 'grade_reasons' => [],
                    'pattern' => null, 'direction_id' => 0,
                ];
            }
            $trips[$tid]['pattern'] = (string) $pid;
            $trips[$tid]['direction_id'] = (int) $p['direction_id'];
        }
    }

    /*
     * The block table, minus its chains.
     *
     * blocks.json already states which routes a block covers and whether that set is
     * larger than one; recomputing either from the trip list would be a second definition
     * of the same fact, and ISSUE-002 is what two definitions of one fact cost. The chains
     * are dropped because nothing in the runtime reads them and they are the bulk of the
     * file -- block 1010 alone lists 92 trip ids across six services.
     */
    $blocks = [];
    foreach ($blocks_doc['blocks'] ?? [] as $bid => $b) {
        $route_ids = array_values(array_unique(array_map('strval', $b['route_ids'] ?? [])));
        /* Natural order so 4 sorts before 10 rather than after it; every current route id
           is numeric, but the comparison must not depend on that staying true. */
        sort($route_ids, SORT_NATURAL);
        $blocks[(string) $bid] = [
            'route_ids'    => $route_ids,
            'spans_routes' => (bool) ($b['spans_routes'] ?? (count($route_ids) > 1)),
            'trip_count'   => (int) ($b['trip_count'] ?? 0),
        ];
    }

    /*
     * route_id -> short name for EVERY route in the feed, not just this one. A block that
     * interlines names a successor on another route, and the join has only this shard in
     * hand when it has to render "becomes the 485". 71 short strings.
     */
    $route_short_names = [];
    foreach ($index['routes'] ?? [] as $other_id => $other) {
        $route_short_names[(string) $other_id] = (string) ($other['short_name'] ?? $other_id);
    }

    return [
        'route_id'            => $route_id,
        'route'               => [
            'id'         => $route_id,
            'short_name' => (string) ($meta['short_name'] ?? $route_id),
            'long_name'  => (string) ($meta['long_name'] ?? ''),
            'directions' => $meta['directions'] ?? [['id' => 0, 'headsign' => null]],
        ],
        'stops'               => $index['stops'] ?? [],
        'patterns'            => $patterns,
        'baseline_by_service' => $baseline_by_service,
        'baseline_pattern_id' => $baseline_default,
        'ladders'             => $ladders,
        'trips'               => $trips,
        'blocks'              => $blocks,
        'route_short_names'   => $route_short_names,
        'calendar'            => $cal_doc['dates'] ?? [],
        'service_ids'         => array_map('strval', $cal_doc['service_ids'] ?? []),
    ];
}

/*
 * What the shard says about one block: the whole route set it covers, whether that set is
 * larger than one route, and how many trips it holds.
 *
 * This exists so the contract's section 4 downgrade is explainable. A block whose trips
 * span more than one route_id is graded `low`, and until now the payload carried the grade
 * without the reason, leaving a client to either hedge every continuation or invent an
 * explanation. The answer is already in blocks.json; it just was not being read.
 *
 * Returns null for an unknown or missing block, which is the only honest answer: an empty
 * route set would read as "this block covers no routes" rather than "we do not know".
 */
function cm_shard_block(?array $route_shard, ?string $block_id): ?array
{
    if ($route_shard === null || $block_id === null || $block_id === '') {
        return null;
    }
    $block = $route_shard['blocks'][$block_id] ?? null;
    return is_array($block) ? $block : null;
}

/*
 * The short name of any route in the feed, not only this shard's own.
 *
 * Falls back to the id, matching cm_shard_index(): a route with no short name still needs
 * something to render, and the id is what riders see on the front of the bus anyway.
 * Returns null only when there is no route to name at all.
 */
function cm_shard_route_short_name(?array $route_shard, ?string $route_id): ?string
{
    if ($route_id === null || $route_id === '') {
        return null;
    }
    return (string) ($route_shard['route_short_names'][$route_id] ?? $route_id);
}

/*
 * Does this trip END its block?
 *
 * Deliberately not `next_trip === null`. Those two statements differ: "the bus is pulling
 * in" is a fact the build asserts by grading the trip `last_trip_of_block`, while a null
 * successor could equally mean the continuation could not be resolved. Today the build
 * only ever emits a null successor together with that reason -- all 2,115 of them across
 * the 71 shards -- but reading the assertion rather than the absence is what keeps the two
 * distinguishable if that ever stops being true.
 *
 * A trip that is not in the shard at all is therefore NOT last: we know nothing about it.
 */
function cm_trip_is_last_of_block(?array $shard_trip): bool
{
    if ($shard_trip === null) {
        return false;
    }
    return in_array('last_trip_of_block', $shard_trip['grade_reasons'] ?? [], true);
}

/*
 * A route's stop times: schedule.json as emitted, with `stop_ids` as the interning table
 * and each trip's `stops` an array of [stop_sequence, stop_index, arrival_s, timepoint].
 * Times are integer seconds after service-day midnight, so 25:10:00 needs no special case.
 */
function cm_shard_times(string $dir, string $route_id, ?array $index = null): ?array
{
    $dir = rtrim($dir, '/');
    $index ??= cm_shard_index($dir);
    $route_dir = (string) ($index['routes'][$route_id]['dir'] ?? $route_id);
    return cm_shard_read($dir . '/routes/' . $route_dir . '/schedule.json');
}

/*
 * The baseline pattern in force for a direction on a given service.
 * Falls back to the feed-wide default when the service is unknown to the shard.
 */
function cm_shard_baseline_pattern(array $route_shard, int $direction_id, string $service_id): ?string
{
    $dir = (string) $direction_id;
    $pid = $route_shard['baseline_by_service'][$dir][$service_id]
        ?? $route_shard['baseline_pattern_id'][$dir]
        ?? null;
    return $pid === null || $pid === '' ? null : (string) $pid;
}

/*
 * Is this trip's pattern a special run TODAY?
 *
 * "Special" is not a property of a pattern on its own. The Austin High run is special on
 * the days a normal pattern is in force and is the ordinary service on the days it is
 * itself the baseline, so the answer depends on which baseline the trip's own service_id
 * puts in force. This is the single definition of that rule: the vehicle join (§2
 * pattern.is_special) and the departures document (§15 trips[].is_special) both call it,
 * so the two can never drift into disagreeing about the same trip.
 *
 * Returns false when the pattern is unknown, which is the least-committal answer: an
 * unclassifiable trip is not evidence of a special run.
 */
function cm_trip_is_special(
    array $route_shard,
    ?string $pattern_id,
    int $direction_id,
    string $service_id
): bool {
    if ($pattern_id === null || $pattern_id === '') {
        return false;
    }
    $pattern = $route_shard['patterns'][$pattern_id] ?? null;
    if ($pattern === null) {
        return false;
    }
    $baseline_id = cm_shard_baseline_pattern($route_shard, $direction_id, $service_id);
    if ($baseline_id !== null && $baseline_id === $pattern_id) {
        return false;
    }
    return (bool) ($pattern['is_special'] ?? false);
}

/*
 * The scheduled-arrival map for one trip: stop_sequence => [stop_id, stop_name,
 * scheduled_at]. This is the right-hand side of the lateness subtraction.
 *
 * Only arrival_time is stored upstream, which is correct for this contract: adherence
 * compares against arrival and arrival wins wherever both exist.
 * Returns [] when the trip is absent, which the decision table reads as
 * trip_not_in_schedule.
 */
function cm_shard_scheduled_map(
    array $route_shard,
    ?array $times,
    string $trip_id,
    string $service_date
): array {
    $trip = $times['trips'][$trip_id] ?? null;
    if (!is_array($trip) || !is_array($trip['stops'] ?? null)) {
        return [];
    }
    $midnight = cm_service_day_midnight($service_date);
    if ($midnight === null) {
        return [];
    }
    $table = $times['stop_ids'] ?? [];
    $stops = $route_shard['stops'] ?? [];
    $out = [];
    foreach ($trip['stops'] as $row) {
        [$seq, $idx, $arrival_s] = [(int) $row[0], (int) $row[1], $row[2]];
        if ($arrival_s === null || !isset($table[$idx])) {
            continue;
        }
        $sid = (string) $table[$idx];
        $out[$seq] = [
            'stop_id'      => $sid,
            'stop_name'    => (string) ($stops[$sid]['name'] ?? $sid),
            'scheduled_at' => $midnight + (int) $arrival_s,
        ];
    }
    return $out;
}

/*
 * Silent failure 1: shards stale after a GTFS reset.
 *
 * CapMetro republishes roughly three times a year and every trip id changes. If the shard
 * build stops running, the shards still parse and the join still completes -- every bus
 * just reports adherence unknown, forever, with nothing thrown and nothing logged. The
 * only thing that catches it is the rate at which live trip ids fail to resolve, so the
 * rate is measured and health.json alarms on it.
 *
 * Returns 0.0 when there are no live trips to resolve; an empty road is not a failure.
 */
const CM_UNMATCHED_TRIP_ALARM = 0.20;

function cm_unmatched_trip_rate(array $route_shard, array $live_trip_ids): float
{
    $trips = $route_shard['trips'] ?? [];
    $total = 0;
    $unmatched = 0;
    foreach ($live_trip_ids as $tid) {
        $total++;
        if (!isset($trips[(string) $tid])) {
            $unmatched++;
        }
    }
    return $total === 0 ? 0.0 : $unmatched / $total;
}
