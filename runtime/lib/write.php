<?php
/*
 * Atomic writes and the cron lock, api-contract.md section 11.
 *
 * A client can be fetching /api/route/4.json at the exact instant cron rewrites it. The
 * only safe sequence is: write a temp file in the SAME directory (rename is atomic only
 * within a filesystem), flush userland buffers, fsync the descriptor so the bytes are on
 * disk and not merely in the page cache, then rename over the target. A reader gets the
 * old complete file or the new complete file and never a torn one.
 *
 * A flock on a separate lock file keeps a slow run from interleaving with the next one.
 * cron will happily start a second copy at 60 seconds regardless of whether the first
 * finished.
 */

/*
 * Take the cron lock. Returns the open handle to hold for the life of the process, or
 * null when another run already holds it. The caller must keep the handle in scope; the
 * lock releases when the handle closes or the process exits.
 */
function cm_acquire_lock(string $lock_path)
{
    $dir = dirname($lock_path);
    if (!is_dir($dir) && !mkdir($dir, 0o775, true) && !is_dir($dir)) {
        return null;
    }
    $fh = fopen($lock_path, 'c');
    if ($fh === false) {
        return null;
    }
    if (!flock($fh, LOCK_EX | LOCK_NB)) {
        fclose($fh);
        return null;
    }
    return $fh;
}

function cm_release_lock($fh): void
{
    if (is_resource($fh)) {
        flock($fh, LOCK_UN);
        fclose($fh);
    }
}

/*
 * Write $bytes to $path atomically. Returns true on success.
 *
 * The temp file is created in the destination directory so the rename never crosses a
 * filesystem boundary. On any failure the temp file is removed and $path is left exactly
 * as it was, which is the contract's "a failed run never writes a partial or empty file".
 */
function cm_atomic_write(string $path, string $bytes, int $mode = 0o644): bool
{
    $dir = dirname($path);
    if (!is_dir($dir) && !mkdir($dir, 0o775, true) && !is_dir($dir)) {
        return false;
    }
    $tmp = $dir . '/.' . basename($path) . '.tmp.' . getmypid();
    $fh = fopen($tmp, 'wb');
    if ($fh === false) {
        return false;
    }
    $ok = true;
    if (fwrite($fh, $bytes) !== strlen($bytes)) {
        $ok = false;
    }
    if ($ok && !fflush($fh)) {
        $ok = false;
    }
    if ($ok && function_exists('fsync') && !fsync($fh)) {
        $ok = false;
    }
    fclose($fh);
    if (!$ok) {
        @unlink($tmp);
        return false;
    }
    @chmod($tmp, $mode);
    if (!rename($tmp, $path)) {
        @unlink($tmp);
        return false;
    }
    return true;
}

/*
 * Encode and write. Refuses to write anything that failed to encode, so a json_encode
 * error can never truncate a live endpoint.
 */
function cm_atomic_write_json(string $path, $doc): bool
{
    $json = json_encode($doc, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false || $json === '') {
        return false;
    }
    return cm_atomic_write($path, $json . "\n");
}

/*
 * Write a document only when it says something the file on disk does not already say,
 * ignoring the fields listed in $volatile.
 *
 * The schedule endpoints are a pure function of the GTFS publication and the service
 * date. Their only field that moves between runs is `generated_at`, so writing them on
 * every poll rewrites 2.8 MB of identical bytes every sixty seconds: 3.9 GB a day, on a
 * VPS SSD, for data CapMetro changes about three times a year.
 *
 * When nothing substantive changed the old file is LEFT ALONE, `generated_at` and all.
 * That is the honest reading of the field for a schedule document: it is when this
 * schedule was generated, not when the cron last woke up. `/api/health.json` is where a
 * reader looks to find out whether the cron is alive, and it is written every run.
 *
 * Returns true when the file is correct afterwards, whether or not this call wrote it,
 * because the caller's question is "is the endpoint right" and not "did I do work".
 */
function cm_atomic_write_json_if_changed(string $path, array $doc, array $volatile = ['generated_at']): bool
{
    $existing = @file_get_contents($path);
    if ($existing !== false) {
        $old = json_decode($existing, true);
        if (is_array($old)) {
            $a = $doc;
            $b = $old;
            foreach ($volatile as $key) {
                unset($a[$key], $b[$key]);
            }
            /*
             * Compared as encoded strings rather than with ==, because PHP's loose array
             * comparison would call 0 and "0" equal and silently skip a real change of
             * type. A strict === on arrays is order-sensitive for string keys, which is
             * also wrong here; the encoder gives a canonical form for both.
             */
            if (json_encode($a) === json_encode($b)) {
                return true;
            }
        }
    }
    return cm_atomic_write_json($path, $doc);
}
