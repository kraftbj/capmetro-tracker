<?php
/*
 * The route catalog, api-contract.md section 15.
 *
 * The picker needs to name every route before it knows anything about any of them. It
 * cannot fetch 71 route files to find out, and it must not carry a hard-coded list: the
 * build generates 71 route files and a client list that says six is wrong the moment
 * CapMetro adds a route. api/routes.json is the one small document that answers "what
 * routes exist, what do they run today, and where are their buses right now".
 *
 * Small is the whole design constraint. It is fetched on first paint, so it carries the
 * picker's row (id, names, directions), the two numbers a row can show without a second
 * fetch (vehicle counts, service today), and nothing else. Anything a user only wants
 * after choosing a route belongs in api/route/{id}.json.
 *
 * Every function here is pure. The caller supplies already-built vehicles and an
 * already-resolved service day; nothing in this file reads a file or calls time().
 */

/*
 * Sort key for one route's short_name, per section 15's ordering rule.
 *
 * Lexicographic order is wrong for route numbers and wrong in a way riders notice: it puts
 * 10 between 1 and 103, so the 10 lands nine rows above the 4. The rule is therefore
 * "numeric ascending when the short_name is entirely digits, then everything else
 * alphabetically", which is how a human reads a route list.
 *
 * The returned key is [bucket, numeric, folded] and is compared element by element:
 *
 *   bucket   0 for an all-digit short_name, 1 for anything else, so 803 precedes MetroRail
 *   numeric  the integer value, 0 in the alpha bucket where it carries no meaning
 *   folded   the lowercased short_name, which orders the alpha bucket and breaks a tie
 *            between two numerically equal spellings ("07" and "7") deterministically
 *
 * The folded element must be compared with strcmp and not with <=>. PHP compares two
 * numeric strings numerically, so "7" <=> "07" is 0 and the tie the third element exists
 * to break survives it; the two spellings then come out in whatever order they went in.
 *
 * ctype_digit is the membership test rather than is_numeric: is_numeric accepts "1e3",
 * " 12" and "0x1A", none of which is a route number, and all of which would sort somewhere
 * surprising.
 */
function cm_route_sort_key(string $short_name): array
{
    $trimmed = trim($short_name);
    if ($trimmed !== '' && ctype_digit($trimmed)) {
        return [0, (int) $trimmed, mb_strtolower($trimmed, 'UTF-8')];
    }
    return [1, 0, mb_strtolower($trimmed, 'UTF-8')];
}

/*
 * Order a catalog's routes. Stable and total: the route id is the final tie-break, so two
 * runs over the same feed emit byte-identical files and a diff between two days is
 * readable.
 */
function cm_sort_route_catalog(array $routes): array
{
    usort($routes, static function (array $a, array $b): int {
        $ka = cm_route_sort_key((string) ($a['short_name'] ?? ''));
        $kb = cm_route_sort_key((string) ($b['short_name'] ?? ''));
        return ($ka[0] <=> $kb[0])
            ?: (($ka[1] <=> $kb[1])
            ?: (strcmp($ka[2], $kb[2])
            ?: strcmp((string) ($a['id'] ?? ''), (string) ($b['id'] ?? ''))));
    });
    return array_values($routes);
}

/*
 * Count a route's vehicles the way the Vehicle object already defines the split.
 *
 * in_service is read off each vehicle rather than recounted from the feed, so the number
 * on the picker row and the number of rows on the route's own board are the same join and
 * cannot disagree.
 *
 * Measured caveat, and the contract says it out loud: in feed 260818_1456 every one of the
 * 143 out-of-service vehicles reports no routeId at all, so nothing can be attributed to a
 * route and out_of_service is 0 for all 71 routes. The field is still counted and
 * published rather than dropped, because the alternative is a client that infers "0" from
 * an absent key, and because a feed that does start attributing deadheads to a route would
 * otherwise change the document's shape rather than one of its numbers.
 */
function cm_catalog_vehicle_counts(array $vehicles): array
{
    $in_service = 0;
    foreach ($vehicles as $v) {
        if (!empty($v['in_service'])) {
            $in_service++;
        }
    }
    return [
        'in_service'     => $in_service,
        'out_of_service' => count($vehicles) - $in_service,
    ];
}

/*
 * One catalog row.
 *
 * $route_meta is the shard's route block: id, short_name, long_name, directions.
 * $vehicles   is that route's built Vehicle list, exactly as api/route/{id}.json carries it.
 * $has_service_today is the caller's answer, computed from the trips the departures
 *                    document publishes so the two documents cannot disagree.
 *
 * long_name is published verbatim, leading "{id}-" and all, because api/route/{id}.json
 * publishes it verbatim. One string, two documents, one value: a client that strips the
 * prefix strips it in one place and a client that does not is consistently wrong rather
 * than wrong on one screen out of two.
 */
function cm_catalog_entry(array $route_meta, array $vehicles, bool $has_service_today): array
{
    $directions = [];
    foreach ($route_meta['directions'] ?? [] as $d) {
        $directions[] = [
            'id'       => (int) ($d['id'] ?? 0),
            'headsign' => isset($d['headsign']) && $d['headsign'] !== null
                ? (string) $d['headsign']
                : null,
        ];
    }
    if ($directions === []) {
        $directions = [['id' => 0, 'headsign' => null]];
    }

    return [
        'id'                => (string) ($route_meta['id'] ?? ''),
        'short_name'        => (string) ($route_meta['short_name'] ?? ($route_meta['id'] ?? '')),
        'long_name'         => (string) ($route_meta['long_name'] ?? ''),
        'directions'        => $directions,
        'vehicles'          => cm_catalog_vehicle_counts($vehicles),
        'has_service_today' => $has_service_today,
    ];
}

/*
 * The whole document.
 *
 * $service_day is the system-wide service day, the same block api/all.json carries: this
 * is a system document, not a route document, and a per-route calendar would have to be
 * 71 different answers in one field. A route's own answer to "does it run today" is the
 * boolean on its row.
 */
function cm_build_route_catalog(int $now, array $service_day, array $routes): array
{
    return [
        'schema'       => 1,
        'generated_at' => $now,
        'service_day'  => $service_day,
        'routes'       => cm_sort_route_catalog($routes),
    ];
}
