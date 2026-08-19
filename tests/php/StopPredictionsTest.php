<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use PHPUnit\Framework\TestCase;

/**
 * Vehicle.predictions: the arrival times the board publishes for stops still ahead of a
 * bus, and the rules that keep them honest.
 *
 * The field exists so a client can answer "when does this bus reach MY stop" without
 * inventing anything. Every failure mode below produces a number that looks perfectly
 * reasonable on screen:
 *
 *   - a SKIPPED stop published as an arrival is a bus that is not going to stop there;
 *   - an out-of-order feed read in array order puts a later stop first, so the countdown
 *     to your stop is measured from the wrong row;
 *   - a stop behind the bus published as upcoming is a countdown to a bus that has
 *     already gone past;
 *   - a prediction that survives staleness suppression is the one number a reader trusts
 *     most, computed from data the board has already admitted it cannot stand behind.
 *
 * The list also shares its filter with cm_adherence_pick_anchor() by construction, and
 * one test pins that: two implementations of "the first stop ahead of the bus" would
 * drift, and the symptom would be a board whose arrival time contradicts its own
 * lateness number.
 */
final class StopPredictionsTest extends TestCase
{
    /** @return array<int,array<string,mixed>> */
    private function stopTimeUpdates(): array
    {
        return [
            ['stopSequence' => 10, 'stopId' => 'A', 'arrival' => ['time' => '1000']],
            ['stopSequence' => 11, 'stopId' => 'B', 'arrival' => ['time' => '1100']],
            ['stopSequence' => 12, 'stopId' => 'C', 'arrival' => ['time' => '1200']],
        ];
    }

    public function testKeepsOnlyStopsAtOrAheadOfTheBus(): void
    {
        $rows = cm_stop_predictions($this->stopTimeUpdates(), 11);

        $this->assertSame([11, 12], array_column($rows, 'stop_sequence'));
    }

    public function testTheCurrentStopIsAheadOfTheBusNotBehindIt(): void
    {
        /* STOPPED_AT stop 11 still has stop 11 ahead of it: the bus is there now, and a
           rider standing there wants to see it. >= not >. */
        $rows = cm_stop_predictions($this->stopTimeUpdates(), 11);

        $this->assertSame(11, $rows[0]['stop_sequence']);
    }

    public function testSortsByStopSequenceRatherThanFeedOrder(): void
    {
        $shuffled = [
            ['stopSequence' => 12, 'stopId' => 'C', 'arrival' => ['time' => '1200']],
            ['stopSequence' => 10, 'stopId' => 'A', 'arrival' => ['time' => '1000']],
            ['stopSequence' => 11, 'stopId' => 'B', 'arrival' => ['time' => '1100']],
        ];

        $rows = cm_stop_predictions($shuffled, 0);

        $this->assertSame([10, 11, 12], array_column($rows, 'stop_sequence'));
    }

    public function testDropsSkippedStops(): void
    {
        $stus = $this->stopTimeUpdates();
        $stus[1]['scheduleRelationship'] = 'SKIPPED';

        $rows = cm_stop_predictions($stus, 0);

        $this->assertSame([10, 12], array_column($rows, 'stop_sequence'));
    }

    public function testDropsEntriesWithNoTimeAtAll(): void
    {
        $stus = $this->stopTimeUpdates();
        unset($stus[2]['arrival']);

        $rows = cm_stop_predictions($stus, 0);

        $this->assertSame([10, 11], array_column($rows, 'stop_sequence'));
    }

    public function testArrivalWinsOverDepartureWhenBothArePresent(): void
    {
        $rows = cm_stop_predictions([
            [
                'stopSequence' => 5,
                'stopId'       => 'A',
                'arrival'      => ['time' => '900'],
                'departure'    => ['time' => '960'],
            ],
        ], 0);

        $this->assertSame(900, $rows[0]['predicted_at']);
    }

    public function testFallsBackToDepartureWhenThereIsNoArrival(): void
    {
        $rows = cm_stop_predictions([
            ['stopSequence' => 5, 'stopId' => 'A', 'departure' => ['time' => '960']],
        ], 0);

        $this->assertSame(960, $rows[0]['predicted_at']);
    }

    /**
     * The anchor is the first row of the list. Written twice, the two would drift.
     */
    public function testTheAdherenceAnchorIsTheFirstPrediction(): void
    {
        $stus = $this->stopTimeUpdates();
        $stus[0]['scheduleRelationship'] = 'SKIPPED';

        $anchor = cm_adherence_pick_anchor($stus, 0);
        $first = cm_stop_predictions($stus, 0)[0];

        $this->assertSame($first, $anchor);
    }

    /* ---- the published field -------------------------------------------- */

    /**
     * @param array<string,mixed> $overrides
     * @return array<string,mixed>
     */
    private function buildVehicle(array $overrides = []): array
    {
        $entity = [
            'id'      => 'v1',
            'vehicle' => [
                'vehicle'             => ['id' => '2701'],
                'trip'                => [
                    'tripId'    => 'T1',
                    'routeId'   => '4',
                    'startTime' => '08:00:00',
                    'startDate' => '20260819',
                    'directionId' => 0,
                ],
                'position'            => ['latitude' => 30.26, 'longitude' => -97.74],
                'timestamp'           => 1000,
                'currentStopSequence' => $overrides['css'] ?? 10,
            ],
        ];
        if (array_key_exists('css', $overrides) && $overrides['css'] === null) {
            $entity['vehicle']['currentStopSequence'] = null;
        }

        /* array_key_exists, not ??: a test that passes null MEANS null here. */
        $trip_update = array_key_exists('trip_update', $overrides)
            ? $overrides['trip_update']
            : [
                'trip'           => ['tripId' => 'T1', 'routeId' => '4'],
                'stopTimeUpdate' => $this->stopTimeUpdates(),
            ];

        return cm_build_vehicle(
            $entity,
            ['trips' => ['T1' => ['direction_id' => 0, 'pattern' => null, 'service_id' => 'S']]],
            ['trips' => ['T1' => ['headsign' => '4 Mopac WB', 'service_id' => 'S']]],
            $trip_update,
            $overrides['suppress'] ?? false,
            '4',
            $overrides['now'] ?? 0
        );
    }

    public function testPublishesCompactTriples(): void
    {
        $veh = $this->buildVehicle();

        $this->assertSame(
            [[10, 'A', 1000], [11, 'B', 1100], [12, 'C', 1200]],
            $veh['predictions']
        );
    }

    public function testStalenessSuppressesPredictionsExactlyAsItSuppressesLateness(): void
    {
        $veh = $this->buildVehicle(['suppress' => true]);

        $this->assertSame([], $veh['predictions']);
        $this->assertSame('unknown', $veh['adherence']['state']);
        $this->assertSame('stale_data', $veh['adherence']['reason']);
    }

    public function testNoCurrentStopSequenceMeansNoPredictions(): void
    {
        /* With no idea where the bus is, "ahead of it" has no meaning and every row
           would be a guess about which stops it has already passed. */
        $veh = $this->buildVehicle(['css' => null]);

        $this->assertSame([], $veh['predictions']);
    }

    public function testNoTripUpdateMeansAnEmptyListRatherThanAMissingField(): void
    {
        $veh = $this->buildVehicle(['trip_update' => null]);

        $this->assertArrayHasKey('predictions', $veh);
        $this->assertSame([], $veh['predictions']);
    }

    public function testDropsPredictionsBeyondTheScheduleWindow(): void
    {
        /* now = 500 puts the 45-minute horizon at 3200, so the 1200 row survives and a
           far-future one does not. The horizon is the section 3.2 window, not a number
           invented for this field. */
        $far = $this->stopTimeUpdates();
        $far[] = ['stopSequence' => 13, 'stopId' => 'D', 'arrival' => ['time' => '9999']];

        $veh = $this->buildVehicle([
            'now'         => 500,
            'trip_update' => ['trip' => ['tripId' => 'T1'], 'stopTimeUpdate' => $far],
        ]);

        $this->assertSame([10, 11, 12], array_column($veh['predictions'], 0));
    }

    public function testDropsPredictionsThatNameNoStop(): void
    {
        /* A prediction nobody can join to a stop cannot answer "when is it at MY stop". */
        $veh = $this->buildVehicle([
            'trip_update' => [
                'trip'           => ['tripId' => 'T1'],
                'stopTimeUpdate' => [
                    ['stopSequence' => 10, 'arrival' => ['time' => '1000']],
                    ['stopSequence' => 11, 'stopId' => 'B', 'arrival' => ['time' => '1100']],
                ],
            ],
        ]);

        $this->assertSame([[11, 'B', 1100]], $veh['predictions']);
    }

    public function testADeadheadCarriesNoPredictionsField(): void
    {
        /* A bus with no trip has no stops ahead of it, and the schema forbids the field
           on one. */
        $veh = cm_build_vehicle(
            ['id' => 'v2', 'vehicle' => [
                'vehicle'   => ['id' => '2305'],
                'position'  => ['latitude' => 30.26, 'longitude' => -97.74],
                'timestamp' => 1000,
            ]],
            null,
            [],
            null,
            false,
            null,
            1000
        );

        $this->assertFalse($veh['in_service']);
        $this->assertArrayNotHasKey('predictions', $veh);
    }
}
