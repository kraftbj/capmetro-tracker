<?php
/*
 * Copy to /etc/capmetro/config.php and edit. Every value can be overridden on the command
 * line; see the flag list at the top of generate-api.php.
 */

return [
    /* The committed data/ tree from build/. The daily `git pull` cron refreshes it. */
    'shard_dir' => '/srv/capmetro/data',

    /* Files are written to {webroot}/api/... Must be on the same filesystem as the temp
       files the atomic write creates, which it guarantees by writing them in place. */
    'webroot'   => '/var/www/capmetro',

    /* Small mutable state: the cron lock and cron_last_success_at. Not served. */
    'state_dir' => '/var/lib/capmetro',

    /* Optional; defaults to {state_dir}/cron.lock. */
    'lock_file' => '/var/lib/capmetro/cron.lock',

    /* Per-feed HTTP timeout. Three feeds are fetched sequentially, so the worst case is
       three times this; keep the total well under the 60-second cron period. */
    'timeout_s' => 15,

    /*
     * null writes every route in the shard index (71 today, ~2 MB of JSON per run).
     * A list restricts it, which is worth doing if the box is small: the six routes in
     * play are 800, 4, 837, 337, 350 and 7.
     */
    'routes'    => null,

    /*
     * Saved watches to resolve each run. A watch is client-local by design; this list
     * exists only so the server can pre-resolve the ones the household actually uses.
     * The file name is the watch_id hash, so nothing in the webroot or in an access log
     * spells out a child's daily routine.
     */
    'watches'   => [
        [
            'route_id'       => '800',
            'direction_id'   => 1,
            'stop_id'        => '6293',
            'scheduled_time' => '07:52:09',
            'day_type'       => 'weekday',
        ],
    ],
];
