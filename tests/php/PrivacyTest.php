<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Fixtures;
use PHPUnit\Framework\TestCase;

/**
 * Acceptance criterion 7, and the one test in this repository that must never
 * be softened.
 *
 * The upstream alerts feed carries the name and work email of the CapMetro
 * employee who filed each alert. Publishing one to a static webroot is not a
 * bug that degrades gracefully; it is a disclosure that cannot be taken back.
 * So this scans generated output for the keys AND for the values, because an
 * implementation that renames userFullname to filed_by still leaks.
 */
final class PrivacyTest extends TestCase
{
    /** @return list<string> */
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

    public function testTheUpstreamFeedSuppliesRealStaffIdentifiersSoThisScanIsNotVacuous(): void
    {
        $identifiers = $this->staffIdentifiers();

        self::assertNotEmpty($identifiers);
        self::assertNotEmpty(array_filter($identifiers, static fn (string $v): bool => str_contains($v, '@')));
    }

    public function testTheCommittedGoldenOutputCarriesNoStaffKeyOrValue(): void
    {
        $raw = Fixtures::text('golden/route-4-20260819.json');

        self::assertStringNotContainsString('userEmail', $raw);
        self::assertStringNotContainsString('userFullname', $raw);
        foreach ($this->staffIdentifiers() as $identifier) {
            self::assertStringNotContainsString($identifier, $raw, "the golden output leaks \"{$identifier}\"");
        }
    }

    public function testNoSyntheticFixtureReintroducesStaffPii(): void
    {
        foreach (glob(Fixtures::dir('synthetic') . '/*.json') ?: [] as $path) {
            $raw = (string) file_get_contents($path);
            $name = basename($path);

            self::assertStringNotContainsString('userEmail', $raw, "{$name} carries a PII key");
            self::assertStringNotContainsString('userFullname', $raw, "{$name} carries a PII key");
            foreach ($this->staffIdentifiers() as $identifier) {
                self::assertStringNotContainsString($identifier, $raw, "{$name} leaks \"{$identifier}\"");
            }
        }
    }

    public function testNoGeneratedFileCarriesAStaffKeyOrValue(): void
    {
        $files = Fixtures::generatedFiles();

        if ($files === []) {
            self::markTestSkipped(sprintf(
                'no generated output under %s/api; the runtime job has not run yet. Set CAPMETRO_WEBROOT. See tests/NOTES.md.',
                Fixtures::webroot()
            ));
        }

        $identifiers = $this->staffIdentifiers();
        $leaks = [];

        foreach ($files as $path) {
            $raw = (string) file_get_contents($path);
            if (str_contains($raw, 'userEmail') || str_contains($raw, 'userFullname')) {
                $leaks[] = "{$path}: PII key";
            }
            foreach ($identifiers as $identifier) {
                if (str_contains($raw, $identifier)) {
                    $leaks[] = "{$path}: value \"{$identifier}\"";
                }
            }
        }

        self::assertSame([], $leaks, "staff PII reached generated output:\n" . implode("\n", $leaks));
    }

    public function testNoLogFileInTheWebrootCarriesAStaffKeyOrValue(): void
    {
        // Section 6 forbids PII in logs as well as in generated files.
        $logs = glob(Fixtures::webroot() . '/*.log') ?: [];
        $logs = array_merge($logs, glob(Fixtures::webroot() . '/logs/*.log') ?: []);

        if ($logs === []) {
            self::markTestSkipped('no logs under the webroot yet; the runtime job has not run.');
        }

        foreach ($logs as $path) {
            $raw = (string) file_get_contents($path);
            self::assertStringNotContainsString('userEmail', $raw, basename($path) . ' logs a PII key');
            foreach ($this->staffIdentifiers() as $identifier) {
                self::assertStringNotContainsString($identifier, $raw, basename($path) . " logs \"{$identifier}\"");
            }
        }
    }
}
