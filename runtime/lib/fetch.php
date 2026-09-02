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
 *
 * The threshold is zero and deliberately not a proportion of what the JSON holds. Comparing
 * the two counts sounds stricter and is worse: the JSON's count is by definition hours old, so
 * at 1am a healthy protobuf reporting eleven night-owl buses would be refused for disagreeing
 * with a stale afternoon count of four hundred. That would decline the rescue at exactly the
 * hours the fleet legitimately changes size. Zero is the only count that means "this feed is
 * telling us nothing" rather than "the fleet is smaller than it was".
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
     * The JSON is kept, and the caller is told the fallback was consulted and did not help.
     *
     * Two channels, because the two cases are not the same severity. A JSON that failed
     * outright is already an error, so the fallback's failure joins it there. A JSON that
     * merely went stale is `ok`, and generate-api.php only reads `error` off a result that is
     * not ok — putting it there would be writing into a field nothing reads. It goes in
     * `fallback_error` instead, which the caller logs. Either way the run stops looking like
     * one where the fallback was never needed, which is the blindness issue 14 was about one
     * level up: a rescue that quietly fails to fire is a rescue nobody knows is broken.
     */
    if ($pb_result !== null) {
        if (!($pb_result['ok'] ?? false)) {
            $why = (string) ($pb_result['error'] ?? 'unknown error');
        } elseif (cm_positions_entity_count($pb_result) === 0) {
            /* The case round 1 added the guard for. It was the one leaving no trace at all:
               a fallback that fetched and decoded cleanly and still could not help. */
            $why = 'fallback carried no vehicles';
        } else {
            $why = sprintf(
                'fallback is no fresher (%ds behind the stale JSON)',
                cm_positions_header_at($json_result) - cm_positions_header_at($pb_result)
            );
        }

        if ($json_result['ok'] ?? false) {
            $json_result['fallback_error'] = $why;
        } else {
            $json_result['error'] = sprintf(
                '%s (fallback also failed: %s)',
                (string) ($json_result['error'] ?? 'unknown error'),
                $why
            );
        }
    }

    $json_result['source'] = 'json';

    return $json_result;
}

/*
 * The fallback's share of the run's time budget.
 *
 * Ten seconds is far more than the response needs — the body is 13.5 KB gzipped — and the cap
 * exists so the fallback cannot be the thing that runs a cycle out of time. It is deliberately
 * a small fixed slice rather than the full `timeout_s`, because the fallback fires precisely
 * on the runs where upstream is already misbehaving, which is when every other request is
 * slowest too.
 *
 * WHAT IT DOES NOT DO is bring the run inside the generator unit's TimeoutStartSec=50. Nothing
 * here could: at the configured `timeout_s` of 15 the three feed requests are already 45s, and
 * every fifteenth minute the upstream probe adds three more ranged GETs at the same timeout,
 * for 90s of worst case that predates this feed entirely. The budget is over the ceiling with
 * or without the fallback, and closing that gap means bounding the whole run rather than one
 * request in it. See TODOS.md. This cap keeps the fallback from making an existing problem
 * meaningfully worse; it does not pretend to solve it.
 */
const CM_POSITIONS_PB_TIMEOUT_S = 10;

/*
 * Decode protobuf bytes into the result shape cm_positions_choose() compares.
 *
 * Split from the fetch so the decode can be driven from bytes that did not come off a socket:
 * generate-api.php's fixture mode reads a committed .pb through this, which is what lets a
 * test produce a real webroot from the fallback path rather than only unit-test the chooser.
 *
 * $fetched_at defaults to now for callers holding bytes rather than a response.
 */
function cm_decode_positions_pb(string $body, ?int $fetched_at = null): array
{
    $data = cm_gtfsrt_decode($body);
    if ($data === null) {
        return ['ok' => false, 'error' => sprintf('%s: not a decodable FeedMessage', CM_POSITIONS_PB_URL)];
    }

    return [
        'ok'         => true,
        'data'       => $data,
        'bytes'      => strlen($body),
        'fetched_at' => $fetched_at ?? time(),
    ];
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

    return cm_decode_positions_pb($r['body'], $r['fetched_at']);
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
