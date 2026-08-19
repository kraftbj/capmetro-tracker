<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Fixtures;
use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\TestCase;

/**
 * Contract section 3: three independent sources say a stop is not served, and
 * they disagree.
 *
 * Silent failure 4 lives here. Only 1 of the 5 realtime-skipped stops in the
 * capture also had an alert, so an implementation that checks one source and
 * stops will render a closed stop as served and send someone to wait at it.
 */
final class StopServiceStatusTest extends TestCase
{
    private const FILES = ['runtime/lib/stopstatus.php'];

    protected function setUp(): void
    {
        Runtime::functionsOrSkip($this, ['cm_stop_service_status'], self::FILES);
    }

    public function testARealtimeSkipOutranksAnAlertBecauseItIsTheMostSpecificStatement(): void
    {
        $result = cm_stop_service_status(12, true, true);

        self::assertFalse($result['served']);
        self::assertSame('realtime_skipped', $result['source']);
    }

    public function testAnAlertOutranksAPatternSkip(): void
    {
        $result = cm_stop_service_status(0, true, true);

        self::assertFalse($result['served']);
        self::assertSame('alert_no_service', $result['source']);
    }

    public function testAPatternSkipStandsWhenNothingElseApplies(): void
    {
        $result = cm_stop_service_status(0, false, true);

        self::assertFalse($result['served']);
        self::assertSame('pattern_skip', $result['source']);
    }

    public function testAStopWithNoSignalIsServedWithANullSourceRatherThanAnEmptyString(): void
    {
        $result = cm_stop_service_status(0, false, false);

        self::assertTrue($result['served']);
        self::assertNull($result['source']);
        self::assertNull($result['detail']);
    }

    public function testEveryUnservedStopNamesWhyInWordsAUserCanRead(): void
    {
        foreach ([[7, false, false], [0, true, false], [0, false, true]] as [$skips, $alert, $pattern]) {
            $result = cm_stop_service_status($skips, $alert, $pattern);

            self::assertFalse($result['served']);
            self::assertNotNull($result['source']);
            self::assertIsString($result['detail']);
            self::assertNotSame('', $result['detail']);
        }
    }

    public function testCountsTheSkipsInTheDetailSoTheUserSeesHowMuchItIsHappeningToday(): void
    {
        self::assertStringContainsString('123', cm_stop_service_status(123, false, false)['detail']);
        self::assertStringContainsString('1 trip today', cm_stop_service_status(1, false, false)['detail']);
    }

    public function testUsesTheSuppliedPatternDetailWhenOneIsGivenRatherThanAGenericString(): void
    {
        $result = cm_stop_service_status(0, false, true, 'Only served by the 08:15 Austin High run');

        self::assertSame('Only served by the 08:15 Austin High run', $result['detail']);
    }

    public function testASingleSkipStillMarksTheStopUnservedRatherThanRoundingItAway(): void
    {
        self::assertFalse(cm_stop_service_status(1, false, false)['served']);
    }

    public function testTheCaptureReallyDoesDisagreeAcrossSources(): void
    {
        // If this stops being true, the precedence rule above is untested in
        // practice whatever the unit tests say.
        $skippedStops = [];
        foreach (Fixtures::feed('tripupdates.json')['entity'] as $entity) {
            foreach ($entity['tripUpdate']['stopTimeUpdate'] ?? [] as $stu) {
                if (($stu['scheduleRelationship'] ?? '') === 'SKIPPED') {
                    $skippedStops[(string) $stu['stopId']] = true;
                }
            }
        }

        $alertStops = [];
        foreach (Fixtures::feed('servicealerts.json') as $alert) {
            if (($alert['effect'] ?? '') !== 'NO_SERVICE') {
                continue;
            }
            foreach ($alert['informedEntities'] ?? [] as $entity) {
                if (isset($entity['stopId'])) {
                    $alertStops[(string) $entity['stopId']] = true;
                }
            }
        }

        self::assertCount(5, $skippedStops, 'the capture no longer has 5 realtime-skipped stops');
        self::assertNotEmpty($alertStops);
        self::assertCount(
            1,
            array_intersect_key($skippedStops, $alertStops),
            'the two sources overlap on exactly one stop; they are largely independent signals'
        );
    }

    public function testStopNineteenSixtySevenIsClosedByAnAlertAndNotByARealtimeSkip(): void
    {
        // Criterion 6 in one sentence: this stop is only ever caught by source 2.
        $skipped = false;
        foreach (Fixtures::feed('tripupdates.json')['entity'] as $entity) {
            foreach ($entity['tripUpdate']['stopTimeUpdate'] ?? [] as $stu) {
                if ((string) ($stu['stopId'] ?? '') === '1967' && ($stu['scheduleRelationship'] ?? '') === 'SKIPPED') {
                    $skipped = true;
                }
            }
        }

        self::assertFalse($skipped, 'stop 1967 is not realtime-skipped, so only the alert can catch it');
        self::assertSame('alert_no_service', cm_stop_service_status(0, true, false)['source']);
    }
}
