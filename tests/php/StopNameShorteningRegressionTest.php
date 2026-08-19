<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use PHPUnit\Framework\TestCase;

/**
 * Regression: ISSUE-001 and ISSUE-002 — stop name shortening.
 * Found by /qa on 2026-08-19.
 * Report: .gstack/qa-reports/qa-report-capmetro-tracker-2026-08-19.md
 *
 * The PHP half of the pair. build/lib/stop-names.mjs writes stop_name for static ladder rows
 * and this writes it for live vehicle rows, so the two must agree character for character or
 * one stop renders two ways on one screen. A differential run over all 2,326 upstream names
 * caught exactly that: PHP normalized intercapped ordinals and Node did not.
 *
 * These cases are the same ones asserted in tests/node/build-stops.regression-1.test.mjs.
 */
final class StopNameShorteningRegressionTest extends TestCase
{
    private const CAP = 25;

    public static function setUpBeforeClass(): void
    {
        require_once dirname(__DIR__, 2) . '/runtime/lib/stopnames.php';
    }

    /**
     * @return array<string, array{string}>
     */
    public static function alreadyFits(): array
    {
        return [
            'Pleasant Valley/Turnstone' => ['Pleasant Valley/Turnstone'],
            'Bluff Springs/BitterCreek' => ['Bluff Springs/BitterCreek'],
            'William Cannon/Branchwood' => ['William Cannon/Branchwood'],
            'Norwood Park/Brettonwoods' => ['Norwood Park/Brettonwoods'],
            'Esperanza Crossing/Domain' => ['Esperanza Crossing/Domain'],
        ];
    }

    /**
     * @dataProvider alreadyFits
     */
    public function testANameThatFitsTheCapIsNeverTruncated(string $name): void
    {
        self::assertSame(self::CAP, mb_strlen($name, 'UTF-8'), 'fixture must be exactly at the cap');
        self::assertSame($name, cm_shorten_stop_name($name));
    }

    /**
     * @return array<string, array{string, string}>
     */
    public static function truncations(): array
    {
        return [
            'slash when the cross street will not fit' => ['Pleasant Valley/Webberville', 'Pleasant Valley/…'],
            'keeps a segment when a space lands on the budget' => ['Convict Hill/Latta/Brush Country', 'Convict Hill/Latta/Brush…'],
            'prefers the later space boundary' => ['Lamplight Village/Metric NW Corner', 'Lamplight Village/Metric…'],
            'never a lone word plus ellipsis' => ['Overton Driveway/Overton Driveway', 'Overton Driveway/Overton…'],
        ];
    }

    /**
     * @dataProvider truncations
     */
    public function testTruncationBreaksOnASlashNotOnlyASpace(string $name, string $expected): void
    {
        self::assertSame($expected, cm_shorten_stop_name($name));
    }

    /**
     * @return array<string, array{string, string}>
     */
    public static function ordinals(): array
    {
        return [
            '8Th'  => ['216 8Th/Lavaca', '8th/Lavaca'],
            '7Th'  => ['115 7Th/Colorado', '7th/Colorado'],
            '5Th'  => ['500 Guadalupe/5Th', 'Guadalupe/5th'],
            '51St' => ['5012 Airport/51St', 'Airport/51st'],
            '53Rd' => ['Airport/53Rd', 'Airport/53rd'],
            '11Th' => ['509 11Th/Red River', '11th/Red River'],
        ];
    }

    /**
     * @dataProvider ordinals
     */
    public function testIntercappedOrdinalsAreNormalized(string $name, string $expected): void
    {
        self::assertSame($expected, cm_shorten_stop_name($name));
    }

    public function testAStreetSuffixThatIsNotAnOrdinalSurvives(): void
    {
        self::assertSame('Main St/Oak', cm_shorten_stop_name('Main St/Oak'));
    }

    public function testEveryOutputStaysInsideTheSchemaCap(): void
    {
        foreach (self::truncations() as [$name, $_]) {
            self::assertLessThanOrEqual(self::CAP, mb_strlen(cm_shorten_stop_name($name), 'UTF-8'), $name);
        }
        self::assertLessThanOrEqual(
            self::CAP,
            mb_strlen(cm_shorten_stop_name('Averyabsurdlylongsingletokenwithnoboundaryatall'), 'UTF-8')
        );
    }

    public function testANameThatIsOnlyANumberIsNotEmptied(): void
    {
        self::assertSame('12345', cm_shorten_stop_name('12345'));
    }
}
