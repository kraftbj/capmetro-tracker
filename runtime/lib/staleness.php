<?php
/*
 * Staleness, api-contract.md section 1.
 *
 * The server decides; the client does not compute this. suppress_adherence is
 * authoritative: the client checks that flag, never the ages. Staleness is a rendered
 * state, not a log line, so every degraded run still produces a file that says so.
 *
 *   fresh   oldest feed age <= 120s and schedule_age_days <= 2
 *   aging   oldest feed age <= 600s
 *   stale   oldest feed age > 600s or schedule_age_days > 7
 *   dead    oldest feed age > 3600s
 *
 * Pure function. No I/O.
 */

const CM_STALE_AGING_S = 120;
const CM_STALE_STALE_S = 600;
const CM_STALE_DEAD_S  = 3600;

/*
 * $feed_times is a map of label => epoch, e.g. ['positions' => ..., 'trip_updates' => ...].
 * Ages are clamped at zero because a feed timestamp can legitimately sit a second or two
 * ahead of our own clock.
 */
function cm_staleness(int $now, array $feed_times, int $schedule_age_days): array
{
    $oldest = 0;
    $oldest_label = null;
    foreach ($feed_times as $label => $t) {
        $age = max(0, $now - (int) $t);
        if ($age >= $oldest) {
            $oldest = $age;
            $oldest_label = $label;
        }
    }

    $level  = 'fresh';
    $reason = null;

    if ($oldest > CM_STALE_DEAD_S) {
        $level = 'dead';
        $reason = sprintf('No fresh data for %d minutes (%s feed)', intdiv($oldest, 60), $oldest_label);
    } elseif ($oldest > CM_STALE_STALE_S || $schedule_age_days > 7) {
        $level = 'stale';
        $reason = $oldest > CM_STALE_STALE_S
            ? sprintf('%s feed is %d minutes old', $oldest_label, intdiv($oldest, 60))
            : sprintf('Schedule data is %d days old', $schedule_age_days);
    } elseif ($oldest > CM_STALE_AGING_S) {
        $level = 'aging';
        $reason = sprintf('%s feed is %ds old', $oldest_label, $oldest);
    } elseif ($schedule_age_days > 2) {
        $level = 'aging';
        $reason = sprintf('Schedule data is %d days old', $schedule_age_days);
    }

    return [
        'level'              => $level,
        'oldest_feed_age_s'  => $oldest,
        'schedule_age_days'  => max(0, $schedule_age_days),
        'suppress_adherence' => $level === 'stale' || $level === 'dead',
        'reason'             => $reason,
    ];
}
