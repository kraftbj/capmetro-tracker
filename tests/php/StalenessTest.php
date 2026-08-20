<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Fixtures;
use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * Silent failure 2 and contract section 1: staleness is a rendered state.
 *
 * The failure mode is not an exception. It is a webroot full of well-formed
 * JSON whose numbers stopped being true forty minutes ago. The server decides,
 * the client obeys the flag, and health.json makes it checkable without opening
 * the app.
 */
final class StalenessTest extends TestCase
{
    private const FILES = ['runtime/lib/staleness.php'];
    private const NOW = 1787152239;

    protected function setUp(): void
    {
        Runtime::functionsOrSkip($this, ['cm_staleness'], self::FILES);
    }

    private function atAge(int $age, int $scheduleAgeDays = 1): array
    {
        return cm_staleness(self::NOW, ['positions' => self::NOW - $age], $scheduleAgeDays);
    }

    #[DataProvider('levels')]
    public function testGradesFeedAgeIntoTheLevelTheContractSpecifies(
        int $age,
        int $scheduleAgeDays,
        string $expectedLevel,
        bool $expectedSuppress
    ): void {
        $result = $this->atAge($age, $scheduleAgeDays);

        self::assertSame($expectedLevel, $result['level']);
        self::assertSame($expectedSuppress, $result['suppress_adherence']);
        self::assertSame($age, $result['oldest_feed_age_s']);
    }

    /** @return iterable<string, array{int, int, string, bool}> */
    public static function levels(): iterable
    {
        yield 'a feed 43 seconds old on a one-day-old schedule' => [43, 1, 'fresh', false];
        yield 'the fresh boundary at 120 seconds' => [120, 1, 'fresh', false];
        yield 'one second past fresh' => [121, 1, 'aging', false];
        yield 'the aging boundary at 600 seconds' => [600, 1, 'aging', false];
        yield 'one second past aging' => [601, 1, 'stale', true];
        yield 'the stale boundary at 3600 seconds' => [3600, 1, 'stale', true];
        yield 'one second past stale' => [3601, 1, 'dead', true];
        yield 'a fresh feed on a two-day-old schedule' => [43, 2, 'fresh', false];
        yield 'a fresh feed on an eight-day-old schedule' => [43, 8, 'stale', true];
    }

    public function testTakesTheOldestOfSeveralFeedsRatherThanTheNewest(): void
    {
        $result = cm_staleness(self::NOW, [
            'positions' => self::NOW - 5,
            'trip_updates' => self::NOW - 900,
            'alerts' => self::NOW - 60,
        ], 1);

        self::assertSame(900, $result['oldest_feed_age_s']);
        self::assertTrue($result['suppress_adherence']);
    }

    public function testNamesWhichFeedIsOldSoTheReasonIsActionable(): void
    {
        $result = cm_staleness(self::NOW, [
            'positions' => self::NOW - 5,
            'trip_updates' => self::NOW - 900,
        ], 1);

        self::assertStringContainsString('trip_updates', (string) $result['reason']);
    }

    public function testNamesAReasonWheneverTheLevelIsNotFresh(): void
    {
        foreach ([700, 4000, 200] as $age) {
            $result = $this->atAge($age);

            self::assertNotSame('fresh', $result['level']);
            self::assertIsString($result['reason'], 'a degraded state with no reason is a blank error message');
            self::assertNotSame('', $result['reason']);
        }

        self::assertNull($this->atAge(43)['reason']);
    }

    public function testSuppressesAdherenceOnScheduleAgeAloneEvenWhenTheRealtimeFeedsAreFresh(): void
    {
        // The stale-shard case wearing a different hat: positions keep arriving,
        // so nothing looks broken, but the schedule they are compared against is
        // three weeks out of date.
        $result = $this->atAge(43, 21);

        self::assertTrue($result['suppress_adherence']);
        self::assertStringContainsString('Schedule', (string) $result['reason']);
    }

    public function testClampsAFeedTimestampThatRunsAheadOfOurOwnClockToZeroRatherThanNegative(): void
    {
        $result = cm_staleness(self::NOW, ['positions' => self::NOW + 3], 1);

        self::assertSame(0, $result['oldest_feed_age_s']);
        self::assertSame('fresh', $result['level']);
    }

    public function testGradesTheFrozenUpstreamFixtureAsDeadEvenThoughItAnsweredWithHttpTwoHundred(): void
    {
        $frozen = Fixtures::synthetic('frozen-feed-response.json');
        $age = $frozen['_now'] - (int) $frozen['body']['header']['timestamp'];

        $result = cm_staleness($frozen['_now'], ['positions' => (int) $frozen['body']['header']['timestamp']], 1);

        self::assertSame(200, $frozen['http_status'], 'the upstream is still answering; that is the trap');
        self::assertSame($frozen['_expected']['oldest_feed_age_s'], $age);
        self::assertSame($frozen['_expected']['staleness_level'], $result['level']);
        self::assertTrue($result['suppress_adherence']);
    }

    public function testGradesTheCapturedMinuteAsFreshSoTheThresholdIsNotSimplyAlwaysOn(): void
    {
        $golden = Fixtures::goldenRoute4();

        $result = cm_staleness($golden['generated_at'], [
            'positions' => $golden['feeds']['positions_at'],
            'trip_updates' => $golden['feeds']['trip_updates_at'],
            'alerts' => $golden['feeds']['alerts_at'],
        ], $golden['staleness']['schedule_age_days']);

        self::assertSame($golden['staleness']['level'], $result['level']);
        self::assertFalse($result['suppress_adherence']);

        /*
         * The age is the OLDEST of all three feeds, alerts included. This used
         * to assert a literal 100s, which was the gap between the true oldest
         * and the 43s a hand-made golden file recorded because its throwaway
         * generator only weighed the two realtime feeds. The fixture is real
         * generated output now and the two agree, so pinning the number would
         * pin a coincidence. The invariant is what matters: a lagging alerts
         * feed must register, so the oldest of the three is the one that counts.
         */
        $oldest = min(
            $golden['feeds']['positions_at'],
            $golden['feeds']['trip_updates_at'],
            $golden['feeds']['alerts_at']
        );
        self::assertSame($golden['generated_at'] - $oldest, $result['oldest_feed_age_s']);
        self::assertSame($golden['staleness']['oldest_feed_age_s'], $result['oldest_feed_age_s']);
    }

    public function testTheDeadCronFixtureCarriesTheShapeADegradedRouteFileMustHave(): void
    {
        $dead = Fixtures::synthetic('route-4-dead-cron.json');

        self::assertTrue($dead['staleness']['suppress_adherence']);
        self::assertSame('dead', $dead['staleness']['level']);
        self::assertIsString($dead['staleness']['reason']);
        self::assertGreaterThan(600, $dead['_expected']['generated_at_age_s']);

        foreach ($dead['vehicles'] as $vehicle) {
            self::assertNull($vehicle['adherence']['seconds'], 'a suppressed file still carries a lateness number');
            if ($vehicle['in_service']) {
                self::assertSame('unknown', $vehicle['adherence']['state']);
                self::assertSame('stale_data', $vehicle['adherence']['reason']);
            }
        }
    }
}
