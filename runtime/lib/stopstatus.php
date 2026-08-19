<?php
/*
 * Stop service status precedence, api-contract.md section 3.
 *
 * Three independent sources say a stop is not served and they disagree, so they are
 * ranked. Measured on the 2026-08-19 capture: 172 realtime SKIPPED events across 5 stops,
 * 38 stops under a NO_SERVICE alert, and only 1 stop in both sets. They are genuinely
 * independent signals, not a hierarchy of confidence in the same event.
 *
 *   1  realtime_skipped   this trip skips this stop, right now
 *   2  alert_no_service   the stop is closed, all trips
 *   3  pattern_skip       scheduled variation omits it
 *   -  null               served normally
 *
 * Highest priority wins. Counts in `detail` are over the trips of the current service date
 * present in the live trip updates feed at generated_at (section 3.1), so the number moves
 * during the day. That is intended: it answers "how much is this happening today".
 *
 * Pure function. No I/O.
 */

function cm_stop_service_status(
    int $realtime_skip_count = 0,
    bool $alert_no_service = false,
    bool $pattern_skip = false,
    ?string $pattern_skip_detail = null
): array {
    if ($realtime_skip_count > 0) {
        return [
            'served' => false,
            'source' => 'realtime_skipped',
            'detail' => sprintf(
                'Skipped on %d trip%s today',
                $realtime_skip_count,
                $realtime_skip_count === 1 ? '' : 's'
            ),
        ];
    }
    if ($alert_no_service) {
        return [
            'served' => false,
            'source' => 'alert_no_service',
            'detail' => 'Stop closed by service alert',
        ];
    }
    if ($pattern_skip) {
        return [
            'served' => false,
            'source' => 'pattern_skip',
            'detail' => $pattern_skip_detail ?? 'Not on any pattern running today',
        ];
    }
    return ['served' => true, 'source' => null, 'detail' => null];
}
