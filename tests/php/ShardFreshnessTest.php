<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Fixtures;
use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\TestCase;

/**
 * Silent failure 1: shards stale after a GTFS reset.
 *
 * CapMetro republishes its schedule and every trip id changes. If the shard build stops
 * running, the shards still parse, the join still completes, and every bus quietly reports
 * adherence unknown forever. Nothing throws and nothing appears in a log. What catches it is
 * measuring how often a live trip id fails to resolve, and alarming on the rate.
 *
 * This file tests THAT MEASUREMENT, against a frozen pair: the 2026-08-19 capture and the
 * 260818_1456 shards it was taken against. It used to point the measurement at `data/`, which
 * made it ask a different question -- "are the committed shards still the August ones?" -- and
 * that question answers itself wrongly. On 2026-08-27 CapMetro published 260826_0956, the
 * rebuild that fixed production landed, and this file went red because the shards were now
 * RIGHT. An alarm that fires on the repair is worse than no alarm.
 *
 * Whether the committed shards are the ones CapMetro currently publishes is a live question
 * about upstream, not a question a frozen fixture can answer. runtime/lib/upstream.php asks it
 * for real -- feed_version identity, every fifteen minutes -- and reports it as
 * staleness.schedule_state. See tests/php/UpstreamTest.php.
 */
final class ShardFreshnessTest extends TestCase
{
    /*
     * The shards the fixtures were captured against, frozen. Not data/: this constant pointed
     * there, and before that at .local/shards -- a path this checkout never had, so every test
     * in the file skipped on every run and said so in a message nobody read as a failure. A
     * skip that reads as a pass is worse than a failure; so is a failure that means the data
     * got fixed.
     */
    private const SHARD_DIR = 'tests/fixtures/shards-260818_1456';
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

    /** @return array<string, true> every trip id in the frozen 260818_1456 shards */
    private function shardTripIds(): array
    {
        $dir = Runtime::dirOrSkip(
            $this,
            self::SHARD_DIR,
            sprintf('no frozen shards at %s; see its README.', self::SHARD_DIR)
        );

        /*
         * One directory per route holding schedule.json, not a flat route-*.json per route.
         * The flat layout is what the build lane emitted before the shard format settled, and
         * this glob was never updated, so the most valuable assertion in the file skipped on
         * every run instead of guarding anything.
         */
        $schedules = glob($dir . '/routes/*/schedule.json') ?: [];
        if ($schedules === []) {
            self::markTestSkipped(sprintf('no per-route schedule shards under %s/routes; see its README.', self::SHARD_DIR));
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

    /*
     * The positive case: the capture and the shards are a matched pair, so nearly every live
     * trip resolves and the alarm stays quiet. Paired with the stale-shard case below, which
     * proves the same metric goes to 100% when they are NOT a matched pair. One without the
     * other proves nothing: a metric that never fires and a metric that always fires both look
     * like this from one side.
     */
    public function testTheMatchedShardsResolveNearlyEveryLiveTripId(): void
    {
        $result = $this->resolutionRate($this->shardTripIds());

        self::assertGreaterThan(0, $result['matched'], 'not a single live trip id resolved; the pair is not matched');
        self::assertLessThan(
            self::ALARM_THRESHOLD,
            $result['rate'],
            sprintf('%d of %d live trips are absent from the shards', $result['unmatched'], $result['matched'] + $result['unmatched'])
        );
    }

    /*
     * The real 2026-08-27 event, replayed: the same capture measured against the shards that
     * are committed TODAY. Asserting a direction rather than a number, because which way it
     * comes out depends on whether CapMetro has republished since, and both answers are
     * correct -- that is exactly why this may not be the freshness alarm.
     */
    public function testTheSameMetricAgainstTheLiveTreeIsAboutTheFeedAndNotAboutTheCode(): void
    {
        $dir = Runtime::root() . '/data';
        $schedules = glob($dir . '/routes/*/schedule.json') ?: [];
        if ($schedules === []) {
            self::markTestSkipped('no committed shards under data/routes; see tests/NOTES.md.');
        }

        $ids = [];
        foreach ($schedules as $path) {
            $doc = json_decode((string) file_get_contents($path), true);
            foreach (array_keys($doc['trips'] ?? []) as $tripId) {
                $ids[(string) $tripId] = true;
            }
        }

        $result = $this->resolutionRate($ids);
        $manifest = json_decode((string) file_get_contents($dir . '/manifest.json'), true);
        $live = (string) ($manifest['feed_version'] ?? '');

        if ($live === '260818_1456') {
            self::assertLessThan(self::ALARM_THRESHOLD, $result['rate'], 'same feed as the capture, so it must resolve');
            return;
        }

        /* A different feed. Trip ids are renumbered wholesale between publications, so a high
           unmatched rate here is the expected, correct reading -- not a defect. */
        self::assertGreaterThan(
            0.5,
            $result['rate'],
            sprintf(
                'data/ is on %s and the capture is on 260818_1456, so most trip ids should NOT '
                . 'resolve. They did, which means the two feeds share trip ids and the '
                . 'renumbering assumption behind schedule_state is wrong.',
                $live
            )
        );
    }

    /*
     * The pair invariant. Not "the shards are 260818_1456" against a hardcoded string, and
     * emphatically not against data/, but: the frozen shards and the captured feed agree with
     * each other. Both sides are read from the fixtures, so this stays true forever and goes
     * red only if someone re-pins one half of the pair and forgets the other -- which is the
     * single way this corpus can quietly start lying.
     */
    public function testTheFrozenShardsAndTheCapturedFeedAreTheSamePublication(): void
    {
        $dir = Runtime::dirOrSkip($this, self::SHARD_DIR, 'no frozen shards; see its README.');
        Runtime::functionsOrSkip($this, ['cm_shard_index'], ['runtime/lib/shards.php']);
        Runtime::functionsOrSkip($this, ['cm_parse_feed_info_version'], ['runtime/lib/fetch.php', 'runtime/lib/upstream.php']);

        $index = cm_shard_index($dir, true);
        if ($index === null) {
            self::markTestSkipped(sprintf(
                'the shards at %s are not in the layout runtime/lib/shards.php reads. See its README.',
                self::SHARD_DIR
            ));
        }

        /* Parsed with the runtime's own reader, the one the upstream probe uses. */
        $captured = cm_parse_feed_info_version(Fixtures::text('feeds-20260819/gtfs_feed_info.txt'));

        self::assertSame('260818_1456', $captured, 'the captured feed_info names a different publication');
        self::assertSame(
            $captured,
            $index['feed_version'] ?? null,
            'the frozen shards and the captured feed are from different GTFS publications, so '
            . 'every trip id test in this suite is measuring nothing'
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
