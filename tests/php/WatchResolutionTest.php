<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Fixtures;
use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\TestCase;

/**
 * Contract section 9 and acceptance criterion 9: resolving a saved watch.
 *
 * The tuple is semantic on purpose. Trip ids change on every republish, and the
 * captured date runs a one-off service, so an implementation that resolves by
 * day of week returns the wrong trip on 8 of the 145 dates in this feed. The
 * watch id is a hash so a URL or a server log never carries a legible
 * description of a child's daily routine.
 */
final class WatchResolutionTest extends TestCase
{
    private const FILES = ['runtime/lib/watch.php'];
    /*
     * The committed shards live in data/, which is where runtime/config.fixture.php
     * points and what the GitHub Actions job writes. This constant said .local/shards,
     * a path this checkout has never had, so every test in this file skipped on every
     * run and said so in a message nobody read as a failure. A skip that reads as a
     * pass is worse than a failure.
     */
    /*
     * The frozen 260818_1456 shards, not data/. These tests pin real trip ids from the
     * 2026-08-19 capture, so they must be measured against the shards that capture was taken
     * against. Pointed at data/ they were really asserting "the committed shards have not been
     * rebuilt yet", and went red on 2026-08-27 when the rebuild that fixed production landed.
     * See tests/fixtures/shards-260818_1456/README.md.
     */
    private const SHARD_DIR = 'tests/fixtures/shards-260818_1456';

    private const TUPLE = [
        'route_id' => '800',
        'direction_id' => 1,
        'stop_id' => '6293',
        'scheduled_time' => '07:52:09',
        'day_type' => 'weekday',
    ];
    private const EXPECTED_ID = '214ab6184a765743583f0eb1c5171cc7';

    protected function setUp(): void
    {
        Runtime::functionsOrSkip($this, ['cm_watch_id', 'cm_watch_resolve'], self::FILES);
    }

    private function shardDir(): string
    {
        $dir = Runtime::dirOrSkip(
            $this,
            self::SHARD_DIR,
            sprintf(
                'no schedule shards at %s. Run `npm run gtfs` to rebuild them, or check them out. '
                . 'They are normally committed. See tests/NOTES.md.',
                self::SHARD_DIR
            )
        );

        Runtime::functionsOrSkip($this, ['cm_shard_index'], ['runtime/lib/shards.php']);
        if (cm_shard_index($dir, true) === null) {
            self::markTestSkipped(sprintf(
                'the shards at %s are not in the layout runtime/lib/shards.php reads. The shard format is '
                . 'migrating between the build and runtime lanes; rebuild them. See tests/NOTES.md.',
                self::SHARD_DIR
            ));
        }

        return $dir;
    }

    private function resolveOn(string $serviceDate, array $tuple = self::TUPLE): array
    {
        $dir = $this->shardDir();
        Runtime::functionsOrSkip($this, ['cm_shard_index', 'cm_shard_route', 'cm_shard_times', 'cm_shard_active_services'], ['runtime/lib/shards.php']);

        $index = cm_shard_index($dir);
        self::assertNotNull($index, 'the shard index is unreadable');

        return cm_watch_resolve(
            $tuple,
            cm_shard_route($dir, $tuple['route_id']),
            cm_shard_times($dir, $tuple['route_id']) ?? [],
            cm_shard_active_services($index, $serviceDate),
            $serviceDate
        );
    }

    public function testTheWatchIdIsTheFirstSixteenBytesOfSha256OverThePipeJoinedTuple(): void
    {
        $joined = implode('|', ['800', '1', '6293', '07:52:09', 'weekday']);

        self::assertSame(self::EXPECTED_ID, substr(hash('sha256', $joined), 0, 32));
    }

    public function testDerivesThatSameIdFromTheTuple(): void
    {
        self::assertSame(self::EXPECTED_ID, cm_watch_id('800', 1, '6293', '07:52:09', 'weekday'));
    }

    public function testTheIdRevealsNothingLegibleAboutAChildsDailyRoutine(): void
    {
        $id = cm_watch_id('800', 1, '6293', '07:52:09', 'weekday');

        self::assertMatchesRegularExpression('/^[0-9a-f]{32}$/', $id);
        foreach (['800', '6293', '0752', 'weekday'] as $fragment) {
            self::assertStringNotContainsString($fragment, $id);
        }
    }

    public function testHashesTheScheduledTimeVerbatimIncludingItsLeadingZero(): void
    {
        self::assertNotSame(self::EXPECTED_ID, cm_watch_id('800', 1, '6293', '7:52:09', 'weekday'));
    }

    public function testSerialisesDirectionIdAsABareZeroOrOne(): void
    {
        self::assertNotSame(self::EXPECTED_ID, cm_watch_id('800', 0, '6293', '07:52:09', 'weekday'));
        self::assertSame(self::EXPECTED_ID, cm_watch_id('800', 1, '6293', '07:52:09', 'weekday'));
    }

    public function testIsStableAcrossCallsSoASavedUrlKeepsWorking(): void
    {
        self::assertSame(
            cm_watch_id('800', 1, '6293', '07:52:09', 'weekday'),
            cm_watch_id('800', 1, '6293', '07:52:09', 'weekday')
        );
    }

    public function testResolvesTheTupleToTripThirtyMillionTenThousandOnTheOneOffServiceDate(): void
    {
        $resolution = $this->resolveOn('20260819');

        self::assertTrue($resolution['resolved'], 'the watch did not resolve on the date it was captured');
        self::assertSame('3010894_22201', $resolution['trip_id']);
        self::assertSame('20260819', $resolution['service_date']);
        self::assertNotNull($resolution['service_id'], 'resolution must name the service it matched, per route');
    }

    public function testAlsoResolvesOnTheFollowingDayWhichRunsADifferentOneOffService(): void
    {
        $resolution = $this->resolveOn('20260820');

        self::assertTrue($resolution['resolved'], 'a watch that only resolves on the day it was saved is useless');
        self::assertSame('20260820', $resolution['service_date']);
    }

    public function testResolvesOnAnOrdinaryWeekdayToo(): void
    {
        $resolution = $this->resolveOn('20260824');

        self::assertTrue($resolution['resolved']);
    }

    public function testAnchorsTheScheduledTimeToTheCorrectServiceDayMidnight(): void
    {
        $a = $this->resolveOn('20260819');
        $b = $this->resolveOn('20260820');

        self::assertSame(86400, $b['scheduled_at'] - $a['scheduled_at'], 'consecutive service days are one day apart');
    }

    public function testReportsUnresolvedRatherThanBlankWhenNoTripMatches(): void
    {
        $resolution = $this->resolveOn('20260819', array_merge(self::TUPLE, ['stop_id' => '000000']));

        self::assertFalse($resolution['resolved']);
        self::assertNull($resolution['trip_id']);
        self::assertSame([], $resolution['ambiguous_candidates']);
        self::assertSame('20260819', $resolution['service_date'], 'the client still needs to know which date failed');
    }

    public function testReportsUnresolvedForADirectionThatDoesNotServeThatStopAtThatTime(): void
    {
        $resolution = $this->resolveOn('20260819', array_merge(self::TUPLE, ['direction_id' => 0]));

        self::assertFalse($resolution['resolved']);
    }

    public function testListsEveryCandidateWhenSeveralTripsShareTheScheduledTime(): void
    {
        $resolution = $this->resolveOn('20260819');

        self::assertIsArray($resolution['ambiguous_candidates']);
        self::assertSame([], $resolution['ambiguous_candidates'], 'this tuple is unambiguous; a non-empty list would be a bug');
    }

    public function testTheCapturedDateReallyRunsAOneOffServiceThatNoWeekdayRuleWouldFind(): void
    {
        $rows = array_values(array_filter(
            explode("\n", trim(Fixtures::text('feeds-20260819/gtfs_calendar_dates.txt'))),
            static fn (string $line): bool => str_starts_with($line, '3-172,')
        ));

        self::assertCount(1, $rows, 'service 3-172 should run on exactly one date');
        self::assertStringContainsString('20260819', $rows[0]);
    }

    public function testTheTwoConsecutiveDatesRunDifferentServiceSetsSoResolutionCannotBeCached(): void
    {
        $dir = $this->shardDir();
        Runtime::functionsOrSkip($this, ['cm_shard_index', 'cm_shard_active_services'], ['runtime/lib/shards.php']);
        $index = cm_shard_index($dir);

        $a = array_keys(cm_shard_active_services($index, '20260819'));
        $b = array_keys(cm_shard_active_services($index, '20260820'));
        sort($a);
        sort($b);

        self::assertNotSame($a, $b, 'if these matched, the one-off service the fixture was chosen for is gone');
    }
}
