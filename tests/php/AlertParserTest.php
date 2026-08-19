<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Fixtures;
use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\TestCase;

/**
 * Contract sections 5 and 6: parsing the alerts feed and stripping staff PII.
 *
 * The feed is a bespoke Socrata array, not GTFS-Realtime, and every object on it
 * carries the name and work email of the CapMetro employee who filed the alert.
 * Section 6 requires an allowlist, because a denylist passes today and leaks the
 * first time the agency adds a field.
 */
final class AlertParserTest extends TestCase
{
    private const FILES = ['runtime/lib/alerts.php'];
    private const CAPTURE_EPOCH = 1787152239;

    protected function setUp(): void
    {
        Runtime::functionsOrSkip($this, ['cm_alerts_parse', 'cm_alert_severity', 'cm_alerts_for_route'], self::FILES);
    }

    /** @return list<array{route_ids: list<string>, alert: array}> */
    private function parsed(?array $feed = null): array
    {
        return cm_alerts_parse($feed ?? Fixtures::feed('servicealerts.json'), self::CAPTURE_EPOCH);
    }

    /** @return list<string> every real staff name and address on the upstream feed */
    private function staffIdentifiers(): array
    {
        $values = [];
        foreach (Fixtures::feed('servicealerts.json') as $alert) {
            foreach (['userEmail', 'userFullname'] as $key) {
                $value = trim((string) ($alert[$key] ?? ''));
                if ($value !== '') {
                    $values[] = $value;
                }
            }
        }

        return array_values(array_unique($values));
    }

    public function testTheUpstreamFixtureStillCarriesTheStaffPiiThisParserExistsToStrip(): void
    {
        self::assertNotEmpty($this->staffIdentifiers(), 'the fixture lost its PII, so the stripping tests prove nothing');
    }

    public function testDropsTheFilingEmployeesEmailAndNameFromEveryParsedAlert(): void
    {
        $parsed = $this->parsed();

        self::assertNotEmpty($parsed);
        foreach ($parsed as $entry) {
            self::assertArrayNotHasKey('userEmail', $entry['alert']);
            self::assertArrayNotHasKey('userFullname', $entry['alert']);
        }
    }

    public function testCarriesNoStaffNameOrAddressAnywhereInTheSerialisedOutput(): void
    {
        $json = json_encode($this->parsed(), JSON_THROW_ON_ERROR);

        foreach ($this->staffIdentifiers() as $identifier) {
            self::assertStringNotContainsString($identifier, $json, "parsed alerts leak \"{$identifier}\"");
        }
    }

    public function testKeepsOnlyTheTenFieldsTheContractNames(): void
    {
        $allowed = ['id', 'effect', 'cause', 'header', 'description', 'url', 'active_from', 'active_until', 'stop_ids', 'severity'];

        foreach ($this->parsed() as $entry) {
            self::assertSame([], array_diff(array_keys($entry['alert']), $allowed), 'an unlisted field survived ingest');
            self::assertSame([], array_diff($allowed, array_keys($entry['alert'])), 'a required field is missing');
        }
    }

    public function testDropsAnUnknownUpstreamFieldEvenWhenItLooksHarmless(): void
    {
        // The allowlist is the whole defence. This is what makes it one.
        $feed = Fixtures::feed('servicealerts.json');
        $feed[0]['internalNotes'] = 'called the supervisor about this';
        $feed[0]['filedBy'] = 'someone@capmetro.org';

        $json = json_encode($this->parsed($feed), JSON_THROW_ON_ERROR);

        self::assertStringNotContainsString('internalNotes', $json);
        self::assertStringNotContainsString('someone@capmetro.org', $json);
    }

    public function testReadsTheSocrataShapeRatherThanExpectingAGtfsRealtimeEnvelope(): void
    {
        $first = $this->parsed()[0]['alert'];

        self::assertIsString($first['header'], 'headerText did not become header');
        self::assertIsString($first['description'], 'descriptionText did not become description');
        self::assertIsArray($first['stop_ids']);
        self::assertIsInt($first['active_from']);
    }

    public function testTreatsAnOpenEndedActivePeriodAsCurrentlyActive(): void
    {
        $openEnded = array_filter($this->parsed(), static fn (array $e): bool => $e['alert']['active_until'] === null);

        self::assertNotEmpty($openEnded, '59 of 104 alerts have a null end and must not be filtered out');
    }

    public function testExcludesAnAlertWhoseActivePeriodHasAlreadyClosed(): void
    {
        $feed = Fixtures::feed('servicealerts.json');
        $feed[0]['activePeriods'] = [['start' => '2026-01-01T00:00:00.000Z', 'end' => '2026-01-02T00:00:00.000Z']];
        $expired = (string) $feed[0]['id'];

        $ids = array_map(static fn (array $e): string => $e['alert']['id'], $this->parsed($feed));

        self::assertNotContains($expired, $ids);
    }

    public function testExcludesAnAlertWhoseActivePeriodHasNotOpenedYet(): void
    {
        $feed = Fixtures::feed('servicealerts.json');
        $feed[0]['activePeriods'] = [['start' => '2027-01-01T00:00:00.000Z', 'end' => null]];
        $future = (string) $feed[0]['id'];

        $ids = array_map(static fn (array $e): string => $e['alert']['id'], $this->parsed($feed));

        self::assertNotContains($future, $ids);
    }

    public function testKeepsTheClosureCoveringStopNineteenSixtySevenOnRouteFour(): void
    {
        // Silent failure 4. Stop 1967 is scheduled today and closed today.
        $routeFour = cm_alerts_for_route($this->parsed(), '4');

        $closures = array_filter(
            $routeFour,
            static fn (array $a): bool => $a['effect'] === 'NO_SERVICE' && in_array('1967', $a['stop_ids'], true)
        );

        self::assertNotEmpty($closures, 'the stop 1967 closure did not survive ingest');
        self::assertSame('high', reset($closures)['severity']);
    }

    public function testExposesTheClosedStopsForRouteFourAsASetTheLadderCanCheck(): void
    {
        Runtime::functionsOrSkip($this, ['cm_alert_no_service_stops'], self::FILES);

        $closed = cm_alert_no_service_stops($this->parsed(), '4');

        self::assertArrayHasKey('1967', $closed);
        self::assertArrayHasKey('1971', $closed, 'the second Austin High stop is closed too');
    }

    public function testDoesNotLeakAClosureOntoARouteTheAlertNeverNamed(): void
    {
        $closedOnFour = cm_alert_no_service_stops($this->parsed(), '4');
        $closedOnOne = cm_alert_no_service_stops($this->parsed(), '1');

        self::assertArrayHasKey('1967', $closedOnFour);
        self::assertArrayNotHasKey('1967', $closedOnOne);
    }

    public function testGradesSeverityFromTheEffectAsTheContractSpecifies(): void
    {
        self::assertSame('high', cm_alert_severity('NO_SERVICE'));
        self::assertSame('medium', cm_alert_severity('DETOUR'));
        self::assertSame('medium', cm_alert_severity('REDUCED_SERVICE'));
        self::assertSame('low', cm_alert_severity('MODIFIED_SERVICE'));
        self::assertSame('low', cm_alert_severity('OTHER'));
    }

    public function testGivesEveryParsedAlertASeverityConsistentWithItsEffect(): void
    {
        foreach ($this->parsed() as $entry) {
            self::assertSame(
                cm_alert_severity($entry['alert']['effect']),
                $entry['alert']['severity'],
                "wrong severity for {$entry['alert']['effect']}"
            );
        }
    }

    public function testMapsAnUnrecognisedEffectToOtherRatherThanPassingItThrough(): void
    {
        $feed = Fixtures::feed('servicealerts.json');
        $feed[0]['effect'] = 'SOMETHING_NEW_UPSTREAM';
        $id = (string) $feed[0]['id'];

        foreach ($this->parsed($feed) as $entry) {
            if ($entry['alert']['id'] === $id) {
                self::assertSame('OTHER', $entry['alert']['effect']);
                self::assertSame('low', $entry['alert']['severity']);

                return;
            }
        }

        self::fail('the mutated alert was dropped entirely');
    }

    public function testLeavesStopIdsEmptyForARouteWideAlertRatherThanInventingOne(): void
    {
        $routeOnly = array_filter($this->parsed(), static fn (array $e): bool => $e['alert']['stop_ids'] === []);

        self::assertNotEmpty($routeOnly, '29 of 175 informed entities are route-only and must not become phantom closures');
    }
}
