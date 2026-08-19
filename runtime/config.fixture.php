<?php
/*
 * Offline development config. Reads the committed schedule shards in data/ and writes into
 * .local/, which is gitignored. Used by the no-network test path:
 *
 *   npm run gtfs        # build/ regenerates data/ if it is not committed yet
 *   php runtime/generate-api.php --config=runtime/config.fixture.php \
 *       --fixtures=tests/fixtures/feeds-20260819
 */

return [
    'shard_dir' => __DIR__ . '/../data',
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
