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
