<?php
/*
 * Service alert ingest for feed 9zu9-jwr2.
 *
 * This feed is NOT GTFS-Realtime. It is a bespoke Socrata array: camelCase keys,
 * informedEntities (plural), activePeriods, and no header/entity envelope. It gets its own
 * parser rather than being forced through the GTFS-RT path.
 *
 * PRIVACY, api-contract.md section 6. Every upstream alert object carries userEmail and
 * userFullname: the CapMetro employee who filed it. The parser copies fields out of the
 * upstream object by an explicit ALLOWLIST. It never copies the object and deletes keys,
 * because a denylist leaks any field the agency adds later. Nothing outside
 * CM_ALERT_ALLOWED_FIELDS is ever read, so nothing outside it can be written, cached, or
 * logged.
 *
 * Pure functions. No I/O.
 */

/*
 * The only upstream keys this program is permitted to read. Adding a key here is the
 * single place a new field can enter the system, and it is a deliberate act.
 */
const CM_ALERT_ALLOWED_FIELDS = [
    'id',
    'effect',
    'cause',
    'url',
    'headerText',
    'descriptionText',
    'activePeriods',
    'informedEntities',
];

const CM_ALERT_EFFECTS = [
    'NO_SERVICE',
    'DETOUR',
    'REDUCED_SERVICE',
    'MODIFIED_SERVICE',
    'OTHER',
];

function cm_alert_severity(string $effect): string
{
    if ($effect === 'NO_SERVICE') {
        return 'high';
    }
    if ($effect === 'DETOUR' || $effect === 'REDUCED_SERVICE') {
        return 'medium';
    }
    return 'low';
}

/*
 * Socrata timestamps are ISO 8601 with a Z suffix. Returns null for null/empty, which is
 * meaningful: a null activePeriods[].end means open-ended, not unknown.
 */
function cm_alert_iso_to_epoch($iso): ?int
{
    if (!is_string($iso) || trim($iso) === '') {
        return null;
    }
    $ts = strtotime($iso);
    return $ts === false ? null : $ts;
}

/*
 * Reduce every activePeriods entry to the widest window, then decide whether $now falls
 * inside it. Returns ['active' => bool, 'from' => int, 'until' => ?int].
 *
 * A missing start is treated as "already started" (epoch 0). A missing or null end is
 * open-ended, which is the common case: 59 of the 104 alerts in the 2026-08-19 capture.
 */
function cm_alert_active_window(array $periods, int $now): array
{
    if ($periods === []) {
        return ['active' => true, 'from' => 0, 'until' => null];
    }
    $active = false;
    $from = null;
    $until = null;
    $open_ended = false;
    foreach ($periods as $p) {
        if (!is_array($p)) {
            continue;
        }
        $s = cm_alert_iso_to_epoch($p['start'] ?? null) ?? 0;
        $e = cm_alert_iso_to_epoch($p['end'] ?? null);
        if ($now >= $s && ($e === null || $now <= $e)) {
            $active = true;
        }
        $from = $from === null ? $s : min($from, $s);
        if ($e === null) {
            $open_ended = true;
        } else {
            $until = $until === null ? $e : max($until, $e);
        }
    }
    return [
        'active' => $active,
        'from'   => $from ?? 0,
        'until'  => $open_ended ? null : $until,
    ];
}

/*
 * Parse one upstream alert.
 *
 * Returns null when the alert is not active at $now. Otherwise returns
 * ['route_ids' => [...], 'alert' => <contract section 5 object>]. route_ids is carried
 * alongside rather than inside the alert because the published schema forbids extra
 * properties; the route file uses it to decide which alerts to include and never emits it.
 */
function cm_alert_parse_one($raw, int $now): ?array
{
    if (!is_array($raw)) {
        return null;
    }

    /* Allowlist copy. Nothing else from $raw is ever touched below this line. */
    $safe = [];
    foreach (CM_ALERT_ALLOWED_FIELDS as $key) {
        if (array_key_exists($key, $raw)) {
            $safe[$key] = $raw[$key];
        }
    }

    $id = isset($safe['id']) ? (string) $safe['id'] : '';
    if ($id === '') {
        return null;
    }

    $window = cm_alert_active_window(
        is_array($safe['activePeriods'] ?? null) ? $safe['activePeriods'] : [],
        $now
    );
    if (!$window['active']) {
        return null;
    }

    $effect = is_string($safe['effect'] ?? null) ? $safe['effect'] : 'OTHER';
    if (!in_array($effect, CM_ALERT_EFFECTS, true)) {
        $effect = 'OTHER';
    }

    $route_ids = [];
    $stop_ids  = [];
    foreach ((is_array($safe['informedEntities'] ?? null) ? $safe['informedEntities'] : []) as $ie) {
        if (!is_array($ie)) {
            continue;
        }
        if (isset($ie['routeId']) && $ie['routeId'] !== '') {
            $route_ids[(string) $ie['routeId']] = true;
        }
        if (isset($ie['stopId']) && $ie['stopId'] !== '') {
            $stop_ids[(string) $ie['stopId']] = true;
        }
    }

    $url = $safe['url'] ?? null;

    /*
     * array_keys() on a map with numeric-string keys hands back ints, because PHP coerces
     * "4" to 4 on assignment. Route and stop ids are strings everywhere in the contract
     * ("4", not 4), so normalize here or every strict comparison downstream silently
     * fails and the schema rejects the ints.
     */
    return [
        'route_ids' => array_map('strval', array_keys($route_ids)),
        'alert'     => [
            'id'           => $id,
            'effect'       => $effect,
            'cause'        => is_string($safe['cause'] ?? null) && $safe['cause'] !== ''
                ? $safe['cause'] : 'UNKNOWN_CAUSE',
            'header'       => is_string($safe['headerText'] ?? null) ? $safe['headerText'] : '',
            'description'  => is_string($safe['descriptionText'] ?? null) ? $safe['descriptionText'] : '',
            'url'          => is_string($url) && $url !== '' ? $url : null,
            'active_from'  => max(0, (int) $window['from']),
            'active_until' => $window['until'],
            'stop_ids'     => array_map('strval', array_keys($stop_ids)),
            'severity'     => cm_alert_severity($effect),
        ],
    ];
}

/*
 * Parse the whole feed. Only alerts whose active period covers $now survive.
 * Returns a list of ['route_ids' => [...], 'alert' => [...]].
 */
function cm_alerts_parse($feed, int $now): array
{
    $out = [];
    foreach (is_array($feed) ? $feed : [] as $raw) {
        $parsed = cm_alert_parse_one($raw, $now);
        if ($parsed !== null) {
            $out[] = $parsed;
        }
    }
    return $out;
}

/*
 * The alerts a given route file should carry, in the contract's shape.
 */
function cm_alerts_for_route(array $parsed, string $route_id): array
{
    $out = [];
    foreach ($parsed as $p) {
        if (in_array($route_id, $p['route_ids'], true)) {
            $out[] = $p['alert'];
        }
    }
    return $out;
}

/*
 * Stop ids under an active NO_SERVICE alert for a route, as a set keyed by stop id.
 * Feeds source priority 2 of the stop service status precedence.
 */
function cm_alert_no_service_stops(array $parsed, string $route_id): array
{
    $set = [];
    foreach ($parsed as $p) {
        if ($p['alert']['effect'] !== 'NO_SERVICE') {
            continue;
        }
        if (!in_array($route_id, $p['route_ids'], true)) {
            continue;
        }
        foreach ($p['alert']['stop_ids'] as $sid) {
            $set[(string) $sid] = true;
        }
    }
    return $set;
}
