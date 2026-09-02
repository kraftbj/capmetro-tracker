<?php
/*
 * /api/health.json, api-contract.md section 10.
 *
 * Small, cheap, and checkable without opening the app. This is the endpoint an uptime
 * check hits, so it is the one file that is still written when a run fails: the whole
 * point is to say so.
 *
 * ok is false when any feed is older than 600s, the GTFS feed version is past its
 * valid_until date, or the run raised an error.
 *
 * Pure function. No I/O.
 */

require_once __DIR__ . '/staleness.php';

function cm_build_health(
    int $now,
    array $feed_times,
    array $gtfs,
    array $counts,
    array $errors,
    int $cron_last_success_at,
    string $positions_source = 'json'
): array {
    $errors = array_values(array_unique(array_map('strval', $errors)));

    foreach ($feed_times as $label => $t) {
        if ((int) $t <= 0) {
            /* No timestamp at all means the fetch failed; the caller has already said so
               in its own words, and a nonsense age computed from epoch 0 helps nobody. */
            continue;
        }
        $age = $now - (int) $t;
        if ($age > CM_STALE_STALE_S) {
            $errors[] = sprintf('%s feed is %ds old', $label, $age);
        }
    }

    $valid_until = (string) ($gtfs['valid_until'] ?? '');
    if (preg_match('/^\d{8}$/', $valid_until) === 1) {
        $today = (new DateTimeImmutable('@' . $now))
            ->setTimezone(new DateTimeZone(CM_TZ))->format('Ymd');
        if ($today > $valid_until) {
            $errors[] = sprintf('GTFS feed %s expired on %s', $gtfs['feed_version'] ?? '?', $valid_until);
        }
    }

    return [
        'schema'               => 1,
        'generated_at'         => $now,
        'ok'                   => $errors === [],
        'cron_last_success_at' => $cron_last_success_at,
        'feeds'                => [
            'positions_at'    => (int) ($feed_times['positions'] ?? 0),
            'trip_updates_at' => (int) ($feed_times['trip_updates'] ?? 0),
            'alerts_at'       => (int) ($feed_times['alerts'] ?? 0),
            /*
             * Which of CapMetro's two positions publications this run used. A board running
             * on the protobuf fallback is otherwise indistinguishable from a healthy one,
             * and the whole reason issue 14 exists is that a stall went unnoticed for four
             * hours. "json" on every ordinary run; "protobuf" means the JSON feed stalled.
             */
            'positions_source' => $positions_source,
        ],
        'gtfs'                 => [
            'feed_version' => (string) ($gtfs['feed_version'] ?? 'unknown'),
            'built_at'     => (int) ($gtfs['built_at'] ?? 0),
            'valid_until'  => preg_match('/^\d{8}$/', $valid_until) === 1 ? $valid_until : '19700101',
        ],
        'counts'               => [
            'vehicles'       => (int) ($counts['vehicles'] ?? 0),
            'routes_written' => (int) ($counts['routes_written'] ?? 0),
        ],
        'errors'               => array_values(array_unique($errors)),
    ];
}
