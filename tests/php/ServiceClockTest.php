<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Fixtures;
use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * Silent failures 3 and 5: service-day time resolution.
 *
 * A GTFS clock string is not a wall-clock time. It is an offset from noon on the
 * service date minus twelve hours, in America/Chicago, and its hour field may
 * exceed 23. Get the anchor wrong and every lateness number on a DST day is off
 * by an hour with nothing in the logs; reject the hour and a whole class of
 * trips silently vanishes.
 *
 * The expected epochs live in the fixtures and were computed from the IANA
 * database, so the test and the implementation cannot agree on the same bug.
 */
final class ServiceClockTest extends TestCase
{
    private const FILES = ['runtime/lib/servicetime.php'];

    protected function setUp(): void
    {
        Runtime::functionsOrSkip($this, ['cm_clock_to_epoch', 'cm_service_day_midnight', 'cm_clock_to_seconds'], self::FILES);
    }

    public function testResolvesAClockHourPastTwentyThreeToTheFollowingMorning(): void
    {
        $expected = Fixtures::synthetic('after-midnight-tripupdate.json')['_expected'];

        self::assertSame($expected['start_epoch'], cm_clock_to_epoch('25:10:00', '20260819'));
    }

    public function testAcceptsTheWholeAfterMidnightRangeInsteadOfRejectingItAsInvalid(): void
    {
        foreach (['24:00:00', '25:10:00', '27:59:59', '28:29:00'] as $value) {
            self::assertIsInt(cm_clock_to_epoch($value, '20260819'), "{$value} was rejected");
        }
    }

    public function testKeepsAnAfterMidnightTripAfterTheLateEveningTripItFollows(): void
    {
        self::assertGreaterThan(
            cm_clock_to_epoch('23:50:00', '20260819'),
            cm_clock_to_epoch('25:10:00', '20260819')
        );
        self::assertSame(
            86400,
            cm_clock_to_epoch('25:10:00', '20260819') - cm_clock_to_epoch('01:10:00', '20260819')
        );
    }

    public function testRoundTripsAnAfterMidnightClockStringWithoutWrappingItAtTwentyFour(): void
    {
        Runtime::functionsOrSkip($this, ['cm_seconds_to_clock'], self::FILES);

        self::assertSame('25:10:00', cm_seconds_to_clock(cm_clock_to_seconds('25:10:00')));
    }

    public function testAnchorsTheSpringForwardServiceDayAtNoonMinusTwelveHoursRatherThanLocalMidnight(): void
    {
        $f = Fixtures::synthetic('dst-spring-forward-20260308.json');

        self::assertSame($f['service_day_midnight_epoch'], cm_service_day_midnight('20260308'));
        self::assertNotSame(
            $f['local_midnight_epoch'],
            cm_service_day_midnight('20260308'),
            'local midnight is an hour off on a 23-hour service day'
        );
    }

    public function testAnchorsTheFallBackServiceDayAtNoonMinusTwelveHoursRatherThanLocalMidnight(): void
    {
        $f = Fixtures::synthetic('dst-fall-back-20261101.json');

        self::assertSame($f['service_day_midnight_epoch'], cm_service_day_midnight('20261101'));
        self::assertNotSame(
            $f['local_midnight_epoch'],
            cm_service_day_midnight('20261101'),
            'local midnight is an hour off on a 25-hour service day'
        );
    }

    #[DataProvider('dstCases')]
    public function testResolvesEveryClockTimeOnADaylightSavingTransitionDay(
        string $serviceDate,
        string $clock,
        int $expectedEpoch,
        string $note
    ): void {
        self::assertSame($expectedEpoch, cm_clock_to_epoch($clock, $serviceDate), $note);
    }

    /** @return iterable<string, array{string, string, int, string}> */
    public static function dstCases(): iterable
    {
        foreach (['dst-spring-forward-20260308.json', 'dst-fall-back-20261101.json'] as $file) {
            $f = Fixtures::synthetic($file);
            foreach ($f['cases'] as $case) {
                yield "{$f['service_date']} {$case['clock']}" => [
                    $f['service_date'],
                    $case['clock'],
                    $case['expected_epoch'],
                    $case['note'],
                ];
            }
        }
    }

    public function testLandsNoonOnActualLocalNoonOnBothTransitionDays(): void
    {
        foreach (['dst-spring-forward-20260308.json', 'dst-fall-back-20261101.json'] as $file) {
            $f = Fixtures::synthetic($file);
            $noon = null;
            foreach ($f['cases'] as $case) {
                if ($case['clock'] === '12:00:00') {
                    $noon = $case;
                }
            }

            self::assertNotNull($noon, "fixture {$file} lost its noon case");
            self::assertSame($noon['expected_epoch'], cm_clock_to_epoch('12:00:00', $f['service_date']));
            self::assertStringContainsString('T12:00:00', $noon['expected_local_iso']);
        }
    }

    public function testSeparatesTheTwoLocalOneThirtiesOnTheFallBackDate(): void
    {
        // Local 01:30 happens twice on 2026-11-01. Because the service day
        // starts at 01:00 CDT, clock 00:30 is the first and clock 01:30 is the
        // second. An implementation that parses the wall-clock label instead of
        // adding seconds to the anchor collapses them into one instant.
        $first  = cm_clock_to_epoch('00:30:00', '20261101');
        $second = cm_clock_to_epoch('01:30:00', '20261101');

        $ct = new \DateTimeZone('America/Chicago');
        $label = static fn (int $epoch): string =>
            (new \DateTimeImmutable('@' . $epoch))->setTimezone($ct)->format('H:i');

        self::assertSame(3600, $second - $first);
        self::assertSame('01:30', $label($first));
        self::assertSame('01:30', $label($second));
    }

    public function testResolvesAnOrdinaryServiceDateIdenticallyEitherWay(): void
    {
        // On 366 days a year the naive anchor also works, which is exactly why
        // this bug survives review and ships.
        $expected = Fixtures::synthetic('after-midnight-tripupdate.json')['_expected'];

        self::assertSame($expected['service_day_midnight_epoch'], cm_service_day_midnight('20260819'));
    }

    public function testReturnsNullForAMalformedClockStringRatherThanCoercingItToZero(): void
    {
        foreach (['', 'noon', '10:5', '10:61:00', '--:--:--'] as $bad) {
            self::assertNull(cm_clock_to_seconds($bad), "'{$bad}' was accepted");
            self::assertNull(cm_clock_to_epoch($bad, '20260819'), "'{$bad}' was accepted");
        }
    }

    public function testReturnsNullForAnImpossibleServiceDateRatherThanRollingItOver(): void
    {
        foreach (['20260231', '2026081', 'yesterday', ''] as $bad) {
            self::assertNull(cm_service_day_midnight($bad), "'{$bad}' was accepted");
        }
    }

    public function testResolvesEveryTripStartTimeInTheCapturedFeedWithoutRejectingOne(): void
    {
        // The real feed is the strongest available guard against a parser that
        // only handles the shapes someone thought to write a test for.
        $rejected = [];
        foreach (Fixtures::feed('tripupdates.json')['entity'] as $entity) {
            $trip = $entity['tripUpdate']['trip'];
            $epoch = cm_clock_to_epoch((string) $trip['startTime'], (string) $trip['startDate']);
            if ($epoch === null) {
                $rejected[] = $trip['startTime'];
            }
        }

        self::assertSame([], array_slice(array_unique($rejected), 0, 10));
    }
}
