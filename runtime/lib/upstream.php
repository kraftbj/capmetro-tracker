<?php
/*
 * Is the schedule we built from still the one CapMetro publishes?
 *
 * The board joins live trip ids against pre-built shards. When CapMetro republishes, every
 * trip id is renumbered, nothing joins, and the board says "not in today's schedule" about
 * every bus on the road while its own clocks all read healthy: the realtime feeds are
 * seconds old and feed_end_date is months away. That happened on 2026-08-27, when
 * 260818_1456 was replaced by 260826_0956 eight days into a feed advertised through
 * 2027-01-09, and 56 of 71 routes lost every match.
 *
 * Schedule AGE cannot detect this and should not try -- see the note in staleness.php about
 * why grading age was wrong. The only sound question is one of identity: does the
 * feed_version we built from still match the feed_version upstream is serving? This asks
 * exactly that.
 *
 * The obvious way costs 34 MB. Instead this reads feed_info.txt out of the remote zip with
 * three HTTP range requests -- the end-of-central-directory record, the central directory,
 * then the one member -- about 5.4 KB in total. data.texas.gov answers 206 for all three.
 *
 * Side-effecting, like fetch.php: it talks to the network. It never throws and never
 * reports a mismatch it is not sure of. A probe that fails is 'unknown', never 'superseded',
 * because a wrong banner about the schedule is worse than no banner.
 */

const CM_GTFS_ZIP_URL = 'https://data.texas.gov/download/r4v4-vz24/application%2Fzip';

/* How long a successful answer stays good. The cron runs every 60s; upstream republishes a
   few times a year. Asking every 15 minutes is 96 probes a day, ~500 KB a month. */
const CM_UPSTREAM_TTL_S = 900;

/* Re-ask sooner after a failure than after a success, but not every single run. */
const CM_UPSTREAM_RETRY_S = 180;

/* Generous enough for any local-header name and extra field, small enough to stay cheap. */
const CM_ZIP_LOCAL_HEADER_SLACK = 512;

/*
 * One ranged GET. $range is a Range header value without the unit, e.g. '-4096' or '100-199'.
 * Returns the bytes, or null on any failure at all.
 */
function cm_fetch_range(string $url, string $range, int $timeout_s = 15): ?string
{
    $ch = curl_init($url);
    if ($ch === false) {
        return null;
    }
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 3,
        CURLOPT_CONNECTTIMEOUT => min(10, $timeout_s),
        CURLOPT_TIMEOUT        => $timeout_s,
        CURLOPT_USERAGENT      => CM_USER_AGENT,
        CURLOPT_RANGE          => $range,
        /* No Accept-Encoding: a range is a byte range of the STORED entity, and asking for
           it gzipped would hand back bytes whose offsets mean nothing here. */
    ]);
    $body = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);

    if (!is_string($body) || $body === '') {
        return null;
    }
    /* 206 is the contract. A 200 means the server ignored Range and is sending all 34 MB,
       which is both wrong for us and not worth reading. */
    if ($code !== 206) {
        return null;
    }
    return $body;
}

/*
 * Read one member out of a remote zip by name. Returns its bytes, or null.
 *
 * Deliberately minimal: enough of the zip format to find one small deflated file, and a
 * refusal on anything it does not fully understand (zip64, encryption, an unknown
 * compression method). This runs unattended against a third party's build process, so
 * "I am not sure" has to be a supported answer.
 */
function cm_zip_read_remote_member(string $url, string $member, int $timeout_s = 15): ?string
{
    $tail = cm_fetch_range($url, '-4096', $timeout_s);
    if ($tail === null) {
        return null;
    }

    $eocd = strrpos($tail, "PK\x05\x06");
    if ($eocd === false || strlen($tail) < $eocd + 22) {
        return null;
    }
    $sizes = unpack('Vsize/Voffset', substr($tail, $eocd + 12, 8));
    if ($sizes === false) {
        return null;
    }
    $cd_size   = (int) $sizes['size'];
    $cd_offset = (int) $sizes['offset'];
    /* 0xFFFFFFFF in either field means the real values live in a zip64 record. Bail. */
    if ($cd_size <= 0 || $cd_offset <= 0 || $cd_size === 0xFFFFFFFF || $cd_offset === 0xFFFFFFFF) {
        return null;
    }
    /* A GTFS central directory is a few hundred bytes. Anything huge is not what we expect. */
    if ($cd_size > 1048576) {
        return null;
    }

    $cd = cm_fetch_range($url, sprintf('%d-%d', $cd_offset, $cd_offset + $cd_size - 1), $timeout_s);
    if ($cd === null || strlen($cd) < $cd_size) {
        return null;
    }

    $p = 0;
    $found = null;
    while ($p + 46 <= strlen($cd) && substr($cd, $p, 4) === "PK\x01\x02") {
        $e = unpack(
            'vmethod/Vcsize/Vusize/vnlen/velen/vclen',
            substr($cd, $p + 10, 2) . substr($cd, $p + 20, 8) . substr($cd, $p + 28, 6)
        );
        if ($e === false) {
            return null;
        }
        $lho = unpack('V', substr($cd, $p + 42, 4));
        if ($lho === false) {
            return null;
        }
        $name = substr($cd, $p + 46, (int) $e['nlen']);
        if ($name === $member || str_ends_with($name, '/' . $member)) {
            $found = [
                'method' => (int) $e['method'],
                'csize'  => (int) $e['csize'],
                'usize'  => (int) $e['usize'],
                'lho'    => (int) $lho[1],
            ];
            break;
        }
        $p += 46 + (int) $e['nlen'] + (int) $e['elen'] + (int) $e['clen'];
    }

    if ($found === null || $found['csize'] <= 0 || $found['csize'] > 1048576) {
        return null;
    }
    /* Stored (0) and deflate (8) are the only methods GTFS producers use. */
    if ($found['method'] !== 0 && $found['method'] !== 8) {
        return null;
    }

    $start = $found['lho'];
    $end   = $start + 30 + CM_ZIP_LOCAL_HEADER_SLACK + $found['csize'];
    $blob  = cm_fetch_range($url, sprintf('%d-%d', $start, $end), $timeout_s);
    if ($blob === null || strlen($blob) < 30 || substr($blob, 0, 4) !== "PK\x03\x04") {
        return null;
    }
    /* The local header's own name and extra lengths, which may differ from the central
       directory's. Reading them from the central directory is a classic way to land a few
       bytes off and inflate garbage. */
    $loc = unpack('vnlen/velen', substr($blob, 26, 4));
    if ($loc === false) {
        return null;
    }
    $data_at = 30 + (int) $loc['nlen'] + (int) $loc['elen'];
    if (strlen($blob) < $data_at + $found['csize']) {
        return null;
    }
    $data = substr($blob, $data_at, $found['csize']);

    if ($found['method'] === 0) {
        return $data;
    }
    $raw = @gzinflate($data);
    return is_string($raw) && $raw !== '' ? $raw : null;
}

/*
 * Pull feed_version out of a feed_info.txt body. Returns null if the column is missing.
 *
 * A two-line CSV with quoted fields; str_getcsv is enough and there is no file to stream.
 */
function cm_parse_feed_info_version(string $csv): ?string
{
    $lines = preg_split('/\R/', trim($csv)) ?: [];
    if (count($lines) < 2) {
        return null;
    }
    $head = str_getcsv(ltrim($lines[0], "\xEF\xBB\xBF"), ',', '"', '\\');
    $row  = str_getcsv($lines[1], ',', '"', '\\');
    $i    = array_search('feed_version', array_map('trim', $head), true);
    if ($i === false || !isset($row[$i])) {
        return null;
    }
    $v = trim((string) $row[$i]);
    return $v === '' ? null : $v;
}

/*
 * The whole probe. Returns:
 *   ['ok' => true,  'feed_version' => '260826_0956']
 *   ['ok' => false, 'error' => '...']
 */
function cm_upstream_feed_version(string $url = CM_GTFS_ZIP_URL, int $timeout_s = 15): array
{
    $body = cm_zip_read_remote_member($url, 'feed_info.txt', $timeout_s);
    if ($body === null) {
        return ['ok' => false, 'error' => 'could not read feed_info.txt from the upstream zip'];
    }
    $version = cm_parse_feed_info_version($body);
    if ($version === null) {
        return ['ok' => false, 'error' => 'no feed_version column in upstream feed_info.txt'];
    }
    return ['ok' => true, 'feed_version' => $version];
}

/*
 * Decide, from the cached probe state, whether to ask again this run and what to believe.
 *
 * Pure: the caller owns the network call and the state file, so this stays testable and the
 * cadence logic is not buried in the cron script. $state is whatever was stored last time.
 *
 * Returns ['probe' => bool, 'upstream_version' => ?string, 'checked_at' => int].
 * upstream_version is null when nothing trustworthy is known, which the caller must treat
 * as "no opinion" rather than as a mismatch.
 */
function cm_upstream_probe_due(int $now, array $state): array
{
    $checked_at = (int) ($state['upstream_checked_at'] ?? 0);
    $ok         = (bool) ($state['upstream_ok'] ?? false);
    $version    = $state['upstream_feed_version'] ?? null;
    $version    = is_string($version) && $version !== '' ? $version : null;

    $ttl = $ok ? CM_UPSTREAM_TTL_S : CM_UPSTREAM_RETRY_S;
    $age = $now - $checked_at;

    return [
        'probe'            => $checked_at <= 0 || $age >= $ttl || $age < 0,
        'upstream_version' => $version,
        'checked_at'       => $checked_at,
    ];
}

/*
 * The comparison itself. Returns the upstream version when it is definitely a DIFFERENT
 * published feed from ours, and null in every other case: unknown upstream, unknown local,
 * or a match. Null means "no opinion", and no banner is raised on no opinion.
 */
function cm_schedule_superseded_by(?string $local_version, ?string $upstream_version): ?string
{
    if (!is_string($local_version) || $local_version === '' || $local_version === 'unknown') {
        return null;
    }
    if (!is_string($upstream_version) || $upstream_version === '') {
        return null;
    }
    return $local_version === $upstream_version ? null : $upstream_version;
}
