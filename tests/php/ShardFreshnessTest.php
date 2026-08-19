<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Fixtures;
use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\TestCase;

/**
 * Silent failure 1: shards stale after a GTFS reset.
 *
 * CapMetro republishes its schedule roughly three times a year and every trip id
 * changes. If the shard build stops running, the shards still parse, the join
 * still completes, and every bus quietly reports adherence unknown forever.
 * Nothing throws and nothing appears in a log. The only thing that catches it is
 * measuring how often a live trip id fails to resolve, and alarming on the rate.
 */
final class ShardFreshnessTest extends TestCase
{
    /*
     * The committed shards live in data/, which is where runtime/config.fixture.php
     * points and what the GitHub Actions job writes. This constant said .local/shards,
     * a path this checkout has never had, so every test in this file skipped on every
     * run and said so in a message nobody read as a failure. A skip that reads as a
     * pass is worse than a failure.
     */
    private const SHARD_DIR = 'data';
    private const ALARM_THRESHOLD = 0.20;

    /** @return array{matched: int, unmatched: int, rate: float} */
    private function resolutionRate(array $shardTripIds): array
    {
        $matched = 0;
        $unmatched = 0;
        foreach (Fixtures::feed('vehiclepositions.json')['entity'] as $entity) {
            $trip = $entity['vehicle']['trip'] ?? null;
            if ($trip === null) {
                continue; // deadhead; it has no trip id to resolve
            }
            if (isset($shardTripIds[(string) $trip['tripId']])) {
                $matched++;
            } else {
                $unmatched++;
            }
        }
        $total = $matched + $unmatched;

        return ['matched' => $matched, 'unmatched' => $unmatched, 'rate' => $total === 0 ? 1.0 : $unmatched / $total];
    }

    /** @return array<string, true> every trip id in every committed shard */
    private function shardTripIds(): array
    {
        $dir = Runtime::dirOrSkip(
            $this,
            self::SHARD_DIR,
            sprintf('no schedule shards at %s; build them with runtime/tools/make-shards.php. See tests/NOTES.md.', self::SHARD_DIR)
        );

        /*
         * One directory per route holding schedule.json, not a flat route-*.json per
         * route. The flat layout is what the build lane emitted before the shard format
         * settled, and this glob was never updated, so the most valuable assertion in
         * the file — the one that fires the morning after a GTFS reset — skipped on
         * every run instead of guarding anything.
         */
        $schedules = glob($dir . '/routes/*/schedule.json') ?: [];
        if ($schedules === []) {
            self::markTestSkipped(sprintf(
                'no per-route schedule shards under %s/routes. Run `npm run gtfs` to rebuild them; '
                . 'they are normally committed. See tests/NOTES.md.',
                self::SHARD_DIR
            ));
        }

        $ids = [];
        foreach ($schedules as $path) {
            $doc = json_decode((string) file_get_contents($path), true);
            foreach (array_keys($doc['trips'] ?? []) as $tripId) {
                $ids[(string) $tripId] = true;
            }
        }

        return $ids;
    }

    public function testTheCurrentShardsResolveNearlyEveryLiveTripId(): void
    {
        // This is the assertion that fires the morning after a GTFS reset.
        $result = $this->resolutionRate($this->shardTripIds());

        self::assertGreaterThan(0, $result['matched'], 'not a single live trip id resolved; the shards are from another feed version');
        self::assertLessThan(
            self::ALARM_THRESHOLD,
            $result['rate'],
            sprintf('%d of %d live trips are absent from the shards', $result['unmatched'], $result['matched'] + $result['unmatched'])
        );
    }

    public function testTheShardFeedVersionMatchesTheOneTheFixturesWereCapturedAgainst(): void
    {
        $dir = Runtime::dirOrSkip($this, self::SHARD_DIR, 'no schedule shards; see tests/NOTES.md.');
        Runtime::functionsOrSkip($this, ['cm_shard_index'], ['runtime/lib/shards.php']);

        $index = cm_shard_index($dir, true);
        if ($index === null) {
            self::markTestSkipped(sprintf(
                'the shards at %s are not in the layout runtime/lib/shards.php reads; rebuild them. See tests/NOTES.md.',
                self::SHARD_DIR
            ));
        }

        self::assertSame(
            '260818_1456',
            $index['feed_version'] ?? null,
            'the shards were built from a different GTFS publication than the fixtures'
        );
    }

    public function testAShardBuiltBeforeAGtfsResetResolvesNothingAndWouldAlarm(): void
    {
        // The same measurement, pointed at the synthetic stale shard. If this
        // does not come out at 100%, the metric above cannot detect the failure.
        $stale = Fixtures::synthetic('stale-shard-route-4.json');
        $ids = [];
        foreach (array_keys($stale['trips']) as $tripId) {
            $ids[(string) $tripId] = true;
        }

        $liveRouteFour = array_values(array_filter(
            array_map(static fn (array $e): ?array => $e['vehicle']['trip'] ?? null, Fixtures::feed('vehiclepositions.json')['entity']),
            static fn (?array $t): bool => $t !== null && (string) $t['routeId'] === '4'
        ));

        $unmatched = 0;
        foreach ($liveRouteFour as $trip) {
            if (!isset($ids[(string) $trip['tripId']])) {
                $unmatched++;
            }
        }

        self::assertGreaterThan(0, count($liveRouteFour));
        self::assertSame(count($liveRouteFour), $unmatched);
        self::assertSame(1.0, (float) $unmatched / count($liveRouteFour));
        self::assertGreaterThan(self::ALARM_THRESHOLD, 1.0, 'the threshold no longer catches a total mismatch');
    }

    public function testTheStaleShardDeclaresADifferentFeedVersionThanTheLiveCapture(): void
    {
        $stale = Fixtures::synthetic('stale-shard-route-4.json');

        self::assertNotSame('260818_1456', $stale['feed_version']);
        self::assertLessThan(1787100000, $stale['built_at']);
    }

    public function testTheRuntimeJobRaisesAnAlarmWhenTheUnmatchedTripRateIsHigh(): void
    {
        // No aggregate metric exists yet. Every vehicle individually reports
        // adherence.reason "trip_not_in_schedule", but nothing counts them and
        // nothing reaches health.json, so a total shard mismatch is still
        // silent to an uptime check. Recorded in tests/NOTES.md.
        Runtime::functionsOrSkip(
            $this,
            ['cm_unmatched_trip_rate'],
            ['runtime/lib/shards.php', 'runtime/lib/join.php']
        );

        $stale = Fixtures::synthetic('stale-shard-route-4.json');
        $rate = cm_unmatched_trip_rate($stale, ['3014769_15202', '3014707_15609']);

        self::assertSame(1.0, $rate);
        self::assertGreaterThan(self::ALARM_THRESHOLD, $rate);
    }
}
