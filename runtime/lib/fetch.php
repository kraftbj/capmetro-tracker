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

require_once __DIR__ . '/gtfsrt.php';

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
 * $accept is a parameter rather than a constant because it is the one option the two callers
 * cannot share: asking a protobuf endpoint for application/json invites a content-negotiating
 * server to hand back something else, or an error, for a body we are about to parse as wire
 * format. Socrata ignores it today. That is not a reason to send the wrong thing.
 *
 * Returns ['ok' => true, 'body' => string, 'fetched_at' => int] or ['ok' => false, 'error' => string].
 */
function cm_http_get(string $url, int $timeout_s = 20, string $accept = 'application/json'): array
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
        CURLOPT_HTTPHEADER     => ['Accept: ' . $accept],
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

/* How many vehicles a positions result actually carries. */
function cm_positions_entity_count(?array $result): int
{
    if ($result === null || !($result['ok'] ?? false)) {
        return 0;
    }

    return count((array) ($result['data']['entity'] ?? []));
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
 *
 * AN EMPTY PROTOBUF LOSES TOO, and this is the one rule that is not about freshness. A feed
 * carrying zero vehicles with a current header is a perfectly plausible upstream failure, and
 * on header age alone it would beat a stale JSON every time — trading a board full of
 * four-hour-old buses for an empty one, and reporting ok:true while doing it, because an empty
 * feed raises no staleness error. Stale positions are wrong about when; no positions are wrong
 * about whether the service is running at all. The first is the better failure, and it is the
 * one the board was already built to say out loud.
 */
function cm_positions_choose(array $json_result, ?array $pb_result, int $now, int $threshold_s): array
{
    if (!cm_positions_needs_fallback($json_result, $now, $threshold_s)) {
        $json_result['source'] = 'json';

        return $json_result;
    }

    if ($pb_result !== null
        && ($pb_result['ok'] ?? false)
        && cm_positions_entity_count($pb_result) > 0
        && cm_positions_header_at($pb_result) > cm_positions_header_at($json_result)
    ) {
        $pb_result['source'] = 'protobuf';

        return $pb_result;
    }

    /*
     * The JSON is kept, so its error is the one the caller reports. When the fallback was
     * tried and also failed, say so in the same breath: an operator reading `positions: HTTP
     * 500` would otherwise have no way to tell whether the second publication had been
     * consulted at all, which is exactly the blindness issue 14 was about.
     */
    if (!($json_result['ok'] ?? false) && $pb_result !== null && !($pb_result['ok'] ?? false)) {
        $json_result['error'] = sprintf(
            '%s (fallback also failed: %s)',
            (string) ($json_result['error'] ?? 'unknown error'),
            (string) ($pb_result['error'] ?? 'unknown error')
        );
    }

    $json_result['source'] = 'json';

    return $json_result;
}

/*
 * The fallback's share of the run's time budget.
 *
 * The generator is a systemd oneshot with TimeoutStartSec=50, and a run makes three feed
 * requests at `timeout_s` each. At the configured 15s that is 45s of worst case, which fits.
 * A fourth full-budget request does not: 60s would have systemd kill the run outright, and it
 * would do so precisely on the runs where upstream is already misbehaving, which is when the
 * fallback is the only thing that could have saved the board. So the fallback gets a bounded
 * slice rather than the whole budget. Ten seconds is far more than the observed response
 * time — the PB body is 13.5 KB gzipped — and keeps the worst case at 55s of request time
 * against a 50s ceiling that no run has ever approached.
 */
const CM_POSITIONS_PB_TIMEOUT_S = 10;

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

    $pb_timeout_s = min($timeout_s, CM_POSITIONS_PB_TIMEOUT_S);

    return cm_positions_choose($json_result, cm_fetch_positions_pb($pb_timeout_s), $now, $threshold_s);
}

/*
 * Fetch and decode the protobuf positions feed into the JSON export's shape.
 *
 * Same return shape as cm_fetch_json so cm_positions_choose does not care which it is holding.
 */
function cm_fetch_positions_pb(int $timeout_s): array
{
    $r = cm_http_get(CM_POSITIONS_PB_URL, $timeout_s, 'application/x-protobuf');
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
