<?php
/*
 * Service-day time resolution.
 *
 * GTFS clock strings are service-day relative and MAY exceed 24 hours: "25:10:00" is
 * 1:10am on the calendar day after the service date. Resolution therefore cannot use a
 * calendar timestamp for the clock string; it has to anchor on service-day midnight and
 * add seconds.
 *
 * Service-day midnight is computed as NOON on the service date in America/Chicago, minus
 * 12 hours. The naive form (construct 00:00:00 local, or midnight-UTC plus a fixed
 * offset) is wrong on the two DST transition days: on the spring-forward date 00:00 local
 * is a valid instant but the offset changes underneath every later clock string, and on
 * the fall-back date 01:xx is ambiguous. Noon always exists, is never ambiguous, and is
 * never within an hour of a US transition, so noon-minus-12h lands on the correct
 * instant, and adding raw seconds afterwards reproduces the wall-clock drift a rider
 * actually experiences.
 *
 * Pure functions only. No I/O, no globals, safe to require from tests.
 */

const CM_TZ = 'America/Chicago';

/*
 * Epoch seconds of service-day midnight for a GTFS date string (YYYYMMDD).
 * Returns null when the date is not a valid YYYYMMDD.
 */
function cm_service_day_midnight(string $service_date, string $tz = CM_TZ): ?int
{
    if (preg_match('/^\d{8}$/', $service_date) !== 1) {
        return null;
    }
    $zone = new DateTimeZone($tz);
    $noon = DateTimeImmutable::createFromFormat(
        'Ymd H:i:s',
        $service_date . ' 12:00:00',
        $zone
    );
    if ($noon === false) {
        return null;
    }
    /* Guard against createFromFormat silently rolling over an impossible date. */
    if ($noon->format('Ymd') !== $service_date) {
        return null;
    }
    return $noon->getTimestamp() - 12 * 3600;
}

/*
 * Seconds since service-day midnight for a GTFS clock string.
 * Accepts "H:MM:SS" and "HH:MM:SS" with hours >= 24. Returns null on malformed input.
 */
function cm_clock_to_seconds(string $clock): ?int
{
    if (preg_match('/^(\d{1,3}):([0-5]\d):([0-5]\d)$/', trim($clock), $m) !== 1) {
        return null;
    }
    return ((int) $m[1]) * 3600 + ((int) $m[2]) * 60 + ((int) $m[3]);
}

/*
 * Inverse of cm_clock_to_seconds. Hours are not wrapped at 24, so a 25:10:00 round trip
 * is stable. Used when a shard stores seconds and the contract wants a clock string.
 */
function cm_seconds_to_clock(int $seconds): string
{
    $h = intdiv($seconds, 3600);
    $m = intdiv($seconds % 3600, 60);
    $s = $seconds % 60;
    return sprintf('%02d:%02d:%02d', $h, $m, $s);
}

/*
 * Resolve a GTFS clock string on a service date to epoch seconds.
 * Returns null when either component is unparseable.
 */
function cm_clock_to_epoch(string $clock, string $service_date, string $tz = CM_TZ): ?int
{
    $secs = cm_clock_to_seconds($clock);
    $mid  = cm_service_day_midnight($service_date, $tz);
    if ($secs === null || $mid === null) {
        return null;
    }
    return $mid + $secs;
}

/*
 * The GTFS service date an instant belongs to.
 *
 * Trips that run past midnight belong to the previous service date, so any wall-clock
 * time before the cutover is attributed to the day before. In feed 260818_1456 the latest
 * scheduled arrival is 28:29:00 (4:29am) and the earliest first departure of a new
 * service date is 04:36:00, so the only exact cutover lies in that seven-minute window.
 * The default is 4:30am local.
 *
 * This function is only used to pick "today's" schedule for the whole run. Per-trip
 * resolution never uses it: both realtime feeds carry trip.startDate, which is the
 * agency's own statement of which service date a trip belongs to, and that is what the
 * join uses.
 */
function cm_service_date_for(int $epoch, string $tz = CM_TZ, int $cutover_seconds = 16200): string
{
    $dt = (new DateTimeImmutable('@' . $epoch))->setTimezone(new DateTimeZone($tz));
    $since_midnight = ((int) $dt->format('G')) * 3600
        + ((int) $dt->format('i')) * 60
        + ((int) $dt->format('s'));
    if ($since_midnight < $cutover_seconds) {
        $dt = $dt->sub(new DateInterval('P1D'));
    }
    return $dt->format('Ymd');
}

/*
 * weekday | saturday | sunday for a GTFS date string. The fourth day_type the contract
 * allows, "exception", is a property of the saved watch, not of the calendar, so it is
 * never returned here.
 */
function cm_day_type(string $service_date, string $tz = CM_TZ): ?string
{
    $mid = cm_service_day_midnight($service_date, $tz);
    if ($mid === null) {
        return null;
    }
    $dow = (int) (new DateTimeImmutable('@' . ($mid + 12 * 3600)))
        ->setTimezone(new DateTimeZone($tz))->format('w');
    if ($dow === 0) {
        return 'sunday';
    }
    if ($dow === 6) {
        return 'saturday';
    }
    return 'weekday';
}
