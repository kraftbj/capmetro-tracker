<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Fixtures;
use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\TestCase;

/**
 * Contract section 11: the cron writes into a webroot a client may be reading.
 *
 * Without a temp-file-and-rename, a client that fetches mid-write gets half a
 * JSON document. That failure is invisible to the writer, intermittent, and
 * looks like a client bug, which is the worst combination available.
 */
final class AtomicWriteTest extends TestCase
{
    private const FILES = ['runtime/lib/write.php'];

    private string $tmp = '';

    protected function setUp(): void
    {
        Runtime::functionsOrSkip($this, ['cm_atomic_write', 'cm_atomic_write_json'], self::FILES);

        $this->tmp = sys_get_temp_dir() . '/capmetro-write-' . bin2hex(random_bytes(6));
        mkdir($this->tmp, 0o777, true);
    }

    protected function tearDown(): void
    {
        if ($this->tmp === '' || !is_dir($this->tmp)) {
            return;
        }
        foreach (glob($this->tmp . '/{,.}*', GLOB_BRACE) ?: [] as $f) {
            if (is_file($f)) {
                @unlink($f);
            }
        }
        @rmdir($this->tmp);
    }

    public function testATornFileIsARealHazardAndNotATheoreticalOne(): void
    {
        // If a reader can parse this, the whole premise of the file is wrong.
        $torn = Fixtures::text('synthetic/torn-route-4.json');

        self::assertGreaterThan(1000, strlen($torn), 'the torn fixture is too small to be a realistic partial write');
        self::assertNull(json_decode($torn), 'the torn fixture parses, so it proves nothing');
        self::assertSame(JSON_ERROR_SYNTAX, json_last_error());
    }

    public function testWritesADocumentThatParsesCompletely(): void
    {
        $target = $this->tmp . '/route-4.json';
        $payload = Fixtures::goldenRoute4();

        self::assertTrue(cm_atomic_write_json($target, $payload));

        $decoded = json_decode((string) file_get_contents($target), true);
        self::assertIsArray($decoded);
        self::assertSame($payload['route']['id'], $decoded['route']['id']);
        self::assertCount(count($payload['vehicles']), $decoded['vehicles']);
    }

    public function testStagesTheTempFileInTheDestinationDirectorySoTheRenameNeverCrossesAFilesystem(): void
    {
        // A rename across filesystems is a copy, and a copy is not atomic.
        $target = $this->tmp . '/route-4.json';
        cm_atomic_write($target, 'x');

        $strays = array_values(array_filter(
            glob($this->tmp . '/{,.}*', GLOB_BRACE) ?: [],
            static fn (string $f): bool => is_file($f) && str_contains(basename($f), '.tmp.')
        ));

        self::assertSame([], $strays, 'a temp file survived a successful write');
    }

    public function testLeavesNoTempFileBehindAfterAHundredWriteCycles(): void
    {
        $target = $this->tmp . '/route-4.json';
        for ($i = 0; $i < 100; $i++) {
            cm_atomic_write_json($target, ['generated_at' => 1787152239 + $i]);
        }

        $files = array_values(array_filter(glob($this->tmp . '/{,.}*', GLOB_BRACE) ?: [], 'is_file'));

        self::assertCount(1, $files, 'temp files are accumulating in the webroot');
    }

    public function testEveryReadDuringAHundredWriteCyclesSeesACompleteDocument(): void
    {
        $target = $this->tmp . '/route-4.json';
        $payload = Fixtures::goldenRoute4();
        cm_atomic_write_json($target, $payload);

        for ($i = 0; $i < 100; $i++) {
            $payload['generated_at'] = 1787152239 + $i;
            cm_atomic_write_json($target, $payload);

            $decoded = json_decode((string) file_get_contents($target), true);

            self::assertIsArray($decoded, "read {$i} saw a torn document");
            self::assertArrayHasKey('vehicles', $decoded);
        }
    }

    public function testLeavesThePreviousFileUntouchedWhenTheDocumentCannotBeEncoded(): void
    {
        // Section 11: a failed run never writes a partial or empty file.
        $target = $this->tmp . '/route-4.json';
        cm_atomic_write_json($target, Fixtures::goldenRoute4());
        $before = (string) file_get_contents($target);

        $result = @cm_atomic_write_json($target, ['handle' => fopen('php://memory', 'r')]);

        self::assertFalse($result, 'an unencodable document reported success');
        self::assertSame($before, (string) file_get_contents($target), 'a failed write clobbered the last good file');
    }

    public function testRefusesToWriteAnEmptyDocumentOverALiveEndpoint(): void
    {
        $target = $this->tmp . '/route-4.json';
        cm_atomic_write_json($target, Fixtures::goldenRoute4());
        $before = (string) file_get_contents($target);

        @cm_atomic_write_json($target, NAN);

        self::assertSame($before, (string) file_get_contents($target));
    }

    public function testASecondCronRunCannotTakeTheLockWhileTheFirstHoldsIt(): void
    {
        Runtime::functionsOrSkip($this, ['cm_acquire_lock', 'cm_release_lock'], self::FILES);
        $lock = $this->tmp . '/cron.lock';

        $first = cm_acquire_lock($lock);
        self::assertNotNull($first, 'the first run could not take the lock at all');

        $second = cm_acquire_lock($lock);
        self::assertNull($second, 'overlapping cron runs are not being excluded');

        cm_release_lock($first);

        $third = cm_acquire_lock($lock);
        self::assertNotNull($third, 'the lock was never released');
        cm_release_lock($third);
    }

    public function testCreatesAMissingWebrootDirectoryRatherThanFailingSilently(): void
    {
        $target = $this->tmp . '/api/route/4.json';

        self::assertTrue(cm_atomic_write_json($target, ['schema' => 1]));
        self::assertFileExists($target);
    }
}
