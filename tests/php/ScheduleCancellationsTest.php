<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\TestCase;

/**
 * Regression: schedule.canceled_trips was empty on every route from the day it shipped.
 * Found on 2026-08-20 while checking the cancellation path against real generated output.
 *
 * cm_build_schedule() builds the map of canceled trip ids into $canceled at the top, and
 * the trip loop below it then assigned a per-trip BOOLEAN to the same variable name. By
 * the time canceled_trips was assembled, $canceled was a bool, and isset() on a bool with
 * a string offset returns false for every key. The published list was therefore always [].
 *
 * Nothing caught it. There is no error and no warning; the field is present and the schema
 * only requires that it exists, so a plausible empty array validated cleanly. It surfaced
 * only by comparing the two carriers over real output: 100 cancellations in the feed, 100
 * in the departures documents, 0 in canceled_trips.
 *
 * That mattered because canceled_trips is the ONLY carrier that can deliver a cancellation
 * announced after the departures document was cached -- see contract section 16. The client
 * fix that reads it is worthless while this returns nothing.
 *
 * The assertion below is deliberately about a canceled trip INSIDE the window, because the
 * window scoping is correct and intended: canceled_trips names only what the ladder drew.
 */
final class ScheduleCancellationsTest extends TestCase
{
    private const FILES = ['runtime/lib/join.php'];

    protected function setUp(): void
    {
        Runtime::functionsOrSkip(
            $this,
            ['cm_build_schedule', 'cm_canceled_trip_ids'],
            self::FILES
        );
    }

    /** Midnight for the service date the fixtures below use, America/Chicago. */
    private const SERVICE_DATE = '20260819';

    /**
     * Two trips on one direction, both inside the window, one of them canceled.
     */
    private static function times(int $midnight, int $now): array
    {
        $a = $now - $midnight + 600;   /* ten minutes out, inside +45 */
        $b = $now - $midnight + 1200;
        return [
            'trips' => [
                'TRIP_RUNNING'  => [
                    'service_id' => 'S1', 'direction_id' => 0, 'headsign' => 'NB',
                    'stops' => [[0, 0, $a], [1, 1, $a + 300]],
                ],
                'TRIP_CANCELED' => [
                    'service_id' => 'S1', 'direction_id' => 0, 'headsign' => 'NB',
                    'stops' => [[0, 0, $b], [1, 1, $b + 300]],
                ],
            ],
            'stop_ids' => ['A', 'B'],
        ];
    }

    private static function tripUpdates(): array
    {
        return [
            'TRIP_CANCELED' => ['trip' => ['tripId' => 'TRIP_CANCELED', 'scheduleRelationship' => 'CANCELED']],
            'TRIP_RUNNING'  => ['trip' => ['tripId' => 'TRIP_RUNNING',  'scheduleRelationship' => 'SCHEDULED']],
        ];
    }

    private function build(array $tripUpdates): array
    {
        $now = cm_service_day_midnight(self::SERVICE_DATE) + 36000; /* 10:00 local */
        $midnight = cm_service_day_midnight(self::SERVICE_DATE);
        return cm_build_schedule(
            self::times($midnight, $now),
            [['stop_id' => 'A', 'direction_id' => 0], ['stop_id' => 'B', 'direction_id' => 0]],
            [['id' => 0, 'headsign' => 'NB']],
            ['S1' => true],
            $tripUpdates,
            self::SERVICE_DATE,
            $now
        );
    }

    public function testCanceledTripsNamesATripTheLadderDrew(): void
    {
        $schedule = $this->build(self::tripUpdates());

        $drawn = [];
        foreach ($schedule['directions'] as $d) {
            foreach ($d['trips'] as $row) {
                $drawn[] = $row[0];
            }
        }
        self::assertContains('TRIP_CANCELED', $drawn, 'the canceled trip must be in the window for this test to mean anything');

        self::assertSame(
            ['TRIP_CANCELED'],
            $schedule['canceled_trips'],
            'canceled_trips must name the canceled trip the ladder drew'
        );
    }

    public function testARunningTripIsNotListed(): void
    {
        $schedule = $this->build(self::tripUpdates());
        self::assertNotContains('TRIP_RUNNING', $schedule['canceled_trips']);
    }

    public function testNoCancellationsYieldsAnEmptyList(): void
    {
        $schedule = $this->build([
            'TRIP_CANCELED' => ['trip' => ['tripId' => 'TRIP_CANCELED', 'scheduleRelationship' => 'SCHEDULED']],
            'TRIP_RUNNING'  => ['trip' => ['tripId' => 'TRIP_RUNNING',  'scheduleRelationship' => 'SCHEDULED']],
        ]);
        self::assertSame([], $schedule['canceled_trips']);
    }

    /**
     * The bug was a variable name collision, so this pins the other half of it: the trip
     * loop's own use of cancellation still has to work. next_departure must skip a canceled
     * trip and name the running one.
     */
    public function testNextDepartureStillSkipsACanceledTrip(): void
    {
        $schedule = $this->build(self::tripUpdates());
        self::assertNotNull($schedule['next_departure']);
        self::assertSame('TRIP_RUNNING', $schedule['next_departure']['trip_id']);
    }
}
