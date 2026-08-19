<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\TestCase;

/**
 * The schedule endpoints must not be rewritten when they have nothing new to say.
 *
 * api/departures/*.json is a pure function of the GTFS publication and the service date.
 * Written unconditionally on a sixty-second cron it rewrites 2.8 MB of identical bytes
 * every minute: 3.9 GB a day, on a VPS SSD, for data CapMetro republishes about three
 * times a year. Measured, not estimated, against the 71 generated boards.
 *
 * The risk in fixing it is the opposite failure, and it is the worse one: a skip that is
 * too eager leaves a stale schedule in the webroot after a GTFS reset, and a stale
 * schedule does not look broken. It looks like a bus that never comes. So the tests below
 * spend most of their effort on the cases that MUST still write.
 */
final class ConditionalWriteTest extends TestCase
{
    private const FILES = ['runtime/lib/write.php'];

    private string $tmp = '';

    protected function setUp(): void
    {
        Runtime::functionsOrSkip(
            $this,
            ['cm_atomic_write_json', 'cm_atomic_write_json_if_changed'],
            self::FILES
        );

        $this->tmp = sys_get_temp_dir() . '/capmetro-cond-' . bin2hex(random_bytes(6));
        mkdir($this->tmp, 0o777, true);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->tmp . '/*') ?: [] as $f) {
            unlink($f);
        }
        if ($this->tmp !== '' && is_dir($this->tmp)) {
            rmdir($this->tmp);
        }
    }

    private function path(string $name = 'doc.json'): string
    {
        return $this->tmp . '/' . $name;
    }

    /** The mtime of a file, with enough resolution to tell two writes apart. */
    private function stamp(string $path): array
    {
        clearstatcache(true, $path);
        return [filemtime($path), (string) file_get_contents($path)];
    }

    public function testItWritesAFileThatDoesNotExistYet(): void
    {
        $path = $this->path();
        self::assertTrue(cm_atomic_write_json_if_changed($path, ['schema' => 1, 'generated_at' => 10]));
        self::assertFileExists($path);
    }

    public function testItLeavesTheFileAloneWhenOnlyGeneratedAtMoved(): void
    {
        $path = $this->path();
        cm_atomic_write_json_if_changed($path, ['schema' => 1, 'generated_at' => 10, 'trips' => ['a']]);
        [, $before] = $this->stamp($path);

        self::assertTrue(cm_atomic_write_json_if_changed($path, ['schema' => 1, 'generated_at' => 99, 'trips' => ['a']]));

        [, $after] = $this->stamp($path);
        self::assertSame($before, $after, 'the file was rewritten for a generated_at change alone');
        /*
         * And the OLD generated_at survives. That is deliberate: for a schedule document
         * the field means when this schedule was generated, not when the cron last woke
         * up. api/health.json is where liveness is reported, and it is written every run.
         */
        $doc = json_decode($after, true);
        self::assertSame(10, $doc['generated_at']);
    }

    public function testItRewritesWhenTheFeedVersionChanges(): void
    {
        // The morning after a GTFS reset. Getting this wrong serves last season's schedule.
        $path = $this->path();
        cm_atomic_write_json_if_changed($path, ['generated_at' => 10, 'feed_version' => '260818_1456']);
        cm_atomic_write_json_if_changed($path, ['generated_at' => 99, 'feed_version' => '261101_0900']);

        $doc = json_decode((string) file_get_contents($path), true);
        self::assertSame('261101_0900', $doc['feed_version']);
        self::assertSame(99, $doc['generated_at'], 'a real change must bring the new generated_at with it');
    }

    public function testItRewritesWhenTheServiceDateRollsOver(): void
    {
        // Midnight. Yesterday's departures are not today's.
        $path = $this->path();
        cm_atomic_write_json_if_changed($path, ['generated_at' => 10, 'service_date' => '20260819']);
        cm_atomic_write_json_if_changed($path, ['generated_at' => 99, 'service_date' => '20260820']);

        $doc = json_decode((string) file_get_contents($path), true);
        self::assertSame('20260820', $doc['service_date']);
    }

    public function testItRewritesWhenADepartureTimeMovesDeepInsideTheDocument(): void
    {
        $path = $this->path();
        cm_atomic_write_json_if_changed($path, [
            'generated_at' => 10,
            'departures'   => ['6293' => [[28329, 0], [28929, 1]]],
        ]);
        cm_atomic_write_json_if_changed($path, [
            'generated_at' => 99,
            'departures'   => ['6293' => [[28329, 0], [28935, 1]]],
        ]);

        $doc = json_decode((string) file_get_contents($path), true);
        self::assertSame(28935, $doc['departures']['6293'][1][0], 'a six-second shift was skipped as unchanged');
    }

    public function testItRewritesWhenAValueChangesTypeButNotAppearance(): void
    {
        /*
         * PHP's loose comparison calls 0 and "0" equal, so a comparison written with ==
         * would skip this write. A client doing a strict === on a trip index would then
         * silently stop matching. Hence the encoded-string comparison.
         */
        $path = $this->path();
        cm_atomic_write_json_if_changed($path, ['generated_at' => 10, 'trip_index' => 0]);
        cm_atomic_write_json_if_changed($path, ['generated_at' => 99, 'trip_index' => '0']);

        self::assertSame('"0"', json_encode(json_decode((string) file_get_contents($path), true)['trip_index']));
    }

    public function testItRewritesOverAFileThatIsNotValidJson(): void
    {
        // A torn write from a previous crash must not be preserved as "unchanged".
        $path = $this->path();
        file_put_contents($path, '{"schema":1,"depart');

        self::assertTrue(cm_atomic_write_json_if_changed($path, ['schema' => 1, 'generated_at' => 99]));

        $doc = json_decode((string) file_get_contents($path), true);
        self::assertIsArray($doc, 'a truncated file was left in place');
        self::assertSame(99, $doc['generated_at']);
    }

    public function testItRewritesWhenAKeyIsRemoved(): void
    {
        // A shrinking document is a change. Subset comparison would miss it.
        $path = $this->path();
        cm_atomic_write_json_if_changed($path, ['generated_at' => 10, 'a' => 1, 'b' => 2]);
        cm_atomic_write_json_if_changed($path, ['generated_at' => 99, 'a' => 1]);

        $doc = json_decode((string) file_get_contents($path), true);
        self::assertArrayNotHasKey('b', $doc);
    }

    public function testTheVolatileFieldListIsConfigurableAndOtherwiseRespected(): void
    {
        $path = $this->path();
        cm_atomic_write_json_if_changed($path, ['stamp' => 1, 'body' => 'x'], ['stamp']);
        [, $before] = $this->stamp($path);
        cm_atomic_write_json_if_changed($path, ['stamp' => 2, 'body' => 'x'], ['stamp']);
        [, $after] = $this->stamp($path);
        self::assertSame($before, $after);

        cm_atomic_write_json_if_changed($path, ['stamp' => 3, 'body' => 'y'], ['stamp']);
        self::assertSame('y', json_decode((string) file_get_contents($path), true)['body']);
    }

    public function testItStillReportsSuccessWhenItSkips(): void
    {
        /*
         * The caller asks "is this endpoint correct now", not "did you do work". A skip
         * that returned false would fill the error list on every quiet poll and make the
         * health endpoint cry wolf.
         */
        $path = $this->path();
        cm_atomic_write_json_if_changed($path, ['generated_at' => 10, 'body' => 'x']);
        self::assertTrue(cm_atomic_write_json_if_changed($path, ['generated_at' => 99, 'body' => 'x']));
    }
}
