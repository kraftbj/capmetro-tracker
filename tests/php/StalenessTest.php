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

    private function atAge(int $age, int $scheduleAgeDays = 1, ?string $expiredOn = null): array
    {
        return cm_staleness(self::NOW, ['positions' => self::NOW - $age], $scheduleAgeDays, $expiredOn);
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
        /*
         * The bug this pair pins. CapMetro republishes about three times a year, so
         * these two schedule ages are what an ordinary healthy week and an ordinary
         * healthy November look like. Both used to force `stale`, which suppressed
         * every lateness number on the board and captioned it "Data 43 sec old.
         * Lateness is hidden until the feed catches up." about a feed that was
         * forty-three seconds old and arriving on time.
         */
        yield 'a fresh feed on an eight-day-old schedule' => [43, 8, 'fresh', false];
        yield 'a fresh feed on a schedule published four months ago' => [43, 121, 'fresh', false];
        yield 'a schedule old enough to have been aging, with a fresh feed' => [43, 3, 'fresh', false];
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

    public function testSuppressesAdherenceWhenTheScheduleHasRunOutEvenThoughTheFeedsAreFresh(): void
    {
        // The stale-shard case wearing a different hat: positions keep arriving, so
        // nothing looks broken, but the timetable they are graded against ended --
        // there is no scheduled time for today, so any lateness number is measured
        // against nothing.
        $result = $this->atAge(43, 190, '20270109');

        self::assertSame('stale', $result['level']);
        self::assertTrue($result['suppress_adherence']);
        self::assertStringContainsString('2027-01-09', (string) $result['reason']);
    }

    public function testAnExpiredScheduleOutranksAnAgingFeedRatherThanBeingOverwrittenByIt(): void
    {
        // Both conditions hold. A level is never lowered by a second condition, and
        // `aging` would have dropped suppress_adherence on a payload that must not
        // carry a lateness number.
        $result = $this->atAge(300, 190, '20270109');

        self::assertSame('stale', $result['level']);
        self::assertTrue($result['suppress_adherence']);
    }

    public function testAFeedThatHasActuallyStoppedStillNamesTheFeedAndNotTheSchedule(): void
    {
        // The reverse precedence: with both wrong, the reason has to name the one a
        // reader can act on, and a feed 15 minutes down is that one.
        $result = $this->atAge(900, 190, '20270109');

        self::assertSame('stale', $result['level']);
        self::assertStringContainsString('positions feed', (string) $result['reason']);
    }

    public function testAMalformedExpiryDateIsIgnoredRatherThanSuppressingTheWholeBoard(): void
    {
        // An index.json with a junk feed_end_date must not be able to blank every
        // lateness number on the board on the strength of being unparseable.
        foreach (['', 'soon', '2027-01-09', '2027019'] as $junk) {
            $result = $this->atAge(43, 8, $junk);

            self::assertSame('fresh', $result['level'], "junk expiry '$junk' changed the level");
            self::assertFalse($result['suppress_adherence']);
        }
    }

    public function testReportsScheduleAgeEvenThoughItNoLongerSetsTheLevel(): void
    {
        // The number still has a job: it is the "schedule 8 days old" line under a
        // banner raised by something else. Dropping it would take that away.
        $result = $this->atAge(900, 8);

        self::assertSame(8, $result['schedule_age_days']);
        self::assertSame('stale', $result['level']);
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

    /*
     * A superseded schedule: CapMetro is publishing a feed_version we did not build from.
     * On 2026-08-27 that renumbered every trip id eight days into a feed advertised through
     * 2027-01-09, so nothing joined, 56 of 71 routes reported every live trip missing, and
     * both of the board's own health clocks read fine. Age cannot see this and must not try;
     * identity can.
     */
    public function testASupersededScheduleForcesStaleUnderAPerfectlyHealthyFeed(): void
    {
        $result = cm_staleness(self::NOW, ['positions' => self::NOW - 14], 9, null, '260826_0956');

        self::assertSame('stale', $result['level']);
        self::assertSame('superseded', $result['schedule_state']);
        self::assertTrue($result['suppress_adherence']);
        self::assertStringContainsString('260826_0956', (string) $result['reason']);
    }

    public function testAMatchingFeedVersionIsNotSupersededAndRaisesNothing(): void
    {
        /* The caller passes null when the versions agree; see cm_schedule_superseded_by. */
        $result = cm_staleness(self::NOW, ['positions' => self::NOW - 14], 9, null, null);

        self::assertSame('fresh', $result['level']);
        self::assertSame('current', $result['schedule_state']);
        self::assertFalse($result['suppress_adherence']);
        self::assertNull($result['reason']);
    }

    /*
     * A probe that could not answer must not raise a banner. An empty string is the shape a
     * failed read could plausibly produce, and it means the same thing as null here.
     */
    public function testAnEmptyUpstreamVersionIsTreatedAsNoOpinion(): void
    {
        $result = cm_staleness(self::NOW, ['positions' => self::NOW - 14], 9, null, '');

        self::assertSame('fresh', $result['level']);
        self::assertSame('current', $result['schedule_state']);
        self::assertFalse($result['suppress_adherence']);
    }

    public function testAnExpiredScheduleOutranksASupersededOne(): void
    {
        $result = cm_staleness(self::NOW, ['positions' => self::NOW - 14], 190, '20270109', '260826_0956');

        self::assertSame('stale', $result['level']);
        self::assertSame('expired', $result['schedule_state']);
        self::assertStringContainsString('2027-01-09', (string) $result['reason']);
    }

    public function testADeadFeedOutranksASupersededSchedule(): void
    {
        $result = cm_staleness(self::NOW, ['positions' => self::NOW - 4000], 9, null, '260826_0956');

        self::assertSame('dead', $result['level']);
        /* The level is the feed's, but the schedule fact is still reported. */
        self::assertSame('superseded', $result['schedule_state']);
        self::assertStringContainsString('No fresh data', (string) $result['reason']);
    }

    public function testEveryStalenessResultCarriesAScheduleState(): void
    {
        foreach ([[14, null, null], [900, null, null], [14, '20270109', null], [14, null, '260826_0956']] as $case) {
            $result = cm_staleness(self::NOW, ['positions' => self::NOW - $case[0]], 9, $case[1], $case[2]);
            self::assertContains($result['schedule_state'], ['current', 'superseded', 'expired']);
        }
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
