<?php
/*
 * Stop name shortening, api-contract.md section 7.
 *
 * Upstream names are long and parenthetical and clip mid-word on a 412px ladder. Every
 * generated file carries both stop_name (this function's output) and stop_name_full (the
 * upstream string). The transform is deterministic and applied strictly in order:
 *
 *   1. Drop a trailing parenthetical group.
 *   2. Drop a leading street number.
 *   3. Standardize the four compass suffixes.
 *   4. Normalize intercapped ordinals: upstream title-cases every word, so "8Th/Lavaca" and
 *      "48Th Half" arrive capitalized mid-token. Never changes length, so it is safe before
 *      truncation.
 *   5. If still over 24 characters, truncate at the last word boundary under 24 and
 *      append a horizontal ellipsis. Never truncate mid-word.
 *
 * The schema caps stop_name at 25 characters, which is 24 plus the one-character ellipsis.
 */

const CM_STOP_NAME_MAX = 24;

const CM_STOP_NAME_SUFFIXES = [
    'Northbound' => 'NB',
    'Southbound' => 'SB',
    'Eastbound'  => 'EB',
    'Westbound'  => 'WB',
];

function cm_shorten_stop_name(string $name): string
{
    $n = trim($name);

    /* 1. Trailing parenthetical group. */
    $n = trim((string) preg_replace('/\s*\([^)]*\)\s*$/u', '', $n));

    /* 2. Leading street number. */
    $stripped = (string) preg_replace('/^\d+\s+/u', '', $n);
    if ($stripped !== '') {
        $n = $stripped;
    }

    /* 3. Compass suffixes. */
    $n = strtr($n, CM_STOP_NAME_SUFFIXES);
    $n = trim((string) preg_replace('/\s+/u', ' ', $n));

    /*
     * 4. Intercapped ordinals. The lookbehind requires a digit with no intervening space, so
     * "Main St" and a bare "Nd" are untouched and only 8Th -> 8th, 2Nd -> 2nd, 3Rd -> 3rd,
     * 1St -> 1st and their multi-digit forms change. Case-sensitive, no other flags.
     */
    $n = (string) preg_replace_callback(
        '/(?<=[0-9])(St|Nd|Rd|Th)\b/',
        static fn(array $m): string => strtolower($m[1]),
        $n
    );

    if ($n === '') {
        /* Everything was stripped; fall back to the raw upstream name, hard-truncated. */
        $n = trim($name);
        if ($n === '') {
            return '';
        }
    }

    /* 5. Word-boundary truncation. */
    if (mb_strlen($n, 'UTF-8') <= CM_STOP_NAME_MAX) {
        return $n;
    }
    $head = mb_substr($n, 0, CM_STOP_NAME_MAX, 'UTF-8');
    $cut  = mb_strrpos($head, ' ', 0, 'UTF-8');
    if ($cut === false || $cut === 0) {
        /*
         * A single token longer than the budget. There is no word boundary to fall back
         * to, so cut one character short of the budget and mark it, keeping the result
         * inside the schema's 25-character cap.
         */
        $head = mb_substr($n, 0, CM_STOP_NAME_MAX - 1, 'UTF-8');
    } else {
        $head = mb_substr($head, 0, $cut, 'UTF-8');
    }
    return rtrim($head) . "\u{2026}";
}
