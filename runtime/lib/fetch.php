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
    $data = json_decode($body, true);
    if ($data === null && trim($body) !== 'null') {
        return ['ok' => false, 'error' => sprintf('%s: %s', $url, json_last_error_msg())];
    }
    return ['ok' => true, 'data' => $data, 'bytes' => strlen($body), 'fetched_at' => time()];
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
