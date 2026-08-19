<?php
/*
 * The adherence decision table from api-contract.md section 2.
 *
 * Ten ordered rows, first match wins. Nothing here fetches, reads a file, or looks at the
 * clock: every input arrives as an argument so the table can be exercised row by row from
 * a test.
 *
 * The upstream feed has no delay field. Lateness is always predicted minus scheduled, and
 * scheduled comes from the GTFS schedule shard joined on (trip_id, stop_sequence).
 */

const CM_ADHERENCE_GLYPHS = [
    'early'     => 'left-triangle',
    'ontime'    => 'circle',
    'late'      => 'up-triangle',
    'very_late' => 'square',
    'unknown'   => 'question',
    'deadhead'  => 'ring',
];

function cm_adherence_glyph(string $state): string
{
    return CM_ADHERENCE_GLYPHS[$state] ?? 'question';
}

/*
 * Rows 7 through 10 of the table: the numeric bands.
 * Negative is early, positive is late; both are signed seconds.
 */
function cm_adherence_classify(int $seconds): string
{
    if ($seconds < -60) {
        return 'early';
    }
    if ($seconds <= 150) {
        return 'ontime';
    }
    if ($seconds <= 360) {
        return 'late';
    }
    return 'very_late';
}

/*
 * Pick the stopTimeUpdate the lateness is measured against.
 *
 * "The first stop in the trip update whose stopSequence >= current_stop_sequence, skipping
 * any entry whose scheduleRelationship is SKIPPED and any entry with neither an arrival
 * nor a departure time. When both arrival and departure are present, arrival wins."
 *
 * Returns ['stop_sequence' => int, 'stop_id' => ?string, 'predicted_at' => int] or null.
 * Entries are sorted by stopSequence first so a feed that emits them out of order still
 * yields the first stop ahead of the bus rather than the first array element.
 */
function cm_adherence_pick_anchor(array $stop_time_updates, int $current_stop_sequence): ?array
{
    $candidates = [];
    foreach ($stop_time_updates as $stu) {
        if (!is_array($stu)) {
            continue;
        }
        $seq = $stu['stopSequence'] ?? null;
        if ($seq === null) {
            continue;
        }
        $seq = (int) $seq;
        if ($seq < $current_stop_sequence) {
            continue;
        }
        if (($stu['scheduleRelationship'] ?? 'SCHEDULED') === 'SKIPPED') {
            continue;
        }
        /* Arrival wins when both are present. */
        $time = $stu['arrival']['time'] ?? $stu['departure']['time'] ?? null;
        if ($time === null || $time === '') {
            continue;
        }
        $candidates[] = [
            'stop_sequence' => $seq,
            'stop_id'       => isset($stu['stopId']) ? (string) $stu['stopId'] : null,
            'predicted_at'  => (int) $time,
        ];
    }
    if ($candidates === []) {
        return null;
    }
    usort($candidates, static fn($a, $b) => $a['stop_sequence'] <=> $b['stop_sequence']);
    return $candidates[0];
}

/*
 * Evaluate the full table.
 *
 * $in accepts:
 *   in_service            bool
 *   schedule_relationship string|null   from the positions feed trip descriptor
 *   trip_update           array|null    the matching tripUpdate, or null when there is none
 *   trip_in_schedule      bool          trip_id present in the schedule shard
 *   suppress_adherence    bool          from staleness; authoritative
 *   current_stop_sequence int|null
 *   scheduled             array         stop_sequence => ['stop_id','stop_name','scheduled_at']
 *
 * Returns the contract's adherence object: state, seconds, glyph, against, reason.
 */
function cm_adherence_evaluate(array $in): array
{
    $unknown = static function (string $reason): array {
        return [
            'state'   => 'unknown',
            'seconds' => null,
            'glyph'   => cm_adherence_glyph('unknown'),
            'against' => null,
            'reason'  => $reason,
        ];
    };

    /* Row 1 */
    if (empty($in['in_service'])) {
        return [
            'state'   => 'deadhead',
            'seconds' => null,
            'glyph'   => cm_adherence_glyph('deadhead'),
            'against' => null,
            'reason'  => null,
        ];
    }

    /* Row 2 -- CANCELED on either the positions trip descriptor or the trip update. */
    $tu = $in['trip_update'] ?? null;
    $rel = $in['schedule_relationship'] ?? 'SCHEDULED';
    $tu_rel = is_array($tu) ? ($tu['trip']['scheduleRelationship'] ?? 'SCHEDULED') : 'SCHEDULED';
    if ($rel === 'CANCELED' || $tu_rel === 'CANCELED') {
        return $unknown('trip_canceled');
    }

    /* Row 3 */
    if (!is_array($tu)) {
        return $unknown('no_trip_update');
    }

    /* Row 4 */
    $stus = $tu['stopTimeUpdate'] ?? null;
    if (!is_array($stus) || $stus === []) {
        return $unknown('no_stop_predictions');
    }

    /* Row 5 */
    if (empty($in['trip_in_schedule'])) {
        return $unknown('trip_not_in_schedule');
    }

    /* Row 6 -- staleness is authoritative and outranks any number we could compute. */
    if (!empty($in['suppress_adherence'])) {
        return $unknown('stale_data');
    }

    /* Row 6b -- with no current stop sequence the comparison has no anchor. */
    $css = $in['current_stop_sequence'] ?? null;
    if ($css === null) {
        return $unknown('no_progress');
    }

    $scheduled = $in['scheduled'] ?? [];
    $anchor = cm_adherence_pick_anchor($stus, (int) $css);
    if ($anchor === null || !isset($scheduled[$anchor['stop_sequence']])) {
        /*
         * Either every remaining prediction was skipped or timeless, or the shard has no
         * scheduled time at that sequence. Both mean the same thing to a reader: there is
         * no usable stop prediction to measure against.
         */
        return $unknown('no_stop_predictions');
    }

    $sched = $scheduled[$anchor['stop_sequence']];
    $seconds = $anchor['predicted_at'] - (int) $sched['scheduled_at'];
    $state = cm_adherence_classify($seconds);

    return [
        'state'   => $state,
        'seconds' => $seconds,
        'glyph'   => cm_adherence_glyph($state),
        'against' => [
            'stop_id'       => (string) $sched['stop_id'],
            'stop_name'     => (string) $sched['stop_name'],
            'stop_sequence' => (int) $anchor['stop_sequence'],
            'scheduled_at'  => (int) $sched['scheduled_at'],
            'predicted_at'  => (int) $anchor['predicted_at'],
        ],
        'reason'  => null,
    ];
}
