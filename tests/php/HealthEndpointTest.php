<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Fixtures;
use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\TestCase;

/**
 * Contract section 10: /api/health.json.
 *
 * This is the endpoint an uptime check hits, so it is the one file that must
 * still be written when a run fails. An ok:true that survives a dead feed is
 * worse than no health endpoint at all, because it actively reassures.
 */
final class HealthEndpointTest extends TestCase
{
    private const FILES = ['runtime/lib/health.php'];
    private const NOW = 1787152239;

    protected function setUp(): void
    {
        Runtime::functionsOrSkip($this, ['cm_build_health'], self::FILES);
    }

    private function freshFeeds(): array
    {
        return [
            'positions' => self::NOW - 5,
            'trip_updates' => self::NOW - 43,
            'alerts' => self::NOW - 100,
        ];
    }

    private function validGtfs(): array
    {
        return ['feed_version' => '260818_1456', 'built_at' => self::NOW - 86400, 'valid_until' => '20270109'];
    }

    public function testReportsOkOnTheCapturedMinute(): void
    {
        $report = cm_build_health(self::NOW, $this->freshFeeds(), $this->validGtfs(), ['vehicles' => 392, 'routes_written' => 71], [], self::NOW);

        self::assertTrue($report['ok'], 'the captured minute is healthy; a report that fails it is unusable');
        self::assertSame([], $report['errors']);
        self::assertSame(1, $report['schema']);
    }

    public function testReportsNotOkWhenAnyFeedIsOlderThanTenMinutes(): void
    {
        $feeds = $this->freshFeeds();
        $feeds['trip_updates'] = self::NOW - 900;

        $report = cm_build_health(self::NOW, $feeds, $this->validGtfs(), [], [], self::NOW);

        self::assertFalse($report['ok']);
        self::assertNotEmpty($report['errors'], 'ok:false with an empty errors array says nothing');
        self::assertStringContainsString('trip_updates', implode(' ', $report['errors']));
    }

    public function testReportsNotOkWhenTheGtfsFeedIsPastItsValidUntilDate(): void
    {
        $gtfs = $this->validGtfs();
        $gtfs['valid_until'] = '20260101';

        $report = cm_build_health(self::NOW, $this->freshFeeds(), $gtfs, [], [], self::NOW);

        self::assertFalse($report['ok']);
        self::assertStringContainsString('expired', implode(' ', $report['errors']));
    }

    public function testReportsNotOkWhenTheRunItselfRaisedAnError(): void
    {
        $report = cm_build_health(self::NOW, $this->freshFeeds(), $this->validGtfs(), [], ['route 4 shard missing'], self::NOW);

        self::assertFalse($report['ok']);
        self::assertContains('route 4 shard missing', $report['errors']);
    }

    public function testCarriesTheLastSuccessfulCronTimeSoADeadCronIsVisibleFromOutside(): void
    {
        // Silent failure 2 seen from the uptime check: generated_at keeps
        // moving only if the cron is alive, and cron_last_success_at is what a
        // monitor compares against.
        $lastGood = self::NOW - 2832;

        $report = cm_build_health(self::NOW, $this->freshFeeds(), $this->validGtfs(), [], [], $lastGood);

        self::assertSame($lastGood, $report['cron_last_success_at']);
        self::assertGreaterThan(600, $report['generated_at'] - $report['cron_last_success_at']);
    }

    public function testExposesBothAgesTheContractRequiresAMonitorToCheck(): void
    {
        $report = cm_build_health(self::NOW, $this->freshFeeds(), $this->validGtfs(), [], [], self::NOW);

        self::assertSame(self::NOW - 43, $report['feeds']['trip_updates_at']);
        self::assertSame('260818_1456', $report['gtfs']['feed_version']);
        self::assertSame('20270109', $report['gtfs']['valid_until']);
    }

    public function testDeduplicatesRepeatedErrorsRatherThanFloodingTheEndpoint(): void
    {
        $report = cm_build_health(self::NOW, $this->freshFeeds(), $this->validGtfs(), [], ['shard missing', 'shard missing'], self::NOW);

        self::assertSame(['shard missing'], $report['errors']);
    }

    public function testValidatesAgainstTheHealthSchema(): void
    {
        $report = cm_build_health(self::NOW, $this->freshFeeds(), $this->validGtfs(), ['vehicles' => 392, 'routes_written' => 71], [], self::NOW);
        $schema = json_decode(file_get_contents(Runtime::root() . '/schemas/health.schema.json'), true);

        foreach ($schema['required'] as $field) {
            self::assertArrayHasKey($field, $report, "health.json is missing required field {$field}");
        }
        self::assertSame([], array_diff(array_keys($report), array_keys($schema['properties'])), 'an undeclared field would fail additionalProperties');
    }
}
