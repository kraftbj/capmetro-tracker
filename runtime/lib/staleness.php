<?php
/*
 * Staleness, api-contract.md section 1.
 *
 * The server decides; the client does not compute this. suppress_adherence is
 * authoritative: the client checks that flag, never the ages. Staleness is a rendered
 * state, not a log line, so every degraded run still produces a file that says so.
 *
 *   fresh   oldest feed age <= 120s
 *   aging   oldest feed age <= 600s
 *   stale   oldest feed age > 600s, or the schedule no longer covers today
 *   dead    oldest feed age > 3600s
 *
 * Two clocks, one level. The realtime feeds are the fast one and they set the level on
 * their own. The schedule is the slow one, and it used to set the level too: more than
 * seven days past feed_start_date forced `stale`, which suppressed lateness everywhere
 * and put "Data 14 sec old. Lateness is hidden until the feed catches up." on a board
 * whose positions were fourteen seconds old.
 *
 * That rule read schedule AGE as schedule DECAY, and for this agency the two are
 * unrelated: CapMetro republishes about three times a year, so feed_start_date is
 * routinely months behind while the timetable it carries is the current one and stays
 * valid until feed_end_date. Under the old rule the board spent all but the first week
 * of every feed suppressing lateness -- the one number it exists to show -- and saying
 * the feed was behind when nothing was.
 *
 * What actually invalidates adherence is a schedule that has RUN OUT: past
 * feed_end_date there is no timetable for today, so a lateness number is measured
 * against nothing. That is the condition now, and it is the same one health.json
 * already fails on. schedule_age_days is still reported, because "schedule 8 days old"
 * is a useful fact next to a banner; it just no longer raises one by itself.
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
 *
 * $schedule_expired_on is the feed_end_date (YYYYMMDD) when the service day being
 * generated falls past it, and null whenever the schedule still covers today. The caller
 * owns that comparison because it is the one holding the service date; passing the date
 * itself rather than a bare bool keeps the reason line able to name it.
 */
function cm_staleness(
    int $now,
    array $feed_times,
    int $schedule_age_days,
    ?string $schedule_expired_on = null
): array {
    $oldest = 0;
    $oldest_label = null;
    foreach ($feed_times as $label => $t) {
        $age = max(0, $now - (int) $t);
        if ($age >= $oldest) {
            $oldest = $age;
            $oldest_label = $label;
        }
    }

    $expired = is_string($schedule_expired_on)
        && preg_match('/^\d{8}$/', $schedule_expired_on) === 1;

    $level  = 'fresh';
    $reason = null;

    if ($oldest > CM_STALE_DEAD_S) {
        $level = 'dead';
        $reason = sprintf('No fresh data for %d minutes (%s feed)', intdiv($oldest, 60), $oldest_label);
    } elseif ($oldest > CM_STALE_STALE_S) {
        $level = 'stale';
        $reason = sprintf('%s feed is %d minutes old', $oldest_label, intdiv($oldest, 60));
    } elseif ($expired) {
        /* Checked before `aging` on purpose: an expired schedule is the worse of the two
           and a level is never lowered by a second condition. */
        $level = 'stale';
        $reason = sprintf('Schedule data ran out on %s', cm_staleness_human_date($schedule_expired_on));
    } elseif ($oldest > CM_STALE_AGING_S) {
        $level = 'aging';
        $reason = sprintf('%s feed is %ds old', $oldest_label, $oldest);
    }

    return [
        'level'              => $level,
        'oldest_feed_age_s'  => $oldest,
        'schedule_age_days'  => max(0, $schedule_age_days),
        'suppress_adherence' => $level === 'stale' || $level === 'dead',
        'reason'             => $reason,
    ];
}

/* 20270109 -> 2027-01-09. A date a reader has to parse is a date they will misread. */
function cm_staleness_human_date(string $yyyymmdd): string
{
    return substr($yyyymmdd, 0, 4) . '-' . substr($yyyymmdd, 4, 2) . '-' . substr($yyyymmdd, 6, 2);
}
