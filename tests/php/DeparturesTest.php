<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Fixtures;
use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\TestCase;

/**
 * Contract section 16: one service day of scheduled departures per route.
 *
 * This is the document a saved watch is built from. The worked example is "the
 * 7:50a 800 SB from Simond/Berkman", and every restriction that keeps the route
 * file small defeats it: route.schedule is windowed to an hour either side of
 * now and carries timepoints only, and stop 6293 Simond SB is a minor stop that
 * never appears in it. So this document drops both restrictions, and the tests
 * below are about the three ways that can go wrong -- a wrapped clock, a stop
 * that loses one of its two directions, and a trip index that points at the
 * wrong trip.
 */
final class DeparturesTest extends TestCase
{
    private const FILES = ['runtime/lib/departures.php'];
    private const SHARD_DIR = 'data';

    protected function setUp(): void
    {
        Runtime::functionsOrSkip(
            $this,
            ['cm_departure_trips', 'cm_build_departures', 'cm_modal_stop_sequence'],
            self::FILES
        );
    }

    /**
     * A two-stop, two-direction route with one baseline pattern per direction
     * and one special short-turn pattern. Small enough to reason about by hand,
     * shaped exactly like cm_shard_route() output.
     */
    private static function shard(): array
    {
        return [
            'route_id' => '900',
            'route' => [
                'id' => '900',
                'short_name' => '900',
                'long_name' => '900-Test',
                'directions' => [['id' => 0, 'headsign' => 'NB'], ['id' => 1, 'headsign' => 'SB']],
            ],
            'stops' => [
                'A' => ['name' => 'Alpha', 'name_full' => 'Alpha (First/Main)', 'lat' => 30.1, 'lon' => -97.1],
                'B' => ['name' => 'Bravo', 'name_full' => 'Bravo (Second/Main)', 'lat' => 30.2, 'lon' => -97.2],
            ],
            'patterns' => [
                'base-0' => ['pattern_id' => 'base-0', 'direction_id' => 0, 'is_special' => false],
                'base-1' => ['pattern_id' => 'base-1', 'direction_id' => 1, 'is_special' => false],
                'short-0' => ['pattern_id' => 'short-0', 'direction_id' => 0, 'is_special' => true],
            ],
            'baseline_by_service' => [
                '0' => ['S1' => 'base-0'],
                '1' => ['S1' => 'base-1'],
            ],
            'baseline_pattern_id' => ['0' => 'base-0', '1' => 'base-1'],
            'trips' => [],
        ];
    }

    /**
     * @param array<string, array> $trips keyed by trip id
     */
    private static function times(array $trips): array
    {
        return ['stop_ids' => ['A', 'B'], 'trips' => $trips];
    }

    private static function trip(
        string $service,
        int $direction,
        string $pattern,
        string $start,
        array $stops
    ): array {
        return [
            'block_id' => 'BLK1',
            'direction_id' => $direction,
            'headsign' => $direction === 0 ? 'NB' : 'SB',
            'pattern_id' => $pattern,
            'service_id' => $service,
            'start_time' => $start,
            'stops' => $stops,
        ];
    }

    private static function build(array $times, array $active = ['S1' => true]): array
    {
        return cm_build_departures(self::shard(), $times, $active, '20260819', '260818_1456', 1787152239);
    }

    public function testKeepsOnlyTheTripsWhoseServiceIsActiveOnTheServiceDate(): void
    {
        /*
         * Route 800 carries 903 trips in the extract and runs 196 of them on 20260819.
         * Publishing all 903 would be four and a half times the bytes and every extra row
         * would be a departure that does not happen today, which on a picker is not merely
         * wasteful but wrong.
         */
        $doc = self::build(self::times([
            'today' => self::trip('S1', 0, 'base-0', '06:00:00', [[1, 0, 21600, 1]]),
            'sunday' => self::trip('S9', 0, 'base-0', '07:00:00', [[1, 0, 25200, 1]]),
        ]));

        self::assertSame(['today'], array_column($doc['trips'], 'id'));
    }

    public function testDropsATripWhoseServiceIdIsMissingRatherThanGuessingItRunsToday(): void
    {
        /*
         * An empty service_id matches no active service. Treating it as "probably today"
         * would advertise a departure nobody can catch, and a departure that does not
         * happen is the one failure a saved watch cannot recover from.
         */
        $doc = self::build(self::times([
            'orphan' => self::trip('', 0, 'base-0', '06:00:00', [[1, 0, 21600, 1]]),
        ]));

        self::assertSame([], $doc['trips']);
    }

    public function testPreservesAnArrivalPastMidnightInsteadOfWrappingItAtEightySixFourHundred(): void
    {
        /*
         * A 25:10:00 arrival is 90600 seconds into the service day, not 4200. Wrapping it
         * would sort the last trip of the night to the top of the morning list and hand a
         * rider a 1:10am bus when they asked for the first one of the day.
         */
        $doc = self::build(self::times([
            'late' => self::trip('S1', 0, 'base-0', '24:40:00', [[1, 0, 88800, 1], [2, 1, 90600, 1]]),
        ]));

        self::assertSame([[88800, 0]], ((array) $doc['departures'])['A']);
        self::assertSame([[90600, 0]], ((array) $doc['departures'])['B']);
    }

    public function testSortsEachStopsDeparturesAscendingByArrivalSecond(): void
    {
        /*
         * The trips array is ordered by scheduled start, but a stop late in one pattern
         * and early in another does not inherit that order. A picker that renders the list
         * in payload order would show 7:50 above 6:20.
         */
        $doc = self::build(self::times([
            'first' => self::trip('S1', 0, 'base-0', '06:00:00', [[1, 0, 21600, 1], [2, 1, 30000, 0]]),
            'second' => self::trip('S1', 0, 'base-0', '06:30:00', [[1, 0, 23400, 1], [2, 1, 24000, 0]]),
        ]));

        self::assertSame([[24000, 1], [30000, 0]], ((array) $doc['departures'])['B']);
    }

    public function testPointsEachDepartureAtItsOwnTripThroughTheTripIndex(): void
    {
        /*
         * The index is the only join between a departure and the headsign, direction and
         * block that describe it. An off-by-one here would label every departure with the
         * previous trip's destination and nothing in the payload would look wrong.
         */
        $doc = self::build(self::times([
            'north' => self::trip('S1', 0, 'base-0', '06:00:00', [[1, 0, 21600, 1]]),
            'south' => self::trip('S1', 1, 'base-1', '06:10:00', [[1, 0, 22200, 1]]),
        ]));

        foreach (((array) $doc['departures'])['A'] as [$arrival, $index]) {
            $trip = $doc['trips'][$index];
            self::assertSame($arrival === 21600 ? 'north' : 'south', $trip['id']);
            self::assertSame($arrival === 21600 ? 0 : 1, $trip['direction_id']);
        }
    }

    public function testEmitsAStopOncePerDirectionItIsServedIn(): void
    {
        /*
         * Two of route 800's 40 stops serve both directions. One row could only name one
         * of them, so a direction filter built on a single row would silently drop half of
         * that stop's service -- and it is the half a rider going the other way needs.
         */
        $doc = self::build(self::times([
            'north' => self::trip('S1', 0, 'base-0', '06:00:00', [[1, 0, 21600, 1]]),
            'south' => self::trip('S1', 1, 'base-1', '06:10:00', [[3, 0, 22200, 1]]),
        ]));

        $rows = array_values(array_filter($doc['stops'], static fn (array $s): bool => $s['stop_id'] === 'A'));

        self::assertCount(2, $rows);
        self::assertSame([0, 1], array_column($rows, 'direction_id'));
    }

    public function testKeysDeparturesByStopIdAloneSoOneStopHasOneMergedList(): void
    {
        /*
         * A rider standing at a stop wants that stop's departures; direction is a property
         * of the trip they choose. Keying by the pair would force the client to build
         * "A|0" by string concatenation and to read two lists to answer one question.
         */
        $doc = self::build(self::times([
            'north' => self::trip('S1', 0, 'base-0', '06:00:00', [[1, 0, 21600, 1]]),
            'south' => self::trip('S1', 1, 'base-1', '06:10:00', [[3, 0, 22200, 1]]),
        ]));

        self::assertSame(['A'], array_keys((array) $doc['departures']));
        self::assertSame([[21600, 0], [22200, 1]], ((array) $doc['departures'])['A']);
    }

    public function testPublishesTheStopSequenceMostOfTodaysTripsAgreeOn(): void
    {
        /*
         * A short-turn pattern that starts mid-route gives a stop a much lower sequence
         * than the ordinary run does. Taking the minimum would let two special trips
         * reorder a list built from ninety normal ones.
         */
        $doc = self::build(self::times([
            'normal1' => self::trip('S1', 0, 'base-0', '06:00:00', [[1, 0, 21600, 1], [9, 1, 22000, 0]]),
            'normal2' => self::trip('S1', 0, 'base-0', '06:30:00', [[1, 0, 23400, 1], [9, 1, 23800, 0]]),
            'shortturn' => self::trip('S1', 0, 'short-0', '07:00:00', [[1, 1, 25200, 0]]),
        ]));

        $bravo = array_values(array_filter($doc['stops'], static fn (array $s): bool => $s['stop_id'] === 'B'))[0];

        self::assertSame(9, $bravo['stop_sequence']);
    }

    public function testBreaksATieOverStopSequenceTowardTheLowerNumber(): void
    {
        /*
         * With two patterns running equally often there is no majority to defer to. Both
         * answers are defensible; only one of them is the same on every run, and a
         * document that reorders itself between two identical runs makes every diff
         * unreadable.
         */
        self::assertSame(4, cm_modal_stop_sequence([9 => 3, 4 => 3]));
    }

    public function testMarksAStopATimepointWhenAnyOfTodaysTripsTreatsItAsOne(): void
    {
        /*
         * GTFS carries the flag per stop_time, not per stop. A short-turn pattern that
         * omits the timepoint flag would otherwise demote a stop the printed timetable
         * sets in bold, purely because of which trip was read last.
         */
        $doc = self::build(self::times([
            'flagged' => self::trip('S1', 0, 'base-0', '06:00:00', [[1, 0, 21600, 1]]),
            'unflagged' => self::trip('S1', 0, 'base-0', '06:30:00', [[1, 0, 23400, 0]]),
        ]));

        self::assertTrue($doc['stops'][0]['is_timepoint']);
    }

    public function testMirrorsThePatternSpecialFlagRatherThanDefiningSpecialASecondTime(): void
    {
        /*
         * vehicle.pattern.is_special (section 2) and this flag describe the same trip. Two
         * definitions would eventually disagree about the Austin High run, and the board
         * would call one bus special while the picker called it ordinary. Both call
         * cm_trip_is_special().
         */
        $doc = self::build(self::times([
            'normal' => self::trip('S1', 0, 'base-0', '06:00:00', [[1, 0, 21600, 1]]),
            'special' => self::trip('S1', 0, 'short-0', '06:30:00', [[1, 0, 23400, 1]]),
        ]));

        $flags = array_combine(array_column($doc['trips'], 'id'), array_column($doc['trips'], 'is_special'));

        self::assertFalse($flags['normal']);
        self::assertTrue($flags['special']);
    }

    public function testTakesTheStopNameFromTheShardsTableSoSectionSevenIsAppliedOnlyOnce(): void
    {
        /*
         * runtime/lib/stopnames.php is the only thing allowed to shorten a name. A second
         * path would render the same stop two ways on one screen, which is exactly the
         * divergence ISSUE-002 recorded.
         */
        $doc = self::build(self::times([
            'north' => self::trip('S1', 0, 'base-0', '06:00:00', [[1, 0, 21600, 1]]),
        ]));

        self::assertSame('Alpha', $doc['stops'][0]['stop_name']);
        self::assertSame('Alpha (First/Main)', $doc['stops'][0]['stop_name_full']);
    }

    public function testAnswersWithAWellFormedEmptyDocumentWhenTheRouteRunsNothingToday(): void
    {
        /*
         * Four of the 71 routes have no service on 20260819 and the catalog still lists
         * them, so the client will still fetch this file. departures must encode as {} and
         * not as [], or the schema's object type fails and a client indexing by stop id
         * gets an array.
         */
        $doc = self::build(self::times([
            'sunday' => self::trip('S9', 0, 'base-0', '07:00:00', [[1, 0, 25200, 1]]),
        ]));

        self::assertSame([], $doc['stops']);
        self::assertSame([], $doc['trips']);
        self::assertSame('{}', json_encode($doc['departures']));
    }

    public function testPublishesTheServiceDayMidnightEveryArrivalIsMeasuredFrom(): void
    {
        /*
         * 1787115600 is midnight on 20260819 in America/Chicago. The client adds it to an
         * arrival_s and has an absolute epoch; the alternative is noon-minus-twelve in ES5
         * in a browser, which is the DST trap cm_service_day_midnight() already solves and
         * a second implementation of it would eventually get wrong twice a year.
         */
        $doc = self::build(self::times([]));

        self::assertSame(1787115600, $doc['service_day_start_epoch']);
    }

    public function testNamesTheDayTypeTheWayTheWatchTupleSpellsIt(): void
    {
        /*
         * A saved watch carries its day type in the tuple (section 9), so the client has to
         * decide whether today is a day a given watch applies to. cm_day_type() is the one
         * definition of that word in the codebase and this is the same call, not a second
         * one -- 20260822 is a Saturday and 20260823 a Sunday.
         */
        $shard = self::shard();
        $times = self::times([]);

        self::assertSame('weekday', cm_build_departures($shard, $times, [], '20260819', 'v', 1)['day_type']);
        self::assertSame('saturday', cm_build_departures($shard, $times, [], '20260822', 'v', 1)['day_type']);
        self::assertSame('sunday', cm_build_departures($shard, $times, [], '20260823', 'v', 1)['day_type']);
    }

    public function testSaysNullRatherThanGuessingWhenTheServiceDateDoesNotResolve(): void
    {
        /*
         * The cron job cannot produce this -- it passes cm_service_date_for() output -- but
         * a plausible-looking 0 or "weekday" would make every absolute time in the document
         * silently wrong, which is the exact failure this endpoint exists to prevent.
         * Section 0 forbids 0 standing for unknown; null is the contract's word for it.
         */
        $doc = cm_build_departures(self::shard(), self::times([]), [], 'not-a-date', 'v', 1);

        self::assertNull($doc['service_day_start_epoch']);
        self::assertNull($doc['day_type']);
    }

    public function testTheAbsoluteTimeThisDocumentImpliesMatchesTheOneTheRoutePayloadPublishes(): void
    {
        /*
         * The invariant the client is built on: service_day_start_epoch + the trip's first
         * arrival_s is the trip's start_epoch, the same number section 3.2's schedule rows
         * carry and the same one Vehicle.trip.start_epoch carries. If the two endpoints ever
         * disagreed about when one trip is due, nothing in either document would look wrong
         * and the first symptom would be a parent standing at a stop at the wrong time.
         *
         * Swept over every generated route rather than one: 461 trip rows across 50 routes
         * on the 2026-08-19 fixture. One route could agree by luck about its own timezone;
         * fifty cannot.
         */
        $compared = 0;
        foreach ($this->generatedRouteIds() as $routeId) {
            $board = $this->generated($routeId);
            $route = $this->generatedRoute($routeId);
            $anchor = $board['service_day_start_epoch'];
            self::assertNotNull($anchor, sprintf('route %s published no service day anchor', $routeId));

            $firstArrival = self::firstArrivalPerTrip($board);
            $indexOf = array_flip(array_column($board['trips'], 'id'));

            foreach ($route['schedule']['directions'] as $direction) {
                foreach ($direction['trips'] as [$tripId, $startEpoch, $offsets]) {
                    if (!isset($indexOf[$tripId])) {
                        continue;
                    }
                    $compared++;
                    self::assertSame(
                        $startEpoch,
                        $anchor + $firstArrival[$indexOf[$tripId]],
                        sprintf('route %s: the two endpoints disagree about when trip %s starts', $routeId, $tripId)
                    );
                }
            }
        }

        self::assertGreaterThan(100, $compared, 'too few trips appeared in both documents to prove anything');
    }

    public function testTheTwoEndpointsAgreeAtEveryTimepointAndNotOnlyAtTheTripStart(): void
    {
        /*
         * Agreeing on the start is not enough: the client plots a live vehicle against the
         * ladder using an arrival part-way through a trip. Section 3.2 publishes those as
         * offsets from start_epoch, this document as seconds from service-day midnight, and
         * the two arithmetics have to land on the same second at every column -- 2,725 of
         * them across the 50 routes with a windowed trip on this fixture.
         */
        $compared = 0;
        foreach ($this->generatedRouteIds() as $routeId) {
            $board = $this->generated($routeId);
            $route = $this->generatedRoute($routeId);
            $anchor = $board['service_day_start_epoch'];
            $indexOf = array_flip(array_column($board['trips'], 'id'));
            $departures = (array) $board['departures'];

            foreach ($route['schedule']['directions'] as $direction) {
                foreach ($direction['trips'] as [$tripId, $startEpoch, $offsets]) {
                    if (!isset($indexOf[$tripId])) {
                        continue;
                    }
                    $tripIndex = $indexOf[$tripId];
                    foreach ($offsets as $column => $offset) {
                        if ($offset === null) {
                            continue;
                        }
                        $stopId = $direction['timepoint_stop_ids'][$column];
                        $arrival = null;
                        foreach ($departures[$stopId] ?? [] as [$candidate, $owner]) {
                            if ($owner === $tripIndex) {
                                $arrival = $candidate;
                                break;
                            }
                        }
                        self::assertNotNull($arrival, sprintf(
                            'route %s: trip %s serves timepoint %s in the route payload but not here',
                            $routeId,
                            $tripId,
                            $stopId
                        ));
                        $compared++;
                        self::assertSame(
                            $startEpoch + $offset,
                            $anchor + $arrival,
                            sprintf('route %s: the two endpoints disagree about trip %s at stop %s', $routeId, $tripId, $stopId)
                        );
                    }
                }
            }
        }

        self::assertGreaterThan(500, $compared, 'too few timepoint offsets were available to prove anything');
    }

    public function testEveryTripOnARouteImpliesOneAndTheSameServiceDayAnchor(): void
    {
        /*
         * The sharpest form of the same check, and the one that would catch an anchor that
         * is merely plausible. Subtracting each trip's first arrival_s from the start_epoch
         * the route payload publishes for it must yield the SAME number every time, and that
         * number must be the one this document publishes. An off-by-an-hour anchor still
         * yields one number, but not this one; a per-trip timezone bug yields several.
         */
        $checked = 0;
        foreach ($this->generatedRouteIds() as $routeId) {
            $board = $this->generated($routeId);
            $route = $this->generatedRoute($routeId);
            $firstArrival = self::firstArrivalPerTrip($board);
            $indexOf = array_flip(array_column($board['trips'], 'id'));

            $implied = [];
            foreach ($route['schedule']['directions'] as $direction) {
                foreach ($direction['trips'] as [$tripId, $startEpoch, $offsets]) {
                    if (isset($indexOf[$tripId])) {
                        $implied[$startEpoch - $firstArrival[$indexOf[$tripId]]] = true;
                    }
                }
            }
            if ($implied === []) {
                continue;
            }
            $checked++;
            self::assertSame(
                [$board['service_day_start_epoch']],
                array_keys($implied),
                sprintf('route %s implies a service day start its own document does not publish', $routeId)
            );
        }

        self::assertGreaterThan(10, $checked, 'too few routes had a comparable trip');
    }

    /** @return array<int, int> trip index => arrival at that trip's first stop */
    private static function firstArrivalPerTrip(array $board): array
    {
        $first = [];
        foreach ((array) $board['departures'] as $rows) {
            foreach ($rows as [$arrival, $tripIndex]) {
                if (!isset($first[$tripIndex]) || $arrival < $first[$tripIndex]) {
                    $first[$tripIndex] = $arrival;
                }
            }
        }
        return $first;
    }

    /** @return list<string> every route id with a generated departure board */
    private function generatedRouteIds(): array
    {
        $dir = Fixtures::webroot() . '/api/departures';
        $files = is_dir($dir) ? (glob($dir . '/*.json') ?: []) : [];
        if ($files === []) {
            self::markTestSkipped(sprintf(
                'no generated departure boards at %s. Regenerate with runtime/config.fixture.php and '
                . 'set CAPMETRO_WEBROOT. See tests/NOTES.md.',
                $dir
            ));
        }
        sort($files);

        return array_map(static fn (string $f): string => basename($f, '.json'), $files);
    }

    public function testCarriesTheServiceDateAndFeedVersionTheArrivalsAreRelativeTo(): void
    {
        /*
         * arrival_s is meaningless without the date it counts from, and a client caching
         * this document across a GTFS republish needs to know the trip ids underneath it
         * have all changed.
         */
        $doc = self::build(self::times([]));

        self::assertSame(1, $doc['schema']);
        self::assertSame('900', $doc['route_id']);
        self::assertSame('20260819', $doc['service_date']);
        self::assertSame('260818_1456', $doc['feed_version']);
    }

    public function testFindsTheSevenFiftySouthboundAtSimondOnTheRealScheduleShards(): void
    {
        /*
         * The reason the endpoint exists, against the committed shards rather than a
         * hand-built one: stop 6293 is a minor stop on route 800 and 07:52:09 is the
         * arrival the worked example saves. The same tuple resolves to trip
         * 3010894_22201 in WatchResolutionTest, so the two documents agree about which
         * bus this is.
         */
        $dir = Runtime::root() . '/' . self::SHARD_DIR;
        Runtime::functionsOrSkip(
            $this,
            ['cm_shard_index', 'cm_shard_route', 'cm_shard_times', 'cm_shard_active_services'],
            ['runtime/lib/shards.php']
        );
        $index = cm_shard_index($dir);
        if ($index === null || !isset($index['routes']['800'])) {
            self::markTestSkipped(sprintf('no schedule shards for route 800 at %s. See tests/NOTES.md.', $dir));
        }

        $doc = cm_build_departures(
            cm_shard_route($dir, '800', $index),
            cm_shard_times($dir, '800', $index),
            cm_shard_active_services($index, '20260819'),
            '20260819',
            (string) $index['feed_version'],
            1787152239
        );

        $atSimond = ((array) $doc['departures'])['6293'] ?? [];
        self::assertCount(98, $atSimond, 'stop 6293 should carry a full service day of departures');

        $match = null;
        foreach ($atSimond as [$arrival, $index_of_trip]) {
            if ($arrival === 7 * 3600 + 52 * 60 + 9) {
                $match = $doc['trips'][$index_of_trip];
            }
        }

        self::assertNotNull($match, 'the 07:52:09 departure the worked example saves is missing');
        self::assertSame('3010894_22201', $match['id']);
        self::assertSame(1, $match['direction_id']);
    }

    public function testTheRealSimondRowIsAMinorStopWhichIsWhyTheWindowedScheduleCannotAnswerThis(): void
    {
        /*
         * If 6293 were a timepoint, route.schedule (section 3.2) would already carry it
         * and this endpoint would be redundant at least for this watch. It is not: the
         * premise of section 16 is that timepoint-only is not enough, and this asserts the
         * premise against real data rather than trusting it.
         */
        $dir = Runtime::root() . '/' . self::SHARD_DIR;
        Runtime::functionsOrSkip($this, ['cm_shard_index', 'cm_shard_route', 'cm_shard_times'], ['runtime/lib/shards.php']);
        $index = cm_shard_index($dir);
        if ($index === null || !isset($index['routes']['800'])) {
            self::markTestSkipped(sprintf('no schedule shards for route 800 at %s. See tests/NOTES.md.', $dir));
        }

        $doc = cm_build_departures(
            cm_shard_route($dir, '800', $index),
            cm_shard_times($dir, '800', $index),
            cm_shard_active_services($index, '20260819'),
            '20260819',
            (string) $index['feed_version'],
            1787152239
        );

        $rows = array_values(array_filter($doc['stops'], static fn (array $s): bool => $s['stop_id'] === '6293'));

        self::assertCount(1, $rows, 'stop 6293 serves one direction on route 800');
        self::assertSame(1, $rows[0]['direction_id']);
        self::assertFalse($rows[0]['is_timepoint']);
        self::assertSame('Simond SB', $rows[0]['stop_name']);
    }

    public function testTheGeneratedBoardStillCarriesAnArrivalPastMidnight(): void
    {
        /*
         * Criterion 17, against what was actually written rather than against a synthetic
         * trip. Route 800's last arrival on 20260819 is 89760, which is 24:56:00. If a
         * future encoder or a client-shaped "tidy up" ever wraps these, this is the file
         * that proves it happened.
         */
        $doc = $this->generated('800');

        $latest = 0;
        foreach ((array) $doc['departures'] as $rows) {
            foreach ($rows as [$arrival, $unused]) {
                $latest = max($latest, (int) $arrival);
            }
        }

        self::assertGreaterThan(86400, $latest);
    }

    public function testTheGeneratedBoardAndTheRouteFileAgreeOnWhichTripsAreSpecial(): void
    {
        /*
         * Criterion 18. Route 4 is the one with the Austin High run, so it is the route
         * where two definitions of "special" would first diverge. Every vehicle's flag
         * must match the flag the board publishes for the same trip id.
         */
        $board = $this->generated('4');
        $route = $this->generatedRoute('4');

        $byTrip = array_combine(array_column($board['trips'], 'id'), array_column($board['trips'], 'is_special'));

        $compared = 0;
        foreach ($route['vehicles'] as $vehicle) {
            $tripId = $vehicle['trip']['trip_id'] ?? null;
            if ($tripId === null || !array_key_exists($tripId, $byTrip)) {
                continue;
            }
            $compared++;
            self::assertSame(
                $vehicle['pattern']['is_special'],
                $byTrip[$tripId],
                sprintf('trip %s is special in one document and ordinary in the other', $tripId)
            );
        }

        self::assertGreaterThan(0, $compared, 'no route 4 vehicle trip appeared in the departure board');
    }

    private function generated(string $routeId): array
    {
        return $this->readGenerated('/api/departures/' . $routeId . '.json');
    }

    private function generatedRoute(string $routeId): array
    {
        return $this->readGenerated('/api/route/' . $routeId . '.json');
    }

    private function readGenerated(string $rel): array
    {
        $path = Fixtures::webroot() . $rel;
        if (!is_file($path)) {
            self::markTestSkipped(sprintf(
                'no generated output at %s. Regenerate with runtime/config.fixture.php and set '
                . 'CAPMETRO_WEBROOT. See tests/NOTES.md.',
                $path
            ));
        }

        return json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    }
}
