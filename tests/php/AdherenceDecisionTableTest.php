<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Fixtures;
use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * Contract section 2: the adherence decision table, evaluated in order.
 *
 * Order is the substance of it. A canceled trip that falls through to the
 * arithmetic produces a lateness number for a bus that is not running, and a
 * stale feed that falls through produces one for data nobody should trust.
 * Both look exactly like a correct answer on screen.
 */
final class AdherenceDecisionTableTest extends TestCase
{
    private const FILES = ['runtime/lib/adherence.php'];

    protected function setUp(): void
    {
        Runtime::functionsOrSkip($this, ['cm_adherence_evaluate', 'cm_adherence_glyph', 'cm_adherence_classify'], self::FILES);
    }

    /** A minimal on-time input that each test mutates one field at a time. */
    private function baseline(): array
    {
        return [
            'in_service' => true,
            'schedule_relationship' => 'SCHEDULED',
            'trip_update' => [
                'trip' => ['tripId' => '3014769_15202', 'scheduleRelationship' => 'SCHEDULED'],
                'stopTimeUpdate' => [
                    ['stopSequence' => 5, 'stopId' => '2107', 'arrival' => ['time' => '1787152284'], 'scheduleRelationship' => 'SCHEDULED'],
                ],
            ],
            'trip_in_schedule' => true,
            'suppress_adherence' => false,
            'current_stop_sequence' => 5,
            'scheduled' => [5 => ['stop_id' => '2107', 'stop_name' => '5th/Bowie', 'scheduled_at' => 1787152297]],
        ];
    }

    public function testTheBaselineInputIsOnTimeSoEveryOtherTestIsolatesOneChange(): void
    {
        $result = cm_adherence_evaluate($this->baseline());

        self::assertSame('ontime', $result['state']);
        self::assertSame(-13, $result['seconds']);
    }

    public function testRowOneCallsAVehicleWithNoTripADeadheadBeforeAnythingElseIsConsidered(): void
    {
        $in = $this->baseline();
        $in['in_service'] = false;
        // Everything else still looks computable; row 1 must win anyway.

        $result = cm_adherence_evaluate($in);

        self::assertSame('deadhead', $result['state']);
        self::assertNull($result['seconds']);
        self::assertSame('ring', $result['glyph']);
        self::assertNull($result['against']);
    }

    public function testRowTwoCallsACanceledTripUnknownRatherThanTimingABusThatIsNotRunning(): void
    {
        $in = $this->baseline();
        $in['schedule_relationship'] = 'CANCELED';

        $result = cm_adherence_evaluate($in);

        self::assertSame('unknown', $result['state']);
        self::assertSame('trip_canceled', $result['reason']);
        self::assertNull($result['seconds']);
    }

    public function testRowTwoAlsoFiresWhenOnlyTheTripUpdateSaysCanceled(): void
    {
        $in = $this->baseline();
        $in['trip_update']['trip']['scheduleRelationship'] = 'CANCELED';

        self::assertSame('trip_canceled', cm_adherence_evaluate($in)['reason']);
    }

    public function testRowThreeCallsAVehicleWithNoTripUpdateUnknownRatherThanOnTime(): void
    {
        $in = $this->baseline();
        $in['trip_update'] = null;

        $result = cm_adherence_evaluate($in);

        self::assertSame('unknown', $result['state']);
        self::assertSame('no_trip_update', $result['reason']);
    }

    public function testRowFourCallsATripUpdateWithNoStopPredictionsUnknown(): void
    {
        $in = $this->baseline();
        $in['trip_update']['stopTimeUpdate'] = [];

        self::assertSame('no_stop_predictions', cm_adherence_evaluate($in)['reason']);
    }

    public function testRowFiveCallsATripMissingFromTheScheduleShardUnknown(): void
    {
        // This is silent failure 1 arriving one vehicle at a time.
        $in = $this->baseline();
        $in['trip_in_schedule'] = false;

        self::assertSame('trip_not_in_schedule', cm_adherence_evaluate($in)['reason']);
    }

    public function testRowSixSuppressesLatenessWhenFeedsAreStaleEvenThoughTheArithmeticWouldSucceed(): void
    {
        $in = $this->baseline();
        $in['suppress_adherence'] = true;

        $result = cm_adherence_evaluate($in);

        self::assertSame('unknown', $result['state']);
        self::assertSame('stale_data', $result['reason']);
        self::assertNull($result['seconds']);
        self::assertNull($result['against']);
    }

    public function testRowSixBCallsAVehicleWithNoStopSequenceUnknownInsteadOfAnchoringAtZero(): void
    {
        $in = $this->baseline();
        $in['current_stop_sequence'] = null;

        $result = cm_adherence_evaluate($in);

        self::assertSame('unknown', $result['state']);
        self::assertSame('no_progress', $result['reason']);
    }

    public function testRowFiveOutranksRowSixSoAMissingScheduleIsNotReportedAsStaleData(): void
    {
        // Both conditions true at once; the table says the shard problem is the
        // one to name, because that is the one an operator can fix.
        $in = $this->baseline();
        $in['trip_in_schedule'] = false;
        $in['suppress_adherence'] = true;

        self::assertSame('trip_not_in_schedule', cm_adherence_evaluate($in)['reason']);
    }

    #[DataProvider('boundaries')]
    public function testGradesLatenessAtEveryBoundaryOfTheTable(int $seconds, string $expectedState, string $expectedGlyph): void
    {
        $in = $this->baseline();
        $in['trip_update']['stopTimeUpdate'][0]['arrival']['time'] = (string) (1787152297 + $seconds);

        $result = cm_adherence_evaluate($in);

        self::assertSame($expectedState, $result['state'], "{$seconds}s should be {$expectedState}");
        self::assertSame($seconds, $result['seconds']);
        self::assertSame($expectedGlyph, $result['glyph']);
    }

    /** @return iterable<string, array{int, string, string}> */
    public static function boundaries(): iterable
    {
        yield 'four minutes early'   => [-240, 'early', 'left-triangle'];
        yield 'one second early'     => [-61, 'early', 'left-triangle'];
        yield 'the early boundary'   => [-60, 'ontime', 'circle'];
        yield 'exactly on time'      => [0, 'ontime', 'circle'];
        yield 'the ontime boundary'  => [150, 'ontime', 'circle'];
        yield 'one second late'      => [151, 'late', 'up-triangle'];
        yield 'the late boundary'    => [360, 'late', 'up-triangle'];
        yield 'one second very late' => [361, 'very_late', 'square'];
        yield 'twenty minutes late'  => [1200, 'very_late', 'square'];
    }

    public function testMeasuresAgainstTheFirstPredictedStopAtOrAfterTheVehiclesCurrentSequence(): void
    {
        $in = $this->baseline();
        $in['trip_update']['stopTimeUpdate'] = [
            ['stopSequence' => 3, 'stopId' => '1368', 'arrival' => ['time' => '1787151000'], 'scheduleRelationship' => 'SCHEDULED'],
            ['stopSequence' => 6, 'stopId' => '2107', 'arrival' => ['time' => '1787152500'], 'scheduleRelationship' => 'SCHEDULED'],
        ];
        $in['scheduled'] = [6 => ['stop_id' => '2107', 'stop_name' => '5th/Bowie', 'scheduled_at' => 1787152400]];

        $result = cm_adherence_evaluate($in);

        self::assertSame(6, $result['against']['stop_sequence'], 'a stop already passed must not be the anchor');
        self::assertSame(100, $result['seconds']);
    }

    public function testPicksTheEarliestStopAheadEvenWhenTheFeedListsPredictionsOutOfOrder(): void
    {
        $in = $this->baseline();
        $in['trip_update']['stopTimeUpdate'] = [
            ['stopSequence' => 9, 'stopId' => '5937', 'arrival' => ['time' => '1787153000'], 'scheduleRelationship' => 'SCHEDULED'],
            ['stopSequence' => 6, 'stopId' => '2107', 'arrival' => ['time' => '1787152500'], 'scheduleRelationship' => 'SCHEDULED'],
        ];
        $in['scheduled'] = [
            6 => ['stop_id' => '2107', 'stop_name' => '5th/Bowie', 'scheduled_at' => 1787152400],
            9 => ['stop_id' => '5937', 'stop_name' => 'Congress/5th', 'scheduled_at' => 1787152900],
        ];

        self::assertSame(6, cm_adherence_evaluate($in)['against']['stop_sequence']);
    }

    public function testSkipsAStopMarkedSkippedWhenChoosingTheAnchor(): void
    {
        $in = $this->baseline();
        $in['trip_update']['stopTimeUpdate'] = [
            ['stopSequence' => 5, 'stopId' => '2107', 'arrival' => ['time' => '1787152284'], 'scheduleRelationship' => 'SKIPPED'],
            ['stopSequence' => 7, 'stopId' => '5937', 'arrival' => ['time' => '1787152600'], 'scheduleRelationship' => 'SCHEDULED'],
        ];
        $in['scheduled'] = [7 => ['stop_id' => '5937', 'stop_name' => 'Congress/5th', 'scheduled_at' => 1787152500]];

        self::assertSame(7, cm_adherence_evaluate($in)['against']['stop_sequence']);
    }

    public function testSkipsAPredictionCarryingNeitherAnArrivalNorADeparture(): void
    {
        $in = $this->baseline();
        $in['trip_update']['stopTimeUpdate'] = [
            ['stopSequence' => 5, 'stopId' => '2107', 'scheduleRelationship' => 'SCHEDULED'],
            ['stopSequence' => 7, 'stopId' => '5937', 'arrival' => ['time' => '1787152600'], 'scheduleRelationship' => 'SCHEDULED'],
        ];
        $in['scheduled'] = [7 => ['stop_id' => '5937', 'stop_name' => 'Congress/5th', 'scheduled_at' => 1787152500]];

        self::assertSame(7, cm_adherence_evaluate($in)['against']['stop_sequence']);
    }

    public function testPrefersArrivalOverDepartureWhenAPredictionCarriesBoth(): void
    {
        $in = $this->baseline();
        $in['trip_update']['stopTimeUpdate'][0]['arrival'] = ['time' => '1787152357'];
        $in['trip_update']['stopTimeUpdate'][0]['departure'] = ['time' => '1787152900'];

        self::assertSame(60, cm_adherence_evaluate($in)['seconds'], 'departure won over arrival');
    }

    public function testFallsBackToDepartureWhenThereIsNoArrival(): void
    {
        $in = $this->baseline();
        unset($in['trip_update']['stopTimeUpdate'][0]['arrival']);
        $in['trip_update']['stopTimeUpdate'][0]['departure'] = ['time' => '1787152357'];

        self::assertSame(60, cm_adherence_evaluate($in)['seconds']);
    }

    public function testReportsUnknownRatherThanZeroWhenTheShardHasNoScheduledTimeAtTheAnchor(): void
    {
        $in = $this->baseline();
        $in['scheduled'] = [];

        $result = cm_adherence_evaluate($in);

        self::assertSame('unknown', $result['state']);
        self::assertNull($result['seconds']);
    }

    public function testEveryStateCarriesItsOwnGlyphSoTheBoardReadsInGrayscale(): void
    {
        $glyphs = [];
        foreach (['early', 'ontime', 'late', 'very_late', 'unknown', 'deadhead'] as $state) {
            $glyphs[] = cm_adherence_glyph($state);
        }

        self::assertCount(6, array_unique($glyphs));
        self::assertSame(
            ['left-triangle', 'circle', 'up-triangle', 'square', 'question', 'ring'],
            $glyphs
        );
    }

    public function testNeverEmitsALatenessNumberWithoutAnAnchorStopToExplainIt(): void
    {
        foreach (['deadhead', 'trip_canceled', 'no_trip_update', 'stale_data', 'no_progress'] as $case) {
            $in = $this->baseline();
            match ($case) {
                'deadhead' => $in['in_service'] = false,
                'trip_canceled' => $in['schedule_relationship'] = 'CANCELED',
                'no_trip_update' => $in['trip_update'] = null,
                'stale_data' => $in['suppress_adherence'] = true,
                'no_progress' => $in['current_stop_sequence'] = null,
            };

            $result = cm_adherence_evaluate($in);

            self::assertNull($result['seconds'], "{$case} carried a number");
            self::assertNull($result['against'], "{$case} carried an anchor");
        }
    }

    public function testReproducesEveryLatenessAlreadyRecordedInTheGoldenOutput(): void
    {
        foreach (Fixtures::goldenRoute4()['vehicles'] as $vehicle) {
            if ($vehicle['adherence']['seconds'] === null) {
                continue;
            }
            $against = $vehicle['adherence']['against'];

            self::assertSame(
                $vehicle['adherence']['seconds'],
                $against['predicted_at'] - $against['scheduled_at'],
                "vehicle {$vehicle['vehicle_id']} carries a lateness its own anchor does not explain"
            );
            self::assertSame(
                $vehicle['adherence']['state'],
                cm_adherence_classify($vehicle['adherence']['seconds'])
            );
        }
    }

    public function testGradesTheSyntheticFixturesToTheStatesTheyClaimToEncode(): void
    {
        $cases = [
            'canceled-trip-no-stop-updates.json' => ['schedule_relationship' => 'CANCELED'],
            'vehicle-without-trip-update.json' => ['trip_update' => null],
            'vehicle-null-current-stop-sequence.json' => ['current_stop_sequence' => null],
        ];

        foreach ($cases as $file => $mutation) {
            $expected = Fixtures::synthetic($file)['_expected'];
            $result = cm_adherence_evaluate(array_merge($this->baseline(), $mutation));

            self::assertSame($expected['adherence_state'], $result['state'], $file);
            self::assertSame($expected['adherence_reason'], $result['reason'], $file);
            self::assertSame($expected['glyph'], $result['glyph'], $file);
        }
    }
}
