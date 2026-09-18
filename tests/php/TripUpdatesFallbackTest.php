<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Fixtures;
use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\TestCase;

/**
 * The protobuf trip updates fallback (rmk2-acnw).
 *
 * The twin of the positions work in issue 14, built after the 2026-09-09 outage, when every
 * CapMetro publication to data.texas.gov stopped inside four minutes and somebody went looking
 * for a source that was still publishing. This feed is not what saves that outage -- it had
 * stopped too -- it is what makes a JSON-only trip updates stall survivable, which until now it
 * was not, purely because nothing in the runtime knew the second publication existed.
 *
 * WHAT A STALLED TRIP UPDATES FEED COSTS, and why it is worth a fallback of its own: it does
 * not empty the board the way stalled positions do. The map stays full of buses and the
 * predictions quietly go, because staleness.php suppresses adherence once the oldest feed
 * passes CM_STALE_STALE_S. A board that looks populated and has stopped saying when anything
 * arrives is the harder failure to notice, not the easier one.
 */
final class TripUpdatesFallbackTest extends TestCase
{
    private const FILES = ['runtime/lib/fetch.php', 'runtime/lib/gtfsrt.php'];
    private const NOW = 1788300715;
    private const THRESHOLD = 600;

    /** Both publications of the same instant, captured 2026-09-09 during the total stall. */
    private const DIFFERENTIAL_DIR = 'feeds-pb-differential';

    protected function setUp(): void
    {
        Runtime::functionsOrSkip(
            $this,
            [
                'cm_gtfsrt_decode_trip_updates',
                'cm_pb_trip_update',
                'cm_pb_stop_time_update',
                'cm_pb_stop_time_event',
                'cm_trip_updates_choose',
                'cm_trip_updates_needs_fallback',
                'cm_trip_updates_header_at',
                'cm_trip_updates_entity_count',
                'cm_decode_trip_updates_pb',
            ],
            self::FILES
        );
    }

    /* ---- wire format helpers ------------------------------------------------------- */

    private function varint(int $n): string
    {
        $out = '';
        $v = $n;
        do {
            $byte = $v & 0x7F;
            $v = ($v >> 7) & ~(0x7F << 57);
            if ($v !== 0) {
                $byte |= 0x80;
            }
            $out .= chr($byte);
        } while ($v !== 0);

        return $out;
    }

    private function varintField(int $field, int $value): string
    {
        return $this->varint($field << 3) . $this->varint($value);
    }

    private function lenField(int $field, string $bytes): string
    {
        return $this->varint(($field << 3) | 2) . $this->varint(strlen($bytes)) . $bytes;
    }

    private function stringField(int $field, string $value): string
    {
        return $this->lenField($field, $value);
    }

    /** A FeedMessage carrying the given TripUpdate submessages as entity field 3. */
    private function feedWithTripUpdates(array $tripUpdateBytes, int $headerTs = self::NOW): string
    {
        $header = $this->stringField(1, '2.0')
            . $this->varintField(2, 0)
            . $this->varintField(3, $headerTs);

        $out = $this->lenField(1, $header);
        foreach ($tripUpdateBytes as $i => $bytes) {
            $out .= $this->lenField(2, $this->stringField(1, 'e' . $i) . $this->lenField(3, $bytes));
        }

        return $out;
    }

    /** TripDescriptor bytes. Field numbers are the spec's: 1,2,3,4,5,6 in export key order. */
    private function trip(string $tripId, int $scheduleRelationship = 0, string $routeId = '7'): string
    {
        return $this->stringField(1, $tripId)
            . $this->stringField(2, '04:10:00')
            . $this->stringField(3, '20260909')
            . $this->varintField(4, $scheduleRelationship)
            . $this->stringField(5, $routeId)
            . $this->varintField(6, 1);
    }

    /** A minimal well-formed TripUpdate. */
    private function goodTripUpdate(string $tripId = 't1', int $stopRelationship = 0): string
    {
        return $this->lenField(1, $this->trip($tripId))
            . $this->lenField(2, $this->varintField(1, 22)
                . $this->lenField(2, $this->varintField(2, 1788946441))
                . $this->stringField(4, '4324')
                . $this->varintField(5, $stopRelationship))
            . $this->varintField(4, self::NOW);
    }

    private function decodeOne(string $tripUpdateBytes): array
    {
        $decoded = cm_gtfsrt_decode_trip_updates($this->feedWithTripUpdates([$tripUpdateBytes]));
        self::assertIsArray($decoded, 'the constructed feed must decode');
        self::assertCount(1, $decoded['entity'], 'exactly one entity was encoded');

        return $decoded['entity'][0]['tripUpdate'];
    }

    /* ---- the differential ---------------------------------------------------------- */

    /**
     * The proof the unit tests below cannot give.
     *
     * CLAUDE.md's rule for this pair: unit tests prove the decoder matches the SPEC; only a
     * differential run over both live publications proves it matches the EXPORT. We own neither
     * half of the comparison, so a decoder that agreed only with the spec could drift from what
     * CapMetro actually emits and nothing would say so.
     *
     * The capture is possible at all because of how the 2026-09-09 outage failed. Both
     * publications froze, and they froze on the same instant -- header timestamp 1788946436 on
     * each -- so the two files describe one moment exactly rather than two moments a fetch
     * apart. That is why this pair can be compared with === over every entity, where the
     * positions pair from the same day cannot be compared at all: its two halves are 29 seconds
     * apart and only 9 of 260 vehicles share a timestamp.
     */
    public function testDecodedProtobufIsIdenticalToTheJsonExportOfTheSameInstant(): void
    {
        $pb_path = Runtime::fileOrSkip(
            $this,
            'tests/fixtures/' . self::DIFFERENTIAL_DIR . '/tripupdates.pb',
            'needs a trip updates capture of both publications at one instant'
        );

        $json = Fixtures::json(self::DIFFERENTIAL_DIR . '/tripupdates.json');
        $pb = cm_gtfsrt_decode_trip_updates((string) file_get_contents($pb_path));
        self::assertIsArray($pb, 'the PB half of the differential fixture must decode');

        self::assertSame(
            $json['header']['timestamp'],
            $pb['header']['timestamp'],
            'the two halves must describe the same instant or the comparison below means nothing'
        );
        self::assertSame($json['header'], $pb['header'], 'headers must decode identically');
        self::assertArrayNotHasKey('dropped', $pb, 'nothing in a healthy capture should fail to decode');

        self::assertCount(
            count($json['entity']),
            $pb['entity'],
            'the two publications must carry the same number of trip updates'
        );
        self::assertGreaterThan(
            2000,
            count($pb['entity']),
            'a capture this small would not exercise the decoder; re-take it'
        );

        /*
         * Strict === per entity, in order. Not a normalized or field-by-field comparison:
         * equality is what catches a key this decoder stops emitting, starts emitting, or emits
         * with the wrong PHP type, all of which are invisible to a comparison that only checks
         * the fields it thought to name.
         *
         * Compared in a loop rather than as one assertSame over both lists, because the lists
         * are 2,299 entities deep and PHPUnit's differ is quadratic enough on that input that a
         * single wrong enum takes minutes to render and prints megabytes. A test whose failure
         * cannot be read is a test that gets deleted. This reports the first few mismatches with
         * their trip ids and stops.
         */
        $mismatches = [];
        foreach ($pb['entity'] as $i => $entity) {
            if ($entity === $json['entity'][$i]) {
                continue;
            }
            if (count($mismatches) < 3) {
                $mismatches[] = sprintf(
                    "  [%d] id=%s\n    pb  : %s\n    json: %s",
                    $i,
                    (string) ($entity['id'] ?? '?'),
                    substr((string) json_encode($entity), 0, 400),
                    substr((string) json_encode($json['entity'][$i]), 0, 400)
                );
            }
        }

        self::assertSame(
            [],
            $mismatches === [] ? [] : ['differing'],
            sprintf(
                "the decoder disagrees with the JSON export on %d of %d entities:\n%s",
                count(array_filter($pb['entity'], static fn ($e, $i) => $e !== $json['entity'][$i], ARRAY_FILTER_USE_BOTH)),
                count($pb['entity']),
                implode("\n", $mismatches)
            )
        );
    }

    /**
     * The differential above would still pass if both halves were empty of the interesting
     * cases, so pin what the capture actually contains. If a future re-take loses SKIPPED rows
     * or the departure branch, this fails and says so rather than letting the equality above
     * quietly become a weaker test.
     */
    public function testTheDifferentialCaptureCoversTheCasesItIsMeantTo(): void
    {
        Runtime::fileOrSkip(
            $this,
            'tests/fixtures/' . self::DIFFERENTIAL_DIR . '/tripupdates.pb',
            'needs a trip updates capture of both publications at one instant'
        );

        $json = Fixtures::json(self::DIFFERENTIAL_DIR . '/tripupdates.json');

        $skipped = 0;
        $scheduled = 0;
        $arrivals = 0;
        $departures = 0;
        $withVehicle = 0;
        foreach ($json['entity'] as $entity) {
            $tu = $entity['tripUpdate'];
            if (isset($tu['vehicle']['id'])) {
                $withVehicle++;
            }
            foreach (($tu['stopTimeUpdate'] ?? []) as $row) {
                $rel = $row['scheduleRelationship'] ?? 'SCHEDULED';
                if ($rel === 'SKIPPED') {
                    $skipped++;
                } elseif ($rel === 'SCHEDULED') {
                    $scheduled++;
                }
                $arrivals += isset($row['arrival']['time']) ? 1 : 0;
                $departures += isset($row['departure']['time']) ? 1 : 0;
            }
        }

        self::assertGreaterThan(100, $skipped, 'SKIPPED rows are the enum hazard; the capture must carry them');
        self::assertGreaterThan(100, $scheduled, 'SCHEDULED rows must be present too, or the enum proves nothing');
        self::assertGreaterThan(100, $arrivals, 'arrival times are what adherence.php reads');
        self::assertGreaterThan(10, $departures, 'the departure branch must be exercised');
        self::assertGreaterThan(10, $withVehicle, 'a VehicleDescriptor inside a TripUpdate must be covered');
    }

    /* ---- the enum that shares wire numbers with a different meaning ----------------- */

    /**
     * The single most dangerous mapping in this file.
     *
     * StopTimeUpdate.ScheduleRelationship and TripDescriptor.ScheduleRelationship are different
     * enums that share wire numbers. Wire 1 is SKIPPED in one and ADDED in the other. join.php
     * and adherence.php both drop a stop whose relationship is SKIPPED, so decoding through the
     * wrong map would name a skipped stop ADDED, no comparison would match, and the board would
     * publish an arrival time for a stop the bus is going to drive past -- with no error
     * anywhere and nothing in health.json to show for it.
     *
     * @dataProvider stopTimeUpdateRelationships
     */
    public function testStopTimeUpdateRelationshipsUseTheirOwnEnumAndNotTheTripOne(int $wire, string $expected): void
    {
        $tu = $this->decodeOne($this->goodTripUpdate('t1', $wire));

        self::assertSame(
            $expected,
            $tu['stopTimeUpdate'][0]['scheduleRelationship'],
            sprintf('StopTimeUpdate wire %d must decode as %s', $wire, $expected)
        );
    }

    public static function stopTimeUpdateRelationships(): array
    {
        return [
            'SCHEDULED'   => [0, 'SCHEDULED'],
            'SKIPPED'     => [1, 'SKIPPED'],
            'NO_DATA'     => [2, 'NO_DATA'],
            'UNSCHEDULED' => [3, 'UNSCHEDULED'],
        ];
    }

    /** The two maps must disagree on the numbers they share, or one of them is wrong. */
    public function testTheTwoScheduleRelationshipEnumsAreNotTheSameMap(): void
    {
        self::assertSame('SKIPPED', CM_PB_STOP_TIME_UPDATE_SCHEDULE_RELATIONSHIP[1]);
        self::assertSame('ADDED', CM_PB_TRIP_SCHEDULE_RELATIONSHIP[1]);
        self::assertSame('NO_DATA', CM_PB_STOP_TIME_UPDATE_SCHEDULE_RELATIONSHIP[2]);
        self::assertSame('UNSCHEDULED', CM_PB_TRIP_SCHEDULE_RELATIONSHIP[2]);
    }

    /** The trip's own relationship still goes through the trip map. CANCELED is wire 3. */
    public function testTripRelationshipStillUsesTheTripEnum(): void
    {
        $tu = $this->decodeOne(
            $this->lenField(1, $this->trip('t1', 3)) . $this->varintField(4, self::NOW)
        );

        self::assertSame('CANCELED', $tu['trip']['scheduleRelationship'], 'join.php compares this against CANCELED');
    }

    /** An unmapped future value passes through as its number rather than being guessed at. */
    public function testAnUnknownStopRelationshipIsNotGuessedAt(): void
    {
        $tu = $this->decodeOne($this->goodTripUpdate('t1', 99));

        self::assertSame(99, $tu['stopTimeUpdate'][0]['scheduleRelationship']);
    }

    /* ---- shape fidelity ------------------------------------------------------------ */

    /**
     * Width decides the PHP type, because it decides the export's.
     *
     * adherence.php reads $stu['arrival']['time'] straight out of whichever source won, so an
     * int where the JSON hands a string is exactly the two-producer divergence CLAUDE.md's rule
     * for this file exists to prevent.
     */
    public function testTimestampsAreStringsAndTheNarrowNumbersAreInts(): void
    {
        $tu = $this->decodeOne($this->goodTripUpdate());

        self::assertSame('1788946441', $tu['stopTimeUpdate'][0]['arrival']['time'], 'int64 time -> string');
        self::assertSame((string) self::NOW, $tu['timestamp'], 'int64 TripUpdate timestamp -> string');
        self::assertIsInt($tu['stopTimeUpdate'][0]['stopSequence'], 'uint32 stopSequence -> int');
        self::assertIsInt($tu['trip']['directionId'], 'uint32 directionId -> int');
    }

    public function testUncertaintyAndDelayAreIntsAndNegativeDelaysSurvive(): void
    {
        $early = $this->lenField(1, $this->trip('t1'))
            . $this->lenField(2, $this->varintField(1, 5)
                . $this->lenField(2, $this->varintField(1, -90) . $this->varintField(2, 1788946441) . $this->varintField(3, 300))
                . $this->stringField(4, '1234')
                . $this->varintField(5, 0));

        $row = $this->decodeOne($early)['stopTimeUpdate'][0];

        self::assertSame(-90, $row['arrival']['delay'], 'a bus running 90s early is the ordinary negative case');
        self::assertSame(300, $row['arrival']['uncertainty'], 'int32 uncertainty -> int');
        self::assertSame('1788946441', $row['arrival']['time']);
    }

    /**
     * The export omits stopTimeUpdate entirely for a trip with no rows; 100 of the 912 entries
     * in the 2026-08-19 capture are CANCELED with none. An empty array where the JSON has no
     * key at all is a shape difference even though every reader here treats them alike.
     */
    public function testATripWithNoRowsOmitsTheKeyRatherThanEmittingAnEmptyArray(): void
    {
        $tu = $this->decodeOne(
            $this->lenField(1, $this->trip('t1', 3)) . $this->varintField(4, self::NOW)
        );

        self::assertArrayNotHasKey('stopTimeUpdate', $tu);
    }

    /** Key order is the export's, which is wire field number order. */
    public function testKeysAreEmittedInTheExportsOrder(): void
    {
        $withVehicle = $this->lenField(1, $this->trip('t1'))
            . $this->lenField(2, $this->varintField(1, 1) . $this->stringField(4, '9') . $this->varintField(5, 0))
            . $this->lenField(3, $this->stringField(1, '2851'))
            . $this->varintField(4, self::NOW);

        $tu = $this->decodeOne($withVehicle);

        self::assertSame(['trip', 'stopTimeUpdate', 'vehicle', 'timestamp'], array_keys($tu));
        self::assertSame(
            ['tripId', 'startTime', 'startDate', 'scheduleRelationship', 'routeId', 'directionId'],
            array_keys($tu['trip']),
            'route_id is field 5 and direction_id field 6, so they come last despite being declared second'
        );
        self::assertSame(
            ['stopSequence', 'stopId', 'scheduleRelationship'],
            array_keys($tu['stopTimeUpdate'][0])
        );
    }

    /* ---- what fails, and how loudly ------------------------------------------------ */

    /**
     * A trip with no TripDescriptor cannot answer the question join.php asks of it -- whether
     * this trip is CANCELED -- so it loses rather than being published without one.
     */
    public function testATripUpdateWithNoTripLoses(): void
    {
        $decoded = cm_gtfsrt_decode_trip_updates(
            $this->feedWithTripUpdates([$this->varintField(4, self::NOW), $this->goodTripUpdate('ok')])
        );

        self::assertIsArray($decoded);
        self::assertCount(1, $decoded['entity'], 'only the well-formed trip survives');
        self::assertSame(1, $decoded['dropped'] ?? 0, 'and the loss is reported, not silent');
    }

    /**
     * A corrupt row costs the whole trip, which is the opposite of what a corrupt vehicle costs
     * in a positions feed, and deliberately so. A missing bus is a bus the board does not draw.
     * A missing stopTimeUpdate row is invisible: the trip still publishes and still looks
     * complete, and the stop that vanished silently reverts to its scheduled time -- or, if it
     * was the SKIPPED row that vanished, to a promise about a stop the bus will drive past.
     */
    public function testACorruptRowFailsTheWholeTripRatherThanVanishingFromIt(): void
    {
        /* stopId present as a varint where a string belongs: corrupt, not absent. */
        $corruptRow = $this->varintField(1, 3) . $this->varintField(4, 12345) . $this->varintField(5, 1);
        $bad = $this->lenField(1, $this->trip('t1')) . $this->lenField(2, $corruptRow) . $this->varintField(4, self::NOW);

        $decoded = cm_gtfsrt_decode_trip_updates(
            $this->feedWithTripUpdates([$bad, $this->goodTripUpdate('ok'), $this->goodTripUpdate('ok2')])
        );

        self::assertIsArray($decoded);
        self::assertCount(2, $decoded['entity']);
        self::assertSame(1, $decoded['dropped'] ?? 0);
        foreach ($decoded['entity'] as $entity) {
            self::assertNotSame('t1', $entity['tripUpdate']['trip']['tripId'], 'the holed trip must not be published');
        }
    }

    /** Most of the feed failing means we are reading it wrongly, so the whole feed loses. */
    public function testAFeedThatMostlyFailsToDecodeLosesEntirely(): void
    {
        $broken = $this->varintField(4, self::NOW);

        self::assertIsArray(
            cm_gtfsrt_decode_trip_updates($this->feedWithTripUpdates([$this->goodTripUpdate('a'), $broken])),
            'an even split is still publishable'
        );
        self::assertNull(
            cm_gtfsrt_decode_trip_updates($this->feedWithTripUpdates([$this->goodTripUpdate('a'), $broken, $broken])),
            'past the floor the feed is not trustworthy at all'
        );
    }

    /** A DIFFERENTIAL feed is a delta, not a fleet, and is refused here as it is for positions. */
    public function testADifferentialFeedIsRefused(): void
    {
        $header = $this->stringField(1, '2.0') . $this->varintField(2, 1) . $this->varintField(3, self::NOW);
        $feed = $this->lenField(1, $header)
            . $this->lenField(2, $this->stringField(1, 'e0') . $this->lenField(3, $this->goodTripUpdate()));

        self::assertNull(cm_gtfsrt_decode_trip_updates($feed));
    }

    /* ---- the two feeds do not read each other -------------------------------------- */

    /**
     * Each entry point reads its own entity field and treats the other's as somebody else's
     * entity: absent, not corrupt. A positions feed decoded as trip updates is empty, not an
     * error, which is what keeps a misrouted feed from ever looking like a usable one.
     */
    public function testEachDecoderIgnoresTheOtherFeedsEntitiesWithoutCallingThemFailures(): void
    {
        $tripUpdateFeed = $this->feedWithTripUpdates([$this->goodTripUpdate(), $this->goodTripUpdate('b')]);

        $asPositions = cm_gtfsrt_decode($tripUpdateFeed);
        self::assertIsArray($asPositions, 'a trip updates feed is a feed we have no use for, not a corrupt one');
        self::assertSame([], $asPositions['entity']);
        self::assertArrayNotHasKey('dropped', $asPositions, 'somebody elseentities are not failures');

        $positionsPb = Fixtures::text('feeds-20260901-stall/vehiclepositions.pb');
        $asTripUpdates = cm_gtfsrt_decode_trip_updates($positionsPb);
        self::assertIsArray($asTripUpdates);
        self::assertSame([], $asTripUpdates['entity']);
        self::assertArrayNotHasKey('dropped', $asTripUpdates);
        self::assertNotSame([], cm_gtfsrt_decode($positionsPb)['entity'], 'but it is a real positions feed');
    }

    /* ---- the chooser --------------------------------------------------------------- */

    private function feedAt(int $timestamp, int $entities = 1): array
    {
        $entity = [];
        for ($i = 0; $i < $entities; $i++) {
            $entity[] = ['id' => 'e' . $i, 'tripUpdate' => ['trip' => ['tripId' => 't' . $i]]];
        }

        return [
            'ok'    => true,
            'data'  => ['header' => ['timestamp' => (string) $timestamp], 'entity' => $entity],
            'bytes' => 1,
        ];
    }

    private function failed(string $error = 'boom'): array
    {
        return ['ok' => false, 'error' => $error];
    }

    public function testAFresherProtobufWinsAndSaysSo(): void
    {
        $chosen = cm_trip_updates_choose(
            $this->feedAt(self::NOW - 5000),
            $this->feedAt(self::NOW - 5),
            self::NOW,
            self::THRESHOLD
        );

        self::assertSame('protobuf', $chosen['source']);
        self::assertSame((string) (self::NOW - 5), $chosen['data']['header']['timestamp']);
    }

    public function testAHealthyJsonNeverConsultsTheFallback(): void
    {
        $chosen = cm_trip_updates_choose($this->feedAt(self::NOW - 5), null, self::NOW, self::THRESHOLD);

        self::assertSame('json', $chosen['source']);
        self::assertArrayNotHasKey('fallback_error', $chosen);
    }

    /**
     * The 2026-09-09 shape: the JSON has stalled, the fallback is consulted, and it has stalled
     * too. The stale JSON is kept and the run is told why, so the cycle does not look like one
     * where the fallback was never needed.
     */
    public function testAnEquallyStalledProtobufLosesAndTheReasonIsRecorded(): void
    {
        $chosen = cm_trip_updates_choose(
            $this->feedAt(self::NOW - 5000),
            $this->feedAt(self::NOW - 5029),
            self::NOW,
            self::THRESHOLD
        );

        self::assertSame('json', $chosen['source']);
        self::assertSame('fallback is no fresher (29s behind the stale JSON)', $chosen['fallback_error']);
        self::assertArrayNotHasKey('error', $chosen, 'a stale-but-ok JSON is not an error result');
    }

    /**
     * An empty protobuf with a current header would beat a stale JSON on freshness alone, and
     * it must not: zero trip updates means the agency is predicting nothing for any trip, which
     * silently blanks every prediction on a board that still looks populated.
     */
    public function testAnEmptyProtobufLosesEvenWhenItIsFresher(): void
    {
        $chosen = cm_trip_updates_choose(
            $this->feedAt(self::NOW - 5000, 40),
            $this->feedAt(self::NOW, 0),
            self::NOW,
            self::THRESHOLD
        );

        self::assertSame('json', $chosen['source']);
        self::assertSame('fallback carried no trip updates', $chosen['fallback_error']);
    }

    public function testTheJsonKeepsATie(): void
    {
        $chosen = cm_trip_updates_choose(
            $this->feedAt(self::NOW - 5000),
            $this->feedAt(self::NOW - 5000),
            self::NOW,
            self::THRESHOLD
        );

        self::assertSame('json', $chosen['source'], 'an ordinary run never changes source for no reason');
    }

    /** A failed JSON is already an error, so the fallback's failure joins it there. */
    public function testAFailedJsonAndAFailedFallbackReportBothInOneError(): void
    {
        $chosen = cm_trip_updates_choose($this->failed('json down'), $this->failed('pb down'), self::NOW, self::THRESHOLD);

        self::assertFalse($chosen['ok']);
        self::assertSame('json down (fallback also failed: pb down)', $chosen['error']);
    }

    public function testAnUndatedProtobufIsReportedAsUndatedAndNotAsFiftySixYearsStale(): void
    {
        $undated = ['ok' => true, 'data' => ['entity' => [['id' => 'e0']]], 'bytes' => 1];

        $chosen = cm_trip_updates_choose($this->feedAt(self::NOW - 5000), $undated, self::NOW, self::THRESHOLD);

        self::assertSame('fallback carried no header timestamp', $chosen['fallback_error']);
    }

    public function testTheThresholdIsWhatDecidesWhetherToFallBackAtAll(): void
    {
        self::assertFalse(
            cm_trip_updates_needs_fallback($this->feedAt(self::NOW - self::THRESHOLD), self::NOW, self::THRESHOLD),
            'exactly at the threshold is not yet stale'
        );
        self::assertTrue(
            cm_trip_updates_needs_fallback($this->feedAt(self::NOW - self::THRESHOLD - 1), self::NOW, self::THRESHOLD)
        );
        self::assertTrue(
            cm_trip_updates_needs_fallback($this->failed(), self::NOW, self::THRESHOLD),
            'a failed fetch always tries the fallback'
        );
    }

    public function testHeaderAtAndEntityCountAreSafeOnRubbish(): void
    {
        self::assertSame(0, cm_trip_updates_header_at(null));
        self::assertSame(0, cm_trip_updates_header_at($this->failed()));
        self::assertSame(0, cm_trip_updates_header_at(['ok' => true, 'data' => ['entity' => []]]));
        self::assertSame(0, cm_trip_updates_entity_count(null));
        self::assertSame(0, cm_trip_updates_entity_count($this->failed()));
        self::assertSame(2, cm_trip_updates_entity_count($this->feedAt(self::NOW, 2)));
    }

    /* ---- the bytes-to-result seam the fixture path uses ---------------------------- */

    public function testDecodingTheCommittedProtobufProducesAUsableResult(): void
    {
        $path = Runtime::fileOrSkip(
            $this,
            'tests/fixtures/' . self::DIFFERENTIAL_DIR . '/tripupdates.pb',
            'needs a trip updates capture of both publications at one instant'
        );

        $result = cm_decode_trip_updates_pb((string) file_get_contents($path), 1788946436);

        self::assertTrue($result['ok']);
        self::assertSame(1788946436, $result['fetched_at']);
        self::assertSame(1788946436, cm_trip_updates_header_at($result));
        self::assertGreaterThan(2000, cm_trip_updates_entity_count($result));
    }

    public function testUndecodableBytesBecomeAFailedResultRatherThanAThrow(): void
    {
        $result = cm_decode_trip_updates_pb("\xff\xff\xff\xff");

        self::assertFalse($result['ok']);
        self::assertStringContainsString('rmk2-acnw', $result['error'], 'the error must name the feed that failed');
    }

    /* ---- the whole path, through the real generator -------------------------------- */

    /**
     * Everything above tests the chooser and the decoder in isolation. This runs the real
     * generator over a stalled trip updates JSON beside a fresher protobuf and checks the
     * webroot it writes, because the project's rule is that checks run against real generated
     * output -- and because until the fixture path learned about tripupdates.pb, the protobuf
     * branch was unreachable from anything that produces output at all.
     *
     * The stall is real on both sides, assembled from two real captures rather than simulated:
     * the 2026-08-19 trip updates JSON is genuinely three weeks older than the 2026-09-09
     * protobuf, which is exactly the shape of a publication that stopped. Nothing here rewrites
     * a header to manufacture staleness.
     *
     * Board CONTENT is deliberately not asserted, for the same reason the positions version
     * does not assert it: these captures are weeks apart and from different schedule versions,
     * so the joined trips do not correlate. The claim under test is that a stalled JSON beside a
     * fresher protobuf makes the generator decode the protobuf, write a webroot from it, and say
     * which source it used.
     */
    public function testTheRealGeneratorWritesAWebrootFromTheTripUpdatesProtobufWhenTheJsonHasStalled(): void
    {
        $root = Runtime::root();
        $pb = $root . '/tests/fixtures/' . self::DIFFERENTIAL_DIR . '/tripupdates.pb';
        if (!is_file($pb)) {
            self::markTestSkipped('needs the trip updates differential capture; see tests/fixtures/README.md');
        }

        $tmp = sys_get_temp_dir() . '/cm-tu-fallback-' . bin2hex(random_bytes(6));
        $feeds = $tmp . '/feeds';
        mkdir($feeds, 0o777, true);

        foreach (['vehiclepositions.json', 'tripupdates.json', 'servicealerts.json'] as $f) {
            copy($root . '/tests/fixtures/feeds-20260819/' . $f, $feeds . '/' . $f);
        }
        copy($pb, $feeds . '/tripupdates.pb');

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
                $health['feeds']['trip_updates_source'],
                'the JSON half is three weeks stale; the run must have taken the fallback'
            );
            self::assertSame(
                1788946436,
                $health['feeds']['trip_updates_at'],
                'and the clock must come from the protobuf header, not the stale JSON'
            );
            self::assertSame(
                'json',
                $health['feeds']['positions_source'],
                'the positions half of this fixture set is untouched and must not have moved'
            );
            self::assertStringContainsString(
                'notice: trip updates from protobuf',
                implode("\n", $output),
                'an operator running --quiet still has to see this on stderr'
            );
        } finally {
            $this->rmrf($tmp);
        }
    }

    /**
     * A committed .pb that no longer decodes is a broken fixture, not a scenario. Without the
     * guard the run falls back to a choose-at of 0, decides the JSON is not stale, and reports
     * `json` -- so a rotted protobuf half would be indistinguishable from one that was never
     * there. This is the trip updates copy of a hole the positions path already closed.
     */
    public function testARottedProtobufFixtureFailsTheRunRatherThanQuietlyReportingJson(): void
    {
        $root = Runtime::root();
        $tmp = sys_get_temp_dir() . '/cm-tu-rotted-' . bin2hex(random_bytes(6));
        $feeds = $tmp . '/feeds';
        mkdir($feeds, 0o777, true);

        foreach (['vehiclepositions.json', 'tripupdates.json', 'servicealerts.json'] as $f) {
            copy($root . '/tests/fixtures/feeds-20260819/' . $f, $feeds . '/' . $f);
        }
        file_put_contents($feeds . '/tripupdates.pb', "\xff\xff\xff\xff not a FeedMessage");

        try {
            exec(sprintf(
                '%s %s --fixtures=%s --shards=%s --out=%s 2>&1',
                escapeshellarg(PHP_BINARY),
                escapeshellarg($root . '/runtime/generate-api.php'),
                escapeshellarg($feeds),
                escapeshellarg($root . '/tests/fixtures/shards-260818_1456'),
                escapeshellarg($tmp . '/web')
            ), $output, $status);

            self::assertSame(2, $status, 'a broken fixture must stop the run: ' . implode("\n", $output));
            self::assertStringContainsString('rmk2-acnw', implode("\n", $output), 'and name what would not decode');
        } finally {
            $this->rmrf($tmp);
        }
    }

    private function rmrf(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        $it = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($it as $entry) {
            $entry->isDir() ? rmdir($entry->getPathname()) : unlink($entry->getPathname());
        }
        rmdir($dir);
    }
}
