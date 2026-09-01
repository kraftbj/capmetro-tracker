<?php
/*
 * Upstream feed fetch.
 *
 * ALWAYS sends Accept-Encoding: gzip. This is not a micro-optimization: the trip updates
 * feed is 1,854,274 bytes uncompressed and 158,052 bytes gzipped, an 11.7x reduction, and
 * it is fetched every 60 seconds forever.
 *
 * CONDITIONAL REQUESTS ARE DELIBERATELY NOT IMPLEMENTED. The feeds return an ETag but
 * answer If-None-Match with a full 200 and the whole body, never a 304. Sending the header
 * costs bytes and buys nothing, and code that looks like it saves bandwidth but does not is
 * worse than no code.
 *
 * The only side-effecting module in lib/. Everything the join does is pure and lives
 * elsewhere.
 */

const CM_FEED_URLS = [
    'positions'    => 'https://data.texas.gov/download/cuc7-ywmd/application%2FJSON',
    'trip_updates' => 'https://data.texas.gov/download/mqtr-wwpy/application%2FJSON',
    'alerts'       => 'https://data.texas.gov/download/9zu9-jwr2/application%2FJSON',
];

/*
 * The same vehicle positions feed, published as protobuf (issue 14).
 *
 * Used only when the JSON publication above has stalled. On 2026-09-01 the JSON froze for over
 * four hours while this stayed current to the second, and it is the smaller of the two on the
 * wire besides: 13.5 KB gzipped against the JSON's 16 KB.
 */
const CM_POSITIONS_PB_URL = 'https://data.texas.gov/download/eiei-9rpf/application%2Foctet-stream';

const CM_USER_AGENT = 'capmetro-tracker/1 (+https://github.com/) cron';

/*
 * Fetch one URL and decode the JSON body.
 *
 * Returns ['ok' => true, 'data' => mixed, 'bytes' => int, 'fetched_at' => int]
 * or        ['ok' => false, 'error' => string].
 * Never throws, never partially writes anything: a failed feed must leave the previous
 * generated files untouched, which the caller can only do if it gets a clean signal.
 */
function cm_fetch_json(string $url, int $timeout_s = 20): array
{
    $r = cm_http_get($url, $timeout_s);
    if (!$r['ok']) {
        return $r;
    }
    $body = $r['body'];
    $data = json_decode($body, true);
    if ($data === null && trim($body) !== 'null') {
        return ['ok' => false, 'error' => sprintf('%s: %s', $url, json_last_error_msg())];
    }

    return ['ok' => true, 'data' => $data, 'bytes' => strlen($body), 'fetched_at' => $r['fetched_at']];
}

/*
 * Fetch one URL and hand back the raw body.
 *
 * Split out of cm_fetch_json so the protobuf positions fallback gets the same timeouts, the
 * same user agent and the same gzip handling without a second copy of the curl options. The
 * PB body is binary and must not go through json_decode, which is the only difference between
 * the two callers.
 *
 * Returns ['ok' => true, 'body' => string, 'fetched_at' => int] or ['ok' => false, 'error' => string].
 */
function cm_http_get(string $url, int $timeout_s = 20): array
{
    $ch = curl_init($url);
    if ($ch === false) {
        return ['ok' => false, 'error' => 'curl_init failed'];
    }
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 3,
        CURLOPT_CONNECTTIMEOUT => min(10, $timeout_s),
        CURLOPT_TIMEOUT        => $timeout_s,
        CURLOPT_USERAGENT      => CM_USER_AGENT,
        /* curl inflates transparently when the encoding is requested this way. */
        CURLOPT_ENCODING       => 'gzip',
        CURLOPT_HTTPHEADER     => ['Accept: application/json'],
    ]);
    $body = curl_exec($ch);
    $err  = curl_error($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    /* No curl_close(): deprecated in PHP 8.5 and a no-op since 8.0. The handle is freed
       when $ch goes out of scope. */

    if ($body === false || $body === '') {
        return ['ok' => false, 'error' => sprintf('%s: %s', $url, $err !== '' ? $err : 'empty body')];
    }
    if ($code < 200 || $code >= 300) {
        return ['ok' => false, 'error' => sprintf('%s: HTTP %d', $url, $code)];
    }

    return ['ok' => true, 'body' => $body, 'fetched_at' => time()];
}

/*
 * The self-reported generation time of a positions result, or 0 when there isn't one.
 *
 * Reads the feed's own header rather than when we fetched it, which is the whole point: a
 * stalled publication serves a clean 200 every minute and only its header gives it away.
 */
function cm_positions_header_at(?array $result): int
{
    if ($result === null || !($result['ok'] ?? false)) {
        return 0;
    }

    return (int) ($result['data']['header']['timestamp'] ?? 0);
}

/*
 * Does the JSON positions feed look stalled enough to be worth a second request?
 *
 * $threshold_s is passed in rather than read from staleness.php so this stays a pure function
 * of its arguments and the two modules stay uncoupled. generate-api.php passes
 * CM_STALE_STALE_S, so falling back and the board going `stale` are the same moment by
 * construction rather than by two constants that agree until someone edits one.
 */
function cm_positions_needs_fallback(array $json_result, int $now, int $threshold_s): bool
{
    if (!($json_result['ok'] ?? false)) {
        return true;
    }

    return ($now - cm_positions_header_at($json_result)) > $threshold_s;
}

/*
 * Pick between the JSON and protobuf positions feeds.
 *
 * Whichever is fresher by its own header wins, with the JSON keeping the tie so an ordinary
 * run never changes source for no reason. The chosen result carries a `source` key that
 * health.json reports: a board running on the fallback has to be distinguishable from a
 * healthy one, or the next stall goes unnoticed for another four hours.
 *
 * A failed or undecodable PB simply loses. The fallback is not assumed fresh just because it
 * is the fallback; if it has also stalled, the JSON is returned still stale and cm_staleness()
 * degrades the board exactly as it does today.
 */
function cm_positions_choose(array $json_result, ?array $pb_result, int $now, int $threshold_s): array
{
    if (!cm_positions_needs_fallback($json_result, $now, $threshold_s)) {
        $json_result['source'] = 'json';

        return $json_result;
    }

    if ($pb_result !== null
        && ($pb_result['ok'] ?? false)
        && cm_positions_header_at($pb_result) > cm_positions_header_at($json_result)
    ) {
        $pb_result['source'] = 'protobuf';

        return $pb_result;
    }

    $json_result['source'] = 'json';

    return $json_result;
}

/*
 * Fetch the positions feed, falling back to protobuf when the JSON one has stalled.
 *
 * The JSON is always fetched, which is what makes recovery automatic: the cycle it starts
 * publishing again is the cycle it is used again, with no state carried between runs. The PB
 * request only happens on a run that has already seen a stalled JSON, so the healthy path
 * costs exactly what it costs today.
 */
function cm_fetch_positions(int $timeout_s, int $now, int $threshold_s): array
{
    $json_result = cm_fetch_json(CM_FEED_URLS['positions'], $timeout_s);
    if (!cm_positions_needs_fallback($json_result, $now, $threshold_s)) {
        $json_result['source'] = 'json';

        return $json_result;
    }

    return cm_positions_choose($json_result, cm_fetch_positions_pb($timeout_s), $now, $threshold_s);
}

/*
 * Fetch and decode the protobuf positions feed into the JSON export's shape.
 *
 * Same return shape as cm_fetch_json so cm_positions_choose does not care which it is holding.
 */
function cm_fetch_positions_pb(int $timeout_s): array
{
    $r = cm_http_get(CM_POSITIONS_PB_URL, $timeout_s);
    if (!$r['ok']) {
        return $r;
    }

    $data = cm_gtfsrt_decode($r['body']);
    if ($data === null) {
        return ['ok' => false, 'error' => sprintf('%s: not a decodable FeedMessage', CM_POSITIONS_PB_URL)];
    }

    return [
        'ok'         => true,
        'data'       => $data,
        'bytes'      => strlen($r['body']),
        'fetched_at' => $r['fetched_at'],
    ];
}

/*
 * Offline equivalent used by the fixture test path, so the join can be exercised with no
 * network at all. Same return shape as cm_fetch_json.
 */
function cm_read_json_file(string $path): array
{
    if (!is_file($path)) {
        return ['ok' => false, 'error' => "missing fixture: $path"];
    }
    $body = file_get_contents($path);
    if ($body === false) {
        return ['ok' => false, 'error' => "unreadable fixture: $path"];
    }
    $data = json_decode($body, true);
    if ($data === null && trim($body) !== 'null') {
        return ['ok' => false, 'error' => sprintf('%s: %s', $path, json_last_error_msg())];
    }
    return ['ok' => true, 'data' => $data, 'bytes' => strlen($body), 'fetched_at' => (int) filemtime($path)];
}
