<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\TestCase;

/**
 * Choosing between CapMetro's two vehicle positions publications (issue 14).
 *
 * The choice is a pure function of two fetch results and the clock, deliberately kept apart
 * from the fetching so it can be tested at the boundaries without a socket. What it must never
 * do is treat the fallback as fresh merely because it is the fallback: a stalled protobuf feed
 * has to degrade the board exactly as a stalled JSON one does.
 */
final class PositionsFallbackTest extends TestCase
{
    private const FILES = ['runtime/lib/fetch.php'];
    private const NOW = 1788300715;
    private const THRESHOLD = 600;

    protected function setUp(): void
    {
        Runtime::functionsOrSkip(
            $this,
            [
                'cm_positions_choose',
                'cm_positions_needs_fallback',
                'cm_positions_header_at',
                'cm_positions_entity_count',
                'cm_gtfsrt_decode',
            ],
            self::FILES
        );
    }

    /**
     * A successful fetch result whose feed header claims the given time.
     *
     * Carries one vehicle by default. A feed's entity count is load-bearing in the choice, so
     * a helper that produced empty feeds would quietly make every freshness test also a test
     * of the empty case, and neither would mean what it says.
     */
    private function feedAt(int $timestamp, int $entities = 1): array
    {
        return [
            'ok'         => true,
            'data'       => [
                'header' => ['timestamp' => (string) $timestamp],
                'entity' => array_fill(0, $entities, ['id' => '1', 'vehicle' => []]),
            ],
            'bytes'      => 1234,
            'fetched_at' => self::NOW,
        ];
    }

    private function failed(string $error = 'HTTP 503'): array
    {
        return ['ok' => false, 'error' => $error];
    }

    private function choose(array $json, ?array $pb): array
    {
        return cm_positions_choose($json, $pb, self::NOW, self::THRESHOLD);
    }

    /* ---- the ordinary run ----------------------------------------------------------- */

    public function testAFreshJsonFeedIsUsedAndLabeledJson(): void
    {
        $chosen = $this->choose($this->feedAt(self::NOW - 30), $this->feedAt(self::NOW));

        self::assertSame('json', $chosen['source']);
        self::assertSame((string) (self::NOW - 30), $chosen['data']['header']['timestamp']);
    }

    public function testAFreshJsonFeedNeedsNoFallbackRequestAtAll(): void
    {
        self::assertFalse(
            cm_positions_needs_fallback($this->feedAt(self::NOW - 30), self::NOW, self::THRESHOLD)
        );
    }

    /**
     * The threshold is the same one cm_staleness() uses for `stale`, so the boundary matters:
     * falling back and the board going stale have to be the same moment.
     */
    public function testTheThresholdBoundaryIsExclusive(): void
    {
        $atThreshold = $this->feedAt(self::NOW - self::THRESHOLD);
        $pastIt      = $this->feedAt(self::NOW - self::THRESHOLD - 1);

        self::assertFalse(cm_positions_needs_fallback($atThreshold, self::NOW, self::THRESHOLD));
        self::assertTrue(cm_positions_needs_fallback($pastIt, self::NOW, self::THRESHOLD));
    }

    /* ---- the stall this was written for --------------------------------------------- */

    /**
     * The 2026-09-01 shape: JSON frozen for nearly four hours, protobuf current.
     */
    public function testAStalledJsonFeedFallsBackToTheFresherProtobuf(): void
    {
        $chosen = $this->choose(
            $this->feedAt(self::NOW - 14089),
            $this->feedAt(self::NOW - 12)
        );

        self::assertSame('protobuf', $chosen['source']);
        self::assertSame((string) (self::NOW - 12), $chosen['data']['header']['timestamp']);
    }

    public function testRecoveryNeedsNoStateBecauseTheJsonIsAlwaysConsulted(): void
    {
        $stalled = $this->choose($this->feedAt(self::NOW - 14089), $this->feedAt(self::NOW - 12));
        $recovered = $this->choose($this->feedAt(self::NOW - 30), $this->feedAt(self::NOW - 12));

        self::assertSame('protobuf', $stalled['source']);
        self::assertSame('json', $recovered['source'], 'the cycle the JSON returns, it is used again');
    }

    /* ---- the fallback is not trusted blindly ---------------------------------------- */

    public function testAProtobufThatHasAlsoStalledDoesNotWin(): void
    {
        $chosen = $this->choose(
            $this->feedAt(self::NOW - 14089),
            $this->feedAt(self::NOW - 20000)
        );

        self::assertSame('json', $chosen['source'], 'the less stale of two stale feeds is still the JSON');
        self::assertSame((string) (self::NOW - 14089), $chosen['data']['header']['timestamp']);
    }

    /**
     * The failure freshness cannot see. A protobuf publishing a current header with nothing in
     * it wins on age against a stale JSON every time, and swapping four-hour-old buses for no
     * buses would be reported `ok:true` — an empty feed is never "stale", so nothing downstream
     * objects. Wrong about when beats wrong about whether the service is running.
     */
    public function testAFreshButEmptyProtobufDoesNotEmptyTheBoard(): void
    {
        $chosen = $this->choose(
            $this->feedAt(self::NOW - 14089, 404),
            $this->feedAt(self::NOW - 12, 0)
        );

        self::assertSame('json', $chosen['source'], 'a full stale board beats a fresh empty one');
        self::assertCount(404, $chosen['data']['entity']);
    }

    public function testAFreshProtobufWithVehiclesStillWins(): void
    {
        $chosen = $this->choose(
            $this->feedAt(self::NOW - 14089, 404),
            $this->feedAt(self::NOW - 12, 413)
        );

        self::assertSame('protobuf', $chosen['source'], 'the empty-feed guard must not block the ordinary rescue');
        self::assertCount(413, $chosen['data']['entity']);
    }

    public function testAFailedProtobufLeavesTheStaleJsonInPlace(): void
    {
        $chosen = $this->choose($this->feedAt(self::NOW - 14089), $this->failed());

        self::assertSame('json', $chosen['source']);
        self::assertTrue($chosen['ok'], 'a stale feed is still a usable one');
    }

    public function testAnUndecodableProtobufLeavesTheStaleJsonInPlace(): void
    {
        $chosen = $this->choose(
            $this->feedAt(self::NOW - 14089),
            $this->failed('not a decodable FeedMessage')
        );

        self::assertSame('json', $chosen['source']);
    }

    public function testNoProtobufAttemptAtAllLeavesTheStaleJsonInPlace(): void
    {
        $chosen = $this->choose($this->feedAt(self::NOW - 14089), null);

        self::assertSame('json', $chosen['source']);
    }

    /* ---- failures on the primary ----------------------------------------------------- */

    public function testAFailedJsonFetchFallsBackToProtobuf(): void
    {
        $chosen = $this->choose($this->failed(), $this->feedAt(self::NOW - 12));

        self::assertSame('protobuf', $chosen['source']);
        self::assertTrue($chosen['ok']);
    }

    public function testBothFailingKeepsTheJsonErrorRatherThanInventingSuccess(): void
    {
        $chosen = $this->choose($this->failed('HTTP 500'), $this->failed('HTTP 503'));

        self::assertFalse($chosen['ok']);
        self::assertStringStartsWith('HTTP 500', $chosen['error'], 'the primary failure leads');
        self::assertSame('json', $chosen['source']);
    }

    /**
     * `positions: HTTP 500` alone cannot tell an operator whether the second publication was
     * ever consulted. Not knowing that is the same blindness issue 14 was about, one level up.
     */
    public function testBothFailingSaysTheFallbackWasTriedAndAlsoFailed(): void
    {
        $chosen = $this->choose($this->failed('HTTP 500'), $this->failed('HTTP 503'));

        self::assertStringContainsString('HTTP 503', $chosen['error']);
        self::assertStringContainsString('fallback', $chosen['error']);
    }

    /** A JSON failure the fallback rescued is not an error at all, so nothing is appended. */
    public function testARescuedJsonFailureReportsNoError(): void
    {
        $chosen = $this->choose($this->failed('HTTP 500'), $this->feedAt(self::NOW - 12));

        self::assertTrue($chosen['ok']);
        self::assertArrayNotHasKey('error', $chosen);
        self::assertArrayNotHasKey('fallback_error', $chosen);
    }

    /**
     * A stale JSON the fallback could not improve on is the quietest failure available: the
     * board is `ok`, so nothing enters the error list, and without this the run is
     * indistinguishable from one where the fallback was never wanted.
     *
     * @dataProvider unhelpfulFallbacks
     */
    public function testAStaleJsonWhoseFallbackDidNotHelpSaysWhy(string $expected, string $why): void
    {
        $chosen = $this->choose($this->feedAt(self::NOW - 14089), $this->unhelpfulFallback($why));

        self::assertSame('json', $chosen['source']);
        self::assertTrue($chosen['ok'], 'a stale feed is still a usable one');
        self::assertStringContainsString($expected, $chosen['fallback_error'], $why);
    }

    /** @return array<string, array{string, string}> */
    public static function unhelpfulFallbacks(): array
    {
        return [
            'fetch failed'     => ['HTTP 503', 'fetch failed'],
            'carried nothing'  => ['no vehicles', 'decoded but empty'],
            'also stalled'     => ['no fresher', 'decoded, full, and older than the JSON'],
        ];
    }

    private function unhelpfulFallback(string $why): array
    {
        return match ($why) {
            'fetch failed'                        => $this->failed(),
            'decoded but empty'                   => $this->feedAt(self::NOW - 12, 0),
            'decoded, full, and older than the JSON' => $this->feedAt(self::NOW - 20000),
        };
    }

    /**
     * The JSON keeps a dead-even tie, so an ordinary run never changes source for no reason.
     * Documented in cm_positions_choose() and, until now, asserted nowhere.
     */
    public function testAProtobufExactlyAsFreshAsTheJsonDoesNotDisplaceIt(): void
    {
        $chosen = $this->choose(
            $this->feedAt(self::NOW - 14089),
            $this->feedAt(self::NOW - 14089)
        );

        self::assertSame('json', $chosen['source'], 'equal headers are not an improvement');
    }

    /* ---- the whole path, through the real generator ---------------------------------- */

    /**
     * Everything above tests the chooser as a pure function. This runs the real generator over
     * the real captured stall and checks the webroot it writes -- the project's own rule is
     * that checks run against real generated output, and until this existed the fixture path
     * hardcoded `json`, so no test could reach the protobuf branch through anything that
     * produces output at all.
     *
     * What is deliberately NOT asserted is board content. The stall capture is from 2026-09-01
     * and the only committed schedule shards are 260818_1456, so the joined trips do not
     * correlate and the run exits 1 saying so. That mismatch is the fixtures', not the
     * fallback's: the claim under test is that a stalled JSON beside a healthy protobuf makes
     * the generator decode the protobuf, write a webroot from it, and report which source it
     * used. Correlating content is what the differential capture is for.
     */
    public function testTheRealGeneratorWritesAWebrootFromTheProtobufWhenTheJsonHasStalled(): void
    {
        $root  = Runtime::root();
        $stall = $root . '/tests/fixtures/feeds-20260901-stall';
        if (!is_file($stall . '/vehiclepositions.pb')) {
            self::markTestSkipped('needs tests/fixtures/feeds-20260901-stall; see tests/fixtures/README.md');
        }

        $tmp   = sys_get_temp_dir() . '/cm-fallback-' . bin2hex(random_bytes(6));
        $feeds = $tmp . '/feeds';
        mkdir($feeds, 0o777, true);

        /* A coherent-enough feed set: the stall's own two positions halves, plus the trip
           updates and alerts the 2026-08-19 capture provides, since the stall capture is
           positions only. */
        foreach (['tripupdates.json', 'servicealerts.json'] as $f) {
            copy($root . '/tests/fixtures/feeds-20260819/' . $f, $feeds . '/' . $f);
        }
        foreach (['vehiclepositions.json', 'vehiclepositions.pb'] as $f) {
            copy($stall . '/' . $f, $feeds . '/' . $f);
        }

        try {
            exec(sprintf(
                '%s %s --fixtures=%s --shards=%s --out=%s 2>&1',
                escapeshellarg(PHP_BINARY),
                escapeshellarg($root . '/runtime/generate-api.php'),
                escapeshellarg($feeds),
                escapeshellarg($root . '/tests/fixtures/shards-260818_1456'),
                escapeshellarg($tmp . '/web')
            ), $output, $status);

            $health_path = $tmp . '/web/api/health.json';
            self::assertFileExists($health_path, 'the run must write a health endpoint: ' . implode("\n", $output));

            $health = json_decode((string) file_get_contents($health_path), true);

            self::assertSame(
                'protobuf',
                $health['feeds']['positions_source'],
                'the JSON half of this capture is four hours stale; the run must have taken the fallback'
            );
            self::assertSame(
                (int) $this->stallHeaderTimestamp($stall . '/vehiclepositions.pb'),
                $health['feeds']['positions_at'],
                'and the age it reports must be the protobuf header, not the stale JSON one'
            );
            self::assertFileExists($tmp . '/web/api/all.json', 'a real webroot, not just a health file');

            /* The operator signal has to survive --quiet, which production always passes. */
            self::assertStringContainsString(
                'notice: positions from protobuf',
                implode("\n", $output),
                'a run on the fallback must say so on stderr, not only in health.json'
            );
        } finally {
            self::removeTree($tmp);
        }
    }

    /** The protobuf capture's own header time, read through the decoder under test. */
    private function stallHeaderTimestamp(string $path): string
    {
        $decoded = cm_gtfsrt_decode((string) file_get_contents($path));
        self::assertNotNull($decoded, 'the committed capture must decode');

        return $decoded['header']['timestamp'];
    }

    private static function removeTree(string $dir): void
    {
        $items = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($items as $item) {
            $item->isDir() ? rmdir($item->getPathname()) : unlink($item->getPathname());
        }
        rmdir($dir);
    }

    /* ---- the module loads on its own ------------------------------------------------- */

    /**
     * fetch.php calls cm_gtfsrt_decode(), so it must require gtfsrt.php itself.
     *
     * This cannot be checked in-process: bootstrap.php requires every runtime/lib/*.php, so a
     * missing require is invisible to every other test in this suite -- which is exactly how
     * the real one survived until review. It shipped working only because generate-api.php
     * happened to require the two files in the right order, one edit away from a fatal in the
     * cron. So the check runs in a subprocess that loads the one file and nothing else.
     */
    public function testFetchLoadsOnItsOwnWithoutTheBootstrapRequiringEverything(): void
    {
        /* The path arrives as $argv[1] rather than inside the snippet, so no quoting of one
           shell level has to survive being nested inside another. */
        $code = 'require $argv[1]; exit(function_exists("cm_gtfsrt_decode") ? 0 : 3);';

        exec(sprintf(
            '%s -d error_reporting=E_ALL -r %s %s 2>&1',
            escapeshellarg(PHP_BINARY),
            escapeshellarg($code),
            escapeshellarg(Runtime::root() . '/runtime/lib/fetch.php')
        ), $output, $status);

        self::assertSame(
            0,
            $status,
            "requiring fetch.php alone must define what it calls; got: " . implode("\n", $output)
        );
    }

    /* ---- header reading -------------------------------------------------------------- */

    public function testAFeedWithNoHeaderTimestampCountsAsAgeless(): void
    {
        self::assertSame(0, cm_positions_header_at(['ok' => true, 'data' => ['entity' => []]]));
        self::assertSame(0, cm_positions_header_at($this->failed()));
        self::assertSame(0, cm_positions_header_at(null));
    }

    /**
     * A feed that serves a 200 with no usable header is indistinguishable from one four hours
     * behind, and must not be preferred over a protobuf that does say when it was made.
     */
    public function testAHeaderlessJsonFeedDoesNotBeatATimestampedProtobuf(): void
    {
        $headerless = ['ok' => true, 'data' => ['entity' => []], 'bytes' => 12, 'fetched_at' => self::NOW];

        $chosen = $this->choose($headerless, $this->feedAt(self::NOW - 12));

        self::assertSame('protobuf', $chosen['source']);
    }
}
