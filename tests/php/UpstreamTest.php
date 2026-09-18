<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\TestCase;

/**
 * The upstream schedule-identity probe.
 *
 * The board joins live trip ids against pre-built shards, so a republish upstream breaks
 * every join while every clock the board owns still reads healthy. On 2026-08-27 CapMetro
 * replaced 260818_1456 with 260826_0956 eight days into a feed advertised through
 * 2027-01-09; 56 of 71 routes lost every match and nothing on the board said why.
 *
 * The network path is exercised for real in the live probe check at the bottom, which skips
 * when there is no network. Everything else here is the pure decision logic: when to ask,
 * what an answer means, and -- most importantly -- that a probe which could NOT answer never
 * turns into a claim that the schedule is wrong.
 */
final class UpstreamTest extends TestCase
{
    private const FILES = ['runtime/lib/fetch.php', 'runtime/lib/upstream.php'];
    private const NOW = 1787836880;

    protected function setUp(): void
    {
        Runtime::functionsOrSkip($this, [
            'cm_parse_feed_info_version',
            'cm_schedule_superseded_by',
            'cm_upstream_probe_due',
        ], self::FILES);
    }

    /* ---- reading feed_version out of feed_info.txt ---------------------------------- */

    public function testReadsFeedVersionFromTheRealUpstreamHeaderLayout(): void
    {
        /* Byte-for-byte the file CapMetro ships, quoted publisher name and all. */
        $csv = "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version,feed_contact_url\n"
             . "\"Capital Metro\",https://www.capmetro.org,en,20260826,20270109,260826_0956,http://www.capmetro.org\n";

        self::assertSame('260826_0956', cm_parse_feed_info_version($csv));
    }

    public function testToleratesAByteOrderMarkOnTheHeaderRow(): void
    {
        /* Upstream ships stops.txt and trips.txt with a BOM; assume feed_info.txt may too. */
        $csv = "\xEF\xBB\xBFfeed_start_date,feed_end_date,feed_version\n20260826,20270109,260826_0956\n";

        self::assertSame('260826_0956', cm_parse_feed_info_version($csv));
    }

    public function testDoesNotCareWhichColumnFeedVersionSitsIn(): void
    {
        $csv = "feed_version,feed_lang\n260826_0956,en\n";

        self::assertSame('260826_0956', cm_parse_feed_info_version($csv));
    }

    public function testReturnsNullWhenThereIsNoFeedVersionColumn(): void
    {
        self::assertNull(cm_parse_feed_info_version("feed_lang,feed_start_date\nen,20260826\n"));
    }

    public function testReturnsNullOnATruncatedOrEmptyFile(): void
    {
        self::assertNull(cm_parse_feed_info_version("feed_version\n"));
        self::assertNull(cm_parse_feed_info_version(''));
        self::assertNull(cm_parse_feed_info_version("feed_version\n\n"));
    }

    /* ---- what a version comparison means -------------------------------------------- */

    public function testNamesTheUpstreamVersionWhenItIsADifferentPublishedFeed(): void
    {
        self::assertSame('260826_0956', cm_schedule_superseded_by('260818_1456', '260826_0956'));
    }

    public function testSaysNothingWhenTheVersionsMatch(): void
    {
        self::assertNull(cm_schedule_superseded_by('260826_0956', '260826_0956'));
    }

    /*
     * The whole safety property. A probe that timed out, got a 500, hit a zip it could not
     * parse or ran before the first successful check reports null, and null must never be
     * read as "superseded" -- a wrong banner about the schedule is worse than no banner.
     */
    public function testAnUnknownUpstreamIsNeverAMismatch(): void
    {
        self::assertNull(cm_schedule_superseded_by('260818_1456', null));
        self::assertNull(cm_schedule_superseded_by('260818_1456', ''));
    }

    public function testAnUnknownLocalVersionIsNeverAMismatchEither(): void
    {
        /* generate-api.php defaults feed_version to the literal 'unknown' when the shard
           index carries none, and a board that does not know what it built from cannot
           claim upstream has moved past it. */
        self::assertNull(cm_schedule_superseded_by('unknown', '260826_0956'));
        self::assertNull(cm_schedule_superseded_by(null, '260826_0956'));
        self::assertNull(cm_schedule_superseded_by('', '260826_0956'));
    }

    /* ---- when to ask ---------------------------------------------------------------- */

    public function testProbesOnTheFirstRunWhenNothingIsRemembered(): void
    {
        $due = cm_upstream_probe_due(self::NOW, []);

        self::assertTrue($due['probe']);
        self::assertNull($due['upstream_version']);
    }

    public function testHoldsAGoodAnswerForTheFullTtlRatherThanAskingEveryMinute(): void
    {
        $state = [
            'upstream_checked_at'   => self::NOW - 60,
            'upstream_ok'           => true,
            'upstream_feed_version' => '260826_0956',
        ];
        $due = cm_upstream_probe_due(self::NOW, $state);

        self::assertFalse($due['probe'], 'the cron runs every 60s; upstream moves a few times a year');
        self::assertSame('260826_0956', $due['upstream_version']);
    }

    public function testAsksAgainOnceTheAnswerHasAged(): void
    {
        $state = [
            'upstream_checked_at'   => self::NOW - CM_UPSTREAM_TTL_S - 1,
            'upstream_ok'           => true,
            'upstream_feed_version' => '260826_0956',
        ];
        $due = cm_upstream_probe_due(self::NOW, $state);

        self::assertTrue($due['probe']);
        /* The remembered answer still stands until a new one replaces it. */
        self::assertSame('260826_0956', $due['upstream_version']);
    }

    public function testRetriesAFailureSoonerThanItRefreshesASuccess(): void
    {
        $failed = [
            'upstream_checked_at'   => self::NOW - CM_UPSTREAM_RETRY_S - 1,
            'upstream_ok'           => false,
            'upstream_feed_version' => null,
        ];
        self::assertTrue(cm_upstream_probe_due(self::NOW, $failed)['probe']);

        $recent = [
            'upstream_checked_at'   => self::NOW - 10,
            'upstream_ok'           => false,
            'upstream_feed_version' => null,
        ];
        self::assertFalse(
            cm_upstream_probe_due(self::NOW, $recent)['probe'],
            'a failing upstream must not be hammered once a minute'
        );
    }

    public function testAFailedProbeCarriesNoVersionForward(): void
    {
        $due = cm_upstream_probe_due(self::NOW, [
            'upstream_checked_at'   => self::NOW - 10,
            'upstream_ok'           => false,
            'upstream_feed_version' => null,
        ]);

        self::assertNull($due['upstream_version']);
    }

    /* A clock that jumped backwards must re-probe rather than sit on a future timestamp. */
    public function testProbesAgainIfTheStoredCheckIsInTheFuture(): void
    {
        $due = cm_upstream_probe_due(self::NOW, [
            'upstream_checked_at'   => self::NOW + 3600,
            'upstream_ok'           => true,
            'upstream_feed_version' => '260826_0956',
        ]);

        self::assertTrue($due['probe']);
    }

    /* ---- the real thing -------------------------------------------------------------- */

    /**
     * @group network
     */
    public function testReadsTheLiveUpstreamFeedVersionWithThreeRangeRequests(): void
    {
        if (getenv('CM_SKIP_NETWORK_TESTS') === '1') {
            self::markTestSkipped('network tests disabled');
        }
        $result = cm_upstream_feed_version();
        if (!$result['ok']) {
            self::markTestSkipped('upstream unreachable: ' . $result['error']);
        }

        /* CapMetro's format is YYMMDD_HHMM. Asserting the shape rather than a value keeps
           this from failing every time they publish, which is the event it exists for. */
        self::assertMatchesRegularExpression('/^\d{6}_\d{4}$/', $result['feed_version']);
    }
}
