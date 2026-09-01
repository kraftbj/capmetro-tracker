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
            ['cm_positions_choose', 'cm_positions_needs_fallback', 'cm_positions_header_at'],
            self::FILES
        );
    }

    /** A successful fetch result whose feed header claims the given time. */
    private function feedAt(int $timestamp): array
    {
        return [
            'ok'         => true,
            'data'       => ['header' => ['timestamp' => (string) $timestamp], 'entity' => []],
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

    public function testAFreshJsonFeedIsUsedAndLabelledJson(): void
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
        self::assertSame('HTTP 500', $chosen['error']);
        self::assertSame('json', $chosen['source']);
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
