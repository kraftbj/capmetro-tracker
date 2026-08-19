<?php
/*
 * ============================================================================
 *  generate-api.php -- the cron job. Fetch, join, write. One process, no daemon.
 * ============================================================================
 *
 * Runs every 60 seconds from cron on the Linode, joins three live CapMetro feeds against
 * pre-built GTFS schedule shards, and writes static JSON into the webroot. There is
 * nothing to keep warm and nothing to restart after a reboot: if a run dies, the previous
 * files are still being served and their staleness ages naturally until a run succeeds.
 *
 *   UPSTREAM (data.texas.gov, all Access-Control-Allow-Origin: *)
 *
 *     cuc7-ywmd  positions      ~120 KB   392 vehicles, 249 with a trip
 *     mqtr-wwpy  trip updates   ~1.85 MB uncompressed / 158 KB gzipped, 912 entries
 *     9zu9-jwr2  alerts         ~68 KB    104 alerts, bespoke Socrata array, carries PII
 *
 *   SHARDS (built elsewhere, see runtime/NOTES.md; the Linode never parses GTFS)
 *
 *     index.json            routes, calendar_dates index, feed version
 *     route-{id}.json       stops, patterns, timepoint ladder, trips, block chains
 *     route-{id}.times.json trip -> scheduled seconds, loaded only for routes with buses
 *
 *   FLOW
 *
 *     flock(cron.lock) ──────────────────────────────────────────────┐
 *       │                                                            │
 *       ├─ fetch positions ─┐  Accept-Encoding: gzip on all three.   │
 *       ├─ fetch trip upd. ─┤  No conditional requests: the feeds    │
 *       └─ fetch alerts ────┘  answer If-None-Match with a full 200. │
 *              │                                                     │
 *              ├─ any failure? ─> write health.json(errors), STOP.   │
 *              │                  Route files are left untouched.    │
 *              v                                                     │
 *        strip alert PII (allowlist)                                 │
 *        index trip updates by trip_id                               │
 *        compute staleness -> suppress_adherence (authoritative)     │
 *              │                                                     │
 *              v         per route, one at a time, shard freed after │
 *        ┌───────────────────────────────────────────────┐           │
 *        │ join positions x trip updates x shard         │           │
 *        │   lateness = predicted - scheduled            │           │
 *        │   adherence decision table (10 rows, ordered) │           │
 *        │   pattern adds/skips, block continuation      │           │
 *        │   timepoint ladder + stop service status      │           │
 *        │     realtime_skipped > alert_no_service       │           │
 *        │                      > pattern_skip           │           │
 *        └───────────────────────────────────────────────┘           │
 *              │                                                     │
 *              v  temp file in same dir -> fflush -> fsync -> rename  │
 *        /api/route/{id}.json   /api/all.json                        │
 *        /api/watch/{id}.json   /api/health.json                     │
 *       ────────────────────────────────────────────────────────────-┘
 *
 * Usage:
 *   php runtime/generate-api.php --config=/etc/capmetro/config.php
 *   php runtime/generate-api.php --fixtures=tests/fixtures/feeds-20260819 \
 *       --shards=.local/shards --out=.local/webroot          # offline, no network
 *
 * Flags (each overrides the config file):
 *   --config=FILE    PHP file returning the config array; see config.example.php
 *   --shards=DIR     shard directory
 *   --out=DIR        webroot; files land in DIR/api/...
 *   --fixtures=DIR   read the three feeds from disk instead of the network
 *   --now=EPOCH      pin the clock, for deterministic fixture runs and staleness tests
 *   --routes=a,b     restrict to these route ids
 *   --quiet          no progress on stderr
 */

declare(strict_types=1);

require_once __DIR__ . '/lib/servicetime.php';
require_once __DIR__ . '/lib/fetch.php';
require_once __DIR__ . '/lib/write.php';
require_once __DIR__ . '/lib/shards.php';
require_once __DIR__ . '/lib/alerts.php';
require_once __DIR__ . '/lib/staleness.php';
require_once __DIR__ . '/lib/adherence.php';
require_once __DIR__ . '/lib/stopstatus.php';
require_once __DIR__ . '/lib/join.php';
require_once __DIR__ . '/lib/watch.php';
require_once __DIR__ . '/lib/health.php';

function cm_cli_args(array $argv): array
{
    $out = [];
    foreach (array_slice($argv, 1) as $a) {
        if (preg_match('/^--([a-z0-9\-]+)(?:=(.*))?$/i', $a, $m) === 1) {
            $out[$m[1]] = $m[2] ?? true;
        }
    }
    return $out;
}

$args = cm_cli_args($argv);
$quiet = isset($args['quiet']);
$log = static function (string $msg) use ($quiet): void {
    if (!$quiet) {
        fwrite(STDERR, $msg . "\n");
    }
};

$config = [
    'shard_dir' => __DIR__ . '/../.local/shards',
    'webroot'   => __DIR__ . '/../.local/webroot',
    'state_dir' => __DIR__ . '/../.local/state',
    'timeout_s' => 20,
    'routes'    => null,
    'watches'   => [],
];
if (isset($args['config'])) {
    $loaded = require (string) $args['config'];
    if (!is_array($loaded)) {
        fwrite(STDERR, "config file did not return an array\n");
        exit(2);
    }
    $config = array_merge($config, $loaded);
}
foreach (['shards' => 'shard_dir', 'out' => 'webroot'] as $flag => $key) {
    if (isset($args[$flag]) && is_string($args[$flag])) {
        $config[$key] = $args[$flag];
    }
}
if (isset($args['routes']) && is_string($args['routes'])) {
    $config['routes'] = array_values(array_filter(array_map('trim', explode(',', $args['routes']))));
}

$shard_dir = rtrim((string) $config['shard_dir'], '/');
$webroot   = rtrim((string) $config['webroot'], '/');
$state_dir = rtrim((string) $config['state_dir'], '/');
$api_dir   = $webroot . '/api';
$lock_path = (string) ($config['lock_file'] ?? $state_dir . '/cron.lock');
$state_path = $state_dir . '/state.json';

$lock = cm_acquire_lock($lock_path);
if ($lock === null) {
    $log('another run holds the lock; exiting without writing');
    exit(0);
}

$errors = [];
$state = cm_shard_read($state_path) ?? [];
$cron_last_success_at = (int) ($state['cron_last_success_at'] ?? 0);

/* ---- shards ---------------------------------------------------------------------- */

$index = cm_shard_index($shard_dir);
if ($index === null) {
    $errors[] = "no shard index at $shard_dir/index.json";
}

/* ---- feeds ----------------------------------------------------------------------- */

$fixtures = isset($args['fixtures']) && is_string($args['fixtures'])
    ? rtrim($args['fixtures'], '/')
    : null;

$feeds = [];
if ($fixtures !== null) {
    $feeds['positions']    = cm_read_json_file($fixtures . '/vehiclepositions.json');
    $feeds['trip_updates'] = cm_read_json_file($fixtures . '/tripupdates.json');
    $feeds['alerts']       = cm_read_json_file($fixtures . '/servicealerts.json');
} else {
    foreach (CM_FEED_URLS as $name => $url) {
        $feeds[$name] = cm_fetch_json($url, (int) $config['timeout_s']);
    }
}
foreach ($feeds as $name => $r) {
    if (!$r['ok']) {
        $errors[] = $name . ': ' . $r['error'];
    } else {
        $log(sprintf('%s: %d bytes', $name, $r['bytes']));
    }
}

/* ---- clock ----------------------------------------------------------------------- */

$positions_at = ($feeds['positions']['ok'] ?? false)
    ? (int) ($feeds['positions']['data']['header']['timestamp'] ?? 0)
    : 0;
$trip_updates_at = ($feeds['trip_updates']['ok'] ?? false)
    ? (int) ($feeds['trip_updates']['data']['header']['timestamp'] ?? 0)
    : 0;
/*
 * The alerts feed is a bare array with no header, so it has no self-reported generation
 * time. The age of our copy is the time we obtained it, which is the honest answer.
 * Offline runs fall back to the positions header so a fixture run is deterministic.
 */
$alerts_at = ($feeds['alerts']['ok'] ?? false)
    ? ($fixtures !== null ? $positions_at : (int) $feeds['alerts']['fetched_at'])
    : 0;

if (isset($args['now'])) {
    $now = (int) $args['now'];
} elseif ($fixtures !== null) {
    $now = $positions_at > 0 ? $positions_at : time();
} else {
    $now = time();
}

$feed_times = [
    'positions'    => $positions_at,
    'trip_updates' => $trip_updates_at,
    'alerts'       => $alerts_at,
];

$service_date = cm_service_date_for($now);
$feed_version = (string) ($index['feed_version'] ?? 'unknown');
$gtfs_built_at = (int) ($index['built_at'] ?? 0);
$feed_start = (string) ($index['feed_start_date'] ?? '');

$schedule_age_days = 0;
if (preg_match('/^\d{8}$/', $feed_start) === 1) {
    $a = cm_service_day_midnight($feed_start);
    $b = cm_service_day_midnight($service_date);
    if ($a !== null && $b !== null) {
        $schedule_age_days = max(0, (int) round(($b - $a) / 86400));
    }
}

$staleness = cm_staleness($now, $feed_times, $schedule_age_days);
$suppress = (bool) $staleness['suppress_adherence'];

/* ------------------------------------------------------------------------------------
 * A failed upstream means no route file is rewritten. health.json is still written --
 * that is the whole point of the endpoint -- and its errors force ok:false.
 * ---------------------------------------------------------------------------------- */

if ($errors !== []) {
    cm_atomic_write_json($api_dir . '/health.json', cm_build_health(
        $now,
        $feed_times,
        [
            'feed_version' => $feed_version,
            'built_at'     => $gtfs_built_at,
            'valid_until'  => (string) ($index['feed_end_date'] ?? ''),
        ],
        ['vehicles' => 0, 'routes_written' => 0],
        $errors,
        $cron_last_success_at
    ));
    foreach ($errors as $e) {
        fwrite(STDERR, "error: $e\n");
    }
    cm_release_lock($lock);
    exit(1);
}

/* ---- shared derived state -------------------------------------------------------- */

$positions = $feeds['positions']['data'];
$trip_updates = cm_index_trip_updates($feeds['trip_updates']['data']);
$parsed_alerts = cm_alerts_parse($feeds['alerts']['data'], $now);
$log(sprintf(
    'trip updates indexed: %d; alerts active now: %d of %d',
    count($trip_updates),
    count($parsed_alerts),
    count($feeds['alerts']['data'])
));

$active_services = cm_shard_active_services($index, $service_date);

/* Group vehicles by route once; everything downstream reads these buckets. */
$by_route = [];
$deadhead_entities = [];
foreach (($positions['entity'] ?? []) as $entity) {
    $v = $entity['vehicle'] ?? null;
    if (!is_array($v)) {
        continue;
    }
    $rid = (string) ($v['trip']['routeId'] ?? '');
    $tid = (string) ($v['trip']['tripId'] ?? '');
    if ($rid === '' || $tid === '') {
        $deadhead_entities[] = $entity;
        continue;
    }
    $by_route[$rid][] = $entity;
}

$route_ids = array_map('strval', array_keys($index['routes'] ?? []));
if (is_array($config['routes'] ?? null)) {
    $wanted = array_map('strval', $config['routes']);
    $route_ids = array_values(array_intersect($route_ids, $wanted));
}

$envelope_feeds = [
    'positions_at'      => $positions_at,
    'trip_updates_at'   => $trip_updates_at,
    'alerts_at'         => $alerts_at,
    'gtfs_feed_version' => $feed_version,
    'gtfs_built_at'     => $gtfs_built_at,
];

$all_vehicles = [];
$routes_written = 0;
$routes_active = [];
$watch_targets = [];

foreach ($route_ids as $rid) {
    $shard = cm_shard_route($shard_dir, $rid, $index);
    if ($shard === null) {
        $errors[] = "missing shard for route $rid";
        continue;
    }
    $entities = $by_route[$rid] ?? [];
    /*
     * Every route needs its stop times now, not only the ones with a bus: the schedule
     * block and route.next_departure are both derived from them. 16.6 MB of JSON across 71
     * routes, parsed one route at a time and freed before the next, which is what keeps
     * peak memory flat.
     */
    $times = cm_shard_times($shard_dir, $rid, $index);

    /* Trip updates belonging to this route, for the counting window in section 3.1. */
    $route_tus = [];
    foreach ($trip_updates as $tid => $tu) {
        if ((string) ($tu['trip']['routeId'] ?? '') === $rid) {
            $route_tus[$tid] = $tu;
        }
    }

    $short_name = (string) ($index['routes'][$rid]['short_name'] ?? $rid);

    $vehicles = [];
    foreach ($entities as $entity) {
        $tid = (string) ($entity['vehicle']['trip']['tripId'] ?? '');
        $veh = cm_build_vehicle(
            $entity,
            $shard,
            $times,
            $trip_updates[$tid] ?? null,
            $suppress,
            $short_name
        );
        if ($veh !== null) {
            $vehicles[] = $veh;
        }
    }
    usort($vehicles, static fn($a, $b) => strcmp($a['vehicle_id'], $b['vehicle_id']));

    $timepoints = cm_build_timepoints(
        $shard,
        $active_services,
        cm_count_realtime_skips($route_tus, $rid),
        cm_alert_no_service_stops($parsed_alerts, $rid),
        cm_live_served_stops($route_tus, $shard)
    );

    /* The route's own calendar, not the system's: no route runs every service id. */
    $route_day = $shard['calendar'][$service_date] ?? null;
    $route_services = array_map('strval', $route_day['service_ids'] ?? []);
    if ($route_services === []) {
        /* No service on this route today. service_ids has minItems 1, and saying so
           explicitly beats emitting a shape the client cannot parse. */
        $route_services = ['none'];
    }

    $schedule = cm_build_schedule(
        $times,
        $timepoints,
        $shard['route']['directions'] ?? [['id' => 0, 'headsign' => null]],
        $active_services,
        $trip_updates,
        $service_date,
        $now
    );
    $next_departure = $schedule['next_departure'];
    unset($schedule['next_departure']);
    if ($next_departure !== null) {
        $stop_id = $next_departure['stop_id'];
        $next_departure = [
            'scheduled_at' => $next_departure['scheduled_at'],
            'stop_id'      => $stop_id,
            'stop_name'    => (string) ($shard['stops'][$stop_id]['name'] ?? $stop_id),
            'direction_id' => $next_departure['direction_id'],
            'headsign'     => $next_departure['headsign'],
        ];
    }

    $doc = [
        'schema'       => 1,
        'generated_at' => $now,
        'route'        => [
            'id'             => $rid,
            'short_name'     => (string) ($shard['route']['short_name'] ?? $rid),
            'long_name'      => (string) ($shard['route']['long_name'] ?? ''),
            'directions'     => $shard['route']['directions'] ?? [['id' => 0, 'headsign' => null]],
            'next_departure' => $next_departure,
        ],
        'feeds'        => $envelope_feeds,
        'staleness'    => $staleness,
        'service_day'  => [
            'date'             => $service_date,
            'service_ids'      => $route_services,
            'is_exception_day' => (bool) ($route_day['is_exception_day'] ?? false),
        ],
        'vehicles'     => $vehicles,
        'timepoints'   => $timepoints,
        'schedule'     => $schedule,
        'alerts'       => cm_alerts_for_route($parsed_alerts, $rid),
    ];

    if (!cm_atomic_write_json($api_dir . '/route/' . $rid . '.json', $doc)) {
        $errors[] = "write failed for route $rid";
    } else {
        $routes_written++;
    }
    if ($vehicles !== []) {
        $routes_active[$rid] = true;
    }
    foreach ($vehicles as $veh) {
        $all_vehicles[] = $veh;
    }

    /*
     * Silent failure 1: after a GTFS reset every trip id changes, the shards still parse,
     * and every bus quietly reports unknown forever. Measure the miss rate and alarm.
     */
    if ($entities !== []) {
        $live_ids = [];
        foreach ($entities as $entity) {
            $live_ids[] = (string) ($entity['vehicle']['trip']['tripId'] ?? '');
        }
        $rate = cm_unmatched_trip_rate($shard, $live_ids);
        if ($rate > CM_UNMATCHED_TRIP_ALARM) {
            $errors[] = sprintf(
                'route %s: %d%% of live trip ids are absent from the schedule shard (feed %s)',
                $rid,
                (int) round($rate * 100),
                $feed_version
            );
        }
    }

    /* Watches are resolved against the shard that is already in memory. */
    foreach (($config['watches'] ?? []) as $watch) {
        if ((string) $watch['route_id'] !== $rid) {
            continue;
        }
        $watch_targets[] = [
            'watch'      => $watch,
            'resolution' => cm_watch_resolve($watch, $shard, $times, $active_services, $service_date),
            'shard'      => $shard,
            'times'      => $times,
            'short_name' => $short_name,
        ];
    }

    unset($shard, $times, $route_tus, $vehicles, $timepoints, $schedule, $doc);
}

/* Deadheads: 143 of 392 in the capture. No trip, no route, no lateness. */
foreach ($deadhead_entities as $entity) {
    $veh = cm_build_vehicle($entity, null, [], null, $suppress, null);
    if ($veh !== null) {
        $all_vehicles[] = $veh;
    }
}
usort($all_vehicles, static fn($a, $b) => strcmp($a['vehicle_id'], $b['vehicle_id']));

$in_service = 0;
foreach ($all_vehicles as $v) {
    if ($v['in_service']) {
        $in_service++;
    }
}

$system_services = array_keys($active_services);
sort($system_services);
if ($system_services === []) {
    $system_services = ['none'];
}

$all_doc = [
    'schema'       => 1,
    'generated_at' => $now,
    'feeds'        => $envelope_feeds,
    'staleness'    => $staleness,
    'service_day'  => [
        'date'             => $service_date,
        'service_ids'      => $system_services,
        'is_exception_day' => cm_shard_is_exception_day($index, $service_date),
    ],
    'counts'       => [
        'total'         => count($all_vehicles),
        'in_service'    => $in_service,
        'deadhead'      => count($all_vehicles) - $in_service,
        'routes_active' => count($routes_active),
    ],
    'vehicles'     => $all_vehicles,
];
if (!cm_atomic_write_json($api_dir . '/all.json', $all_doc)) {
    $errors[] = 'write failed for all.json';
}

/* ---- watches --------------------------------------------------------------------- */

$vehicle_by_trip = [];
foreach ($all_vehicles as $v) {
    if (isset($v['trip']['trip_id'])) {
        $vehicle_by_trip[(string) $v['trip']['trip_id']] = $v;
    }
}

foreach ($watch_targets as $t) {
    $w = $t['watch'];
    $res = $t['resolution'];
    $trip_id = $res['trip_id'];
    $end_epoch = cm_watch_trip_end_epoch($t['times'], $trip_id, $service_date);
    $vehicle = $trip_id !== null ? ($vehicle_by_trip[$trip_id] ?? null) : null;
    $id = cm_watch_id(
        (string) $w['route_id'],
        (int) $w['direction_id'],
        (string) $w['stop_id'],
        (string) $w['scheduled_time'],
        (string) $w['day_type']
    );
    $stop_id = (string) $w['stop_id'];
    $doc = [
        'schema'       => 1,
        'generated_at' => $now,
        'watch'        => [
            'route_id'       => (string) $w['route_id'],
            'direction_id'   => (int) $w['direction_id'],
            'stop_id'        => $stop_id,
            'stop_name'      => (string) ($t['shard']['stops'][$stop_id]['name'] ?? $stop_id),
            'scheduled_time' => (string) $w['scheduled_time'],
            'day_type'       => (string) $w['day_type'],
        ],
        'resolution'   => $res,
        'status'       => cm_watch_status(
            $res,
            $vehicle,
            $trip_id !== null ? ($trip_updates[$trip_id] ?? null) : null,
            $now,
            $end_epoch
        ),
        'vehicle'      => $vehicle,
    ];
    if (!cm_atomic_write_json($api_dir . '/watch/' . $id . '.json', $doc)) {
        $errors[] = "write failed for watch $id";
    }
    $log(sprintf('watch %s -> %s (%s)', $id, $doc['status'], $res['trip_id'] ?? 'unresolved'));
}

/* ---- health and state ------------------------------------------------------------ */

if ($errors === []) {
    $cron_last_success_at = $now;
    cm_atomic_write_json($state_path, ['cron_last_success_at' => $now, 'service_date' => $service_date]);
}

cm_atomic_write_json($api_dir . '/health.json', cm_build_health(
    $now,
    $feed_times,
    [
        'feed_version' => $feed_version,
        'built_at'     => $gtfs_built_at,
        'valid_until'  => (string) ($index['feed_end_date'] ?? ''),
    ],
    ['vehicles' => count($all_vehicles), 'routes_written' => $routes_written],
    $errors,
    $cron_last_success_at
));

$log(sprintf(
    'wrote %d route files, %d vehicles (%d in service, %d deadhead), %d watches%s',
    $routes_written,
    count($all_vehicles),
    $in_service,
    count($all_vehicles) - $in_service,
    count($watch_targets),
    $errors === [] ? '' : ', ' . count($errors) . ' error(s)'
));
foreach ($errors as $e) {
    fwrite(STDERR, "error: $e\n");
}

cm_release_lock($lock);
exit($errors === [] ? 0 : 1);
