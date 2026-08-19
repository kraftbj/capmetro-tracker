<?php
/*
 * Saved watches, api-contract.md section 9.
 *
 * A saved watch is client-local. The client owns the tuple; the server only resolves it.
 * Nothing about a watch is user data on the server: the tuple is a route, a direction, a
 * stop, a clock time and a day type, and the id is a hash so that a URL or an access log
 * never carries a legible description of a child's daily routine.
 *
 * The tuple deliberately stores no trip id. Trip ids are not stable across service days:
 * service 1-172 covers 95 weekdays over 42 routes while 9-172 covers 99 weekdays over 32
 * routes, so there is no single "weekday" service and no trip id that survives the week.
 * Resolution is per route, against calendar_dates for the current service date.
 *
 * Pure functions. No I/O.
 */

require_once __DIR__ . '/servicetime.php';
require_once __DIR__ . '/shards.php';

/*
 * watch_id = lowercase hex of the first 16 bytes of SHA-256 over the tuple joined with a
 * single "|", in this exact order, with no whitespace:
 *
 *   route_id | direction_id | stop_id | scheduled_time | day_type
 *   "800|1|6293|07:52:09|weekday"
 *
 * direction_id serializes as 0 or 1. scheduled_time keeps HH:MM:SS including a leading
 * zero.
 */
function cm_watch_id(
    string $route_id,
    int $direction_id,
    string $stop_id,
    string $scheduled_time,
    string $day_type
): string {
    $key = implode('|', [$route_id, (string) $direction_id, $stop_id, $scheduled_time, $day_type]);
    return substr(hash('sha256', $key), 0, 32);
}

/*
 * Resolve a watch tuple against one route's shard for a service date.
 *
 * Returns the contract's resolution object. resolved is false with every field null when
 * nothing matches, which is the holiday / service change / route discontinued case; the
 * client shows why rather than a blank.
 */
function cm_watch_resolve(
    array $watch,
    ?array $route_shard,
    ?array $times,
    array $active_services,
    string $service_date
): array {
    $empty = [
        'resolved'             => false,
        'trip_id'              => null,
        'service_id'           => null,
        'service_date'         => $service_date,
        'scheduled_at'         => null,
        'ambiguous_candidates' => [],
    ];
    $want = cm_clock_to_seconds((string) $watch['scheduled_time']);
    $midnight = cm_service_day_midnight($service_date);
    if ($want === null || $midnight === null || !is_array($times['trips'] ?? null)) {
        return $empty;
    }
    $table = $times['stop_ids'] ?? [];
    $stop_id = (string) $watch['stop_id'];
    $dir = (int) $watch['direction_id'];

    $matches = [];
    foreach ($times['trips'] as $tid => $trip) {
        if ((int) ($trip['direction_id'] ?? -1) !== $dir) {
            continue;
        }
        $service_id = (string) ($trip['service_id'] ?? '');
        if (!isset($active_services[$service_id])) {
            continue;
        }
        foreach ($trip['stops'] ?? [] as $row) {
            if ((string) ($table[(int) $row[1]] ?? '') !== $stop_id) {
                continue;
            }
            if ($row[2] !== null && (int) $row[2] === $want) {
                $matches[] = ['trip_id' => (string) $tid, 'service_id' => $service_id];
            }
        }
    }
    if ($matches === []) {
        return $empty;
    }
    usort($matches, static fn($a, $b) => strcmp($a['trip_id'], $b['trip_id']));

    return [
        'resolved'             => true,
        'trip_id'              => $matches[0]['trip_id'],
        'service_id'           => $matches[0]['service_id'],
        'service_date'         => $service_date,
        'scheduled_at'         => $midnight + $want,
        /* More than one trip on this route can share a scheduled time at a stop; when that
           happens the client is told, rather than being handed an arbitrary pick. */
        'ambiguous_candidates' => count($matches) > 1 ? $matches : [],
    ];
}

/*
 * The last scheduled arrival of a trip, as epoch. Used to decide "passed" without needing
 * a vehicle to have ever been seen on it.
 */
function cm_watch_trip_end_epoch(?array $times, ?string $trip_id, string $service_date): ?int
{
    if ($trip_id === null) {
        return null;
    }
    $stops = $times['trips'][$trip_id]['stops'] ?? null;
    $midnight = cm_service_day_midnight($service_date);
    if (!is_array($stops) || $stops === [] || $midnight === null) {
        return null;
    }
    $last = $stops[count($stops) - 1];
    return $last[2] === null ? null : $midnight + (int) $last[2];
}

/*
 * not_yet_running | running | passed | canceled | unresolvable
 *
 * $vehicle is the resolved trip's Vehicle object if one is on the road, else null.
 * $trip_end_epoch is the trip's last scheduled arrival, used to decide "passed" without
 * needing a vehicle to have ever been seen.
 */
function cm_watch_status(
    array $resolution,
    ?array $vehicle,
    ?array $trip_update,
    int $now,
    ?int $trip_end_epoch
): string {
    if (!$resolution['resolved']) {
        return 'unresolvable';
    }
    $rel = $trip_update['trip']['scheduleRelationship'] ?? 'SCHEDULED';
    if ($rel === 'CANCELED') {
        return 'canceled';
    }
    if ($vehicle !== null) {
        return 'running';
    }
    if ($trip_end_epoch !== null && $now > $trip_end_epoch) {
        return 'passed';
    }
    return 'not_yet_running';
}

/*
 * True when any configured watch targets this route. Used to decide whether a route's
 * stop times need loading even when no bus is on the route right now.
 */
function cm_watch_route_wanted(array $config, string $route_id): bool
{
    foreach (($config['watches'] ?? []) as $w) {
        if ((string) ($w['route_id'] ?? '') === $route_id) {
            return true;
        }
    }
    return false;
}
