<?php
/*
 * Offline development config. Joins the committed feed capture against the shards that
 * capture was taken from, and writes into .local/, which is gitignored:
 *
 *   php runtime/generate-api.php --config=runtime/config.fixture.php \
 *       --fixtures=tests/fixtures/feeds-20260819
 *
 * shard_dir is the FROZEN 260818_1456 snapshot, not data/. The capture is from 2026-08-19 and
 * data/ now holds 260826_0956, whose first service date is 2026-08-26 -- so pointed at data/
 * this produced 71 departure boards with zero departures on every one of them and an
 * ok:false health file, because the fixture's service day does not exist in the current
 * calendar at all. Every acceptance criterion that binds to generated output then stood down,
 * silently, on a corpus that was present but empty.
 *
 * The snapshot carries all 71 routes, so the sweep this feeds -- every route file, both
 * catalog endpoints, the acceptance criteria -- is exactly as broad as it was against data/,
 * and stays that way when CapMetro republishes.
 */

return [
    'shard_dir' => __DIR__ . '/../tests/fixtures/shards-260818_1456',
    'webroot'   => __DIR__ . '/../.local/webroot',
    'state_dir' => __DIR__ . '/../.local/state',
    'timeout_s' => 15,
    'routes'    => null,
    'watches'   => [
        /* The worked example from the design doc: 7:50a 800 SB from Simond/Berkman. */
        [
            'route_id'       => '800',
            'direction_id'   => 1,
            'stop_id'        => '6293',
            'scheduled_time' => '07:52:09',
            'day_type'       => 'weekday',
        ],
    ],
];
