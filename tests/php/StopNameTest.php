<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Fixtures;
use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\TestCase;

/**
 * Contract section 7 and acceptance criterion 10: stop-name shortening.
 *
 * Four ordered rules. The one that matters visually is the last: a label may be
 * truncated, but never mid-word, because "UT Stadium SB (San Jacin" is worse on
 * a 412px ladder than an honestly shorter name.
 */
final class StopNameTest extends TestCase
{
    private const FILES = ['runtime/lib/stopnames.php'];

    protected function setUp(): void
    {
        Runtime::functionsOrSkip($this, ['cm_shorten_stop_name'], self::FILES);
    }

    public function testDropsATrailingParentheticalGroup(): void
    {
        self::assertSame('Dove Springs NB', cm_shorten_stop_name('Dove Springs NB (Pleasant Valley/Stassney)'));
    }

    public function testDropsALeadingStreetNumber(): void
    {
        self::assertSame('7th/Shady', cm_shorten_stop_name('4999 7th/Shady'));
    }

    public function testStandardisesTheFourSpelledOutCompassSuffixes(): void
    {
        self::assertSame('Simond SB', cm_shorten_stop_name('Simond Southbound'));
        self::assertSame('Lamar NB', cm_shorten_stop_name('Lamar Northbound'));
        self::assertSame('7th EB', cm_shorten_stop_name('7th Eastbound'));
        self::assertSame('Mopac WB', cm_shorten_stop_name('Mopac Westbound'));
    }

    public function testDropsTheParentheticalBeforeMeasuringLengthRatherThanAfter(): void
    {
        // Rule order matters: measuring first would truncate a name the
        // parenthetical drop would have made short enough on its own.
        self::assertStringNotContainsString("\u{2026}", cm_shorten_stop_name('Dove Springs NB (Pleasant Valley/Stassney)'));
    }

    public function testLeavesAShortNameExactlyAsItFoundIt(): void
    {
        self::assertSame('5th/Bowie', cm_shorten_stop_name('5th/Bowie'));
    }

    /**
     * A truncated name ends mid-word when its last surviving token is not a
     * whole word of the name it came from. "Pleasant Valley at\u{2026}" is fine;
     * "UT Stadium SB (San Jacin\u{2026}" is the failure the rule exists to prevent.
     */
    private function assertNotTruncatedMidWord(string $full, string $short): void
    {
        self::assertLessThanOrEqual(25, mb_strlen($short), "\"{$short}\" exceeds the schema cap");

        if (!str_ends_with($short, "\u{2026}")) {
            return;
        }

        /*
         * Rules 1 to 3 rewrite tokens before rule 4 truncates, so the comparison
         * has to be against the rewritten name. Restating those three rules here
         * rather than reusing the implementation keeps the check independent.
         */
        $normalized = trim((string) preg_replace('/\s*\([^)]*\)\s*$/u', '', trim($full)));
        $normalized = trim((string) preg_replace('/^\d+\s+/u', '', $normalized));
        $normalized = strtr($normalized, [
            'Northbound' => 'NB',
            'Southbound' => 'SB',
            'Eastbound' => 'EB',
            'Westbound' => 'WB',
        ]);

        $head = rtrim(mb_substr($short, 0, -1), ' ');
        $tokens = preg_split('/\s+/u', $head) ?: [];
        $last = (string) end($tokens);

        self::assertNotSame('', $last, "\"{$short}\" truncated to nothing");
        self::assertMatchesRegularExpression(
            '/(?<![^\s])' . preg_quote($last, '/') . '(?![^\s])/u',
            $normalized,
            "\"{$short}\" ends mid-word: \"{$last}\" is not a whole word of \"{$normalized}\""
        );
    }

    public function testNeverEndsANameMidWord(): void
    {
        foreach ([
            'UT Stadium SB (San Jacinto/Martin Luther King)',
            'Pleasant Valley at Stassney Lane Transfer Center Bay Three',
            'Highland Station Northbound Platform Two',
        ] as $input) {
            $this->assertNotTruncatedMidWord($input, cm_shorten_stop_name($input));
        }
    }

    public function testMarksATruncatedNameSoTheUserKnowsItWasCut(): void
    {
        $out = cm_shorten_stop_name('Pleasant Valley at Stassney Lane Transfer Center Bay Three');

        self::assertStringEndsWith("\u{2026}", $out);
        self::assertDoesNotMatchRegularExpression('/\s\x{2026}$/u', $out, 'a dangling space before the ellipsis');
    }

    public function testIsDeterministicBecauseShardRebuildsMustBeByteIdenticalWhenNothingChanged(): void
    {
        $input = 'Pleasant Valley at Stassney Lane Transfer Center Bay Three';

        self::assertSame(cm_shorten_stop_name($input), cm_shorten_stop_name($input));
    }

    public function testHandlesASingleTokenLongerThanTheBudgetWithoutBlowingTheSchemaCap(): void
    {
        $out = cm_shorten_stop_name('Supercalifragilisticexpialidocious');

        self::assertLessThanOrEqual(25, mb_strlen($out));
    }

    public function testNeverReturnsAnEmptyNameEvenWhenEveryRuleStripsSomething(): void
    {
        foreach (['4999 (closed)', '(temporarily closed)', '12345'] as $input) {
            self::assertNotSame('', cm_shorten_stop_name($input), "\"{$input}\" was reduced to nothing");
        }
    }

    public function testEveryNameAlreadyInTheGoldenOutputSurvivesItsOwnRule(): void
    {
        $names = [];
        foreach (Fixtures::goldenRoute4()['timepoints'] as $timepoint) {
            $names[$timepoint['stop_name']] = $timepoint['stop_name_full'];
            foreach ($timepoint['minor_stops'] as $minor) {
                $names[$minor['stop_name']] = null;
            }
        }

        self::assertNotEmpty($names);
        foreach ($names as $short => $full) {
            self::assertLessThanOrEqual(25, mb_strlen((string) $short), "\"{$short}\" exceeds the schema cap");
            if ($full !== null) {
                $this->assertNotTruncatedMidWord((string) $full, (string) $short);
                self::assertSame($short, cm_shorten_stop_name($full), "shortening \"{$full}\" no longer yields \"{$short}\"");
            }
        }
    }
}
