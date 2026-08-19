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
 *   5. If still over 25 characters (the schema cap), truncate at the last boundary under 24
 *      and append a horizontal ellipsis. A boundary is a space OR a slash. Never truncate
 *      mid-word.
 *
 * The schema caps stop_name at 25 characters, which is 24 plus the one-character ellipsis.
 */

/*
 * CM_STOP_NAME_CAP is the schema cap and decides whether a name needs truncating at all.
 * CM_STOP_NAME_MAX is the smaller budget for the stem once an ellipsis is appended (24 + 1 = 25).
 * Conflating the two truncated names that already fit.
 */
const CM_STOP_NAME_CAP = 25;
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

    /*
     * A name that already fits the schema cap is returned untouched. CM_STOP_NAME_CAP is that
     * cap; the smaller CM_STOP_NAME_MAX is the budget for the STEM once an ellipsis has to be
     * appended. Testing the stem budget here instead of the cap truncated 13 real stops that
     * fit exactly, turning "Bluff Springs/BitterCreek" into "Bluff...".
     */
    if (mb_strlen($n, 'UTF-8') <= CM_STOP_NAME_CAP) {
        return $n;
    }

    /*
     * Austin stop names are "Street/CrossStreet" with no space around the slash, so a space is
     * often the wrong and sometimes the only boundary: "Pleasant Valley/Turnstone" has one
     * space, at index 8. Break on a slash too, and keep the slash so the cut reads as a
     * deliberate stop short of the cross street.
     */
    /*
     * Budgets differ by boundary kind because the kept text differs. Cutting AT a space drops
     * it, so a space at index i keeps i characters and i may reach CM_STOP_NAME_MAX. A slash is
     * kept, so a slash at index i keeps i + 1 characters and i must stop one earlier. Searching
     * only the first CM_STOP_NAME_MAX characters missed a space sitting exactly on the budget
     * and needlessly dropped a whole cross street.
     */
    $spaceWindow = mb_substr($n, 0, CM_STOP_NAME_MAX + 1, 'UTF-8');
    $slashWindow = mb_substr($n, 0, CM_STOP_NAME_MAX, 'UTF-8');
    $lastSpace   = mb_strrpos($spaceWindow, ' ', 0, 'UTF-8');
    $lastSlash   = mb_strrpos($slashWindow, '/', 0, 'UTF-8');
    if ($lastSlash !== false && $lastSlash > 0 && ($lastSpace === false || $lastSlash > $lastSpace)) {
        $head = mb_substr($n, 0, $lastSlash + 1, 'UTF-8');
    } elseif ($lastSpace !== false && $lastSpace > 0) {
        $head = mb_substr($n, 0, $lastSpace, 'UTF-8');
    } else {
        /*
         * A single token longer than the budget. There is no boundary to fall back to, so cut
         * one character short of the budget and mark it, keeping the result inside the cap.
         */
        $head = mb_substr($n, 0, CM_STOP_NAME_MAX - 1, 'UTF-8');
    }
    return rtrim($head) . "\u{2026}";
}
