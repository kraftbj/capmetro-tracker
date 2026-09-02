<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Fixtures;
use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\TestCase;

/**
 * The protobuf positions decoder (issue 14).
 *
 * The decoder exists so a stalled vehiclepositions.json can fall back to CapMetro's protobuf
 * publication of the same feed. Its whole contract is that downstream cannot tell the two
 * apart, so most of what is asserted here is shape rather than values: camelCase keys, enums
 * as names, timestamps as strings.
 *
 * The enum maps get constructed wire bytes rather than a fixture. That is not a synthetic
 * stand-in for the real thing -- the wire numbers are fixed by the GTFS-RT spec, so encoding
 * field 4 = 3 and asserting CANCELED tests exactly the mapping adherence.php depends on, on
 * every value, including the ones a live capture happens not to contain. A fixture can only
 * ever cover the values in service the afternoon it was taken.
 */
final class GtfsRtDecoderTest extends TestCase
{
    private const FILES = ['runtime/lib/gtfsrt.php'];

    /** Captured 2026-09-01 17:12 CDT, during the stall that motivated this work. */
    private const STALL_DIR = 'feeds-20260901-stall';

    protected function setUp(): void
    {
        Runtime::functionsOrSkip(
            $this,
            ['cm_gtfsrt_decode', 'cm_pb_fields', 'cm_pb_varint'],
            self::FILES
        );
    }

    /* ---- wire format helpers ------------------------------------------------------- */

    private function varint(int $n): string
    {
        $out = '';
        do {
            $byte = $n & 0x7F;
            $n = ($n >> 7) & ~(0x7F << 57);
            if ($n !== 0) {
                $byte |= 0x80;
            }
            $out .= chr($byte);
        } while ($n !== 0);

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

    private function float32Field(int $field, float $value): string
    {
        return $this->varint(($field << 3) | 5) . pack('g', $value);
    }

    private function stringField(int $field, string $value): string
    {
        return $this->lenField($field, $value);
    }

    /** A FeedMessage carrying one VehiclePosition built from the given vehicle bytes. */
    private function feedWithVehicle(string $vehicleBytes, int $headerTs = 1788300715): string
    {
        $header = $this->stringField(1, '2.0')
            . $this->varintField(2, 0)
            . $this->varintField(3, $headerTs);

        $entity = $this->stringField(1, 'e1') . $this->lenField(4, $vehicleBytes);

        return $this->lenField(1, $header) . $this->lenField(2, $entity);
    }

    /* ---- the real capture ---------------------------------------------------------- */

    public function testDecodesTheCapturedProtobufFeed(): void
    {
        $decoded = cm_gtfsrt_decode(Fixtures::text(self::STALL_DIR . '/vehiclepositions.pb'));

        self::assertIsArray($decoded, 'the captured PB feed must decode');
        self::assertSame('2.0', $decoded['header']['gtfsRealtimeVersion']);
        self::assertSame('FULL_DATASET', $decoded['header']['incrementality']);
        self::assertIsString($decoded['header']['timestamp'], 'header timestamp is a string in the JSON export');
        self::assertNotEmpty($decoded['entity']);
    }

    public function testEveryDecodedEntityCarriesTheFieldsTheJoinReads(): void
    {
        $decoded = cm_gtfsrt_decode(Fixtures::text(self::STALL_DIR . '/vehiclepositions.pb'));

        foreach ($decoded['entity'] as $i => $entity) {
            self::assertArrayHasKey('id', $entity, "entity {$i} has no id");
            self::assertArrayHasKey('vehicle', $entity, "entity {$i} has no vehicle");

            $vehicle = $entity['vehicle'];
            self::assertArrayHasKey('timestamp', $vehicle, "entity {$i} has no timestamp");
            self::assertIsString($vehicle['timestamp'], "entity {$i} timestamp must be a string");

            if (isset($vehicle['position'])) {
                self::assertIsFloat($vehicle['position']['latitude']);
                self::assertIsFloat($vehicle['position']['longitude']);
            }
            if (isset($vehicle['currentStopSequence'])) {
                self::assertIsInt($vehicle['currentStopSequence']);
            }
        }
    }

    /**
     * Austin is around 30.2N, 97.7W. A decoder that read the wrong wire type, or byte-swapped,
     * produces numbers that are still floats but are nowhere near Texas.
     */
    public function testDecodedPositionsLandInTheServiceArea(): void
    {
        $decoded = cm_gtfsrt_decode(Fixtures::text(self::STALL_DIR . '/vehiclepositions.pb'));

        $checked = 0;
        foreach ($decoded['entity'] as $entity) {
            if (!isset($entity['vehicle']['position'])) {
                continue;
            }
            $p = $entity['vehicle']['position'];
            self::assertGreaterThan(29.5, $p['latitude']);
            self::assertLessThan(31.0, $p['latitude']);
            self::assertGreaterThan(-98.5, $p['longitude']);
            self::assertLessThan(-97.0, $p['longitude']);
            $checked++;
        }

        self::assertGreaterThan(100, $checked, 'the capture should carry hundreds of positions');
    }

    /* ---- enum mapping -------------------------------------------------------------- */

    /**
     * adherence.php compares scheduleRelationship against CANCELED by name, so a wrong number
     * here changes lateness silently.
     *
     * @dataProvider scheduleRelationships
     */
    public function testTripScheduleRelationshipMapsToItsName(int $wire, string $expected): void
    {
        $trip = $this->stringField(1, 'trip-1') . $this->varintField(4, $wire);
        $feed = $this->feedWithVehicle($this->lenField(1, $trip));

        $decoded = cm_gtfsrt_decode($feed);

        self::assertSame($expected, $decoded['entity'][0]['vehicle']['trip']['scheduleRelationship']);
    }

    /** @return array<string, array{int, string}> */
    public static function scheduleRelationships(): array
    {
        return [
            'SCHEDULED'   => [0, 'SCHEDULED'],
            'ADDED'       => [1, 'ADDED'],
            'UNSCHEDULED' => [2, 'UNSCHEDULED'],
            'CANCELED'    => [3, 'CANCELED'],
            'REPLACEMENT' => [5, 'REPLACEMENT'],
            'DUPLICATED'  => [6, 'DUPLICATED'],
            'DELETED'     => [7, 'DELETED'],
        ];
    }

    /** @dataProvider stopStatuses */
    public function testVehicleStopStatusMapsToItsName(int $wire, string $expected): void
    {
        $feed = $this->feedWithVehicle($this->varintField(4, $wire));

        $decoded = cm_gtfsrt_decode($feed);

        self::assertSame($expected, $decoded['entity'][0]['vehicle']['currentStatus']);
    }

    /** @return array<string, array{int, string}> */
    public static function stopStatuses(): array
    {
        return [
            'INCOMING_AT'   => [0, 'INCOMING_AT'],
            'STOPPED_AT'    => [1, 'STOPPED_AT'],
            'IN_TRANSIT_TO' => [2, 'IN_TRANSIT_TO'],
        ];
    }

    /**
     * A value GTFS-RT adds later must not be guessed at. Defaulting an unknown
     * ScheduleRelationship to SCHEDULED would quietly reinstate a canceled trip.
     */
    public function testUnknownEnumIsPassedThroughRatherThanDefaulted(): void
    {
        $trip = $this->stringField(1, 'trip-1') . $this->varintField(4, 42);
        $feed = $this->feedWithVehicle($this->lenField(1, $trip));

        $decoded = cm_gtfsrt_decode($feed);

        self::assertSame(42, $decoded['entity'][0]['vehicle']['trip']['scheduleRelationship']);
    }

    /* ---- shape parity with the JSON export ----------------------------------------- */

    public function testTimestampsAreStringsNotIntegers(): void
    {
        $feed = $this->feedWithVehicle($this->varintField(5, 1788300713), 1788300715);

        $decoded = cm_gtfsrt_decode($feed);

        self::assertSame('1788300715', $decoded['header']['timestamp']);
        self::assertSame('1788300713', $decoded['entity'][0]['vehicle']['timestamp']);
    }

    public function testAbsentOptionalFieldsAreOmittedRatherThanNulled(): void
    {
        $feed = $this->feedWithVehicle($this->varintField(5, 1788300713));

        $vehicle = cm_gtfsrt_decode($feed)['entity'][0]['vehicle'];

        self::assertArrayNotHasKey('stopId', $vehicle);
        self::assertArrayNotHasKey('position', $vehicle);
        self::assertArrayNotHasKey('trip', $vehicle);
        self::assertArrayNotHasKey('currentStopSequence', $vehicle);
    }

    public function testPositionFieldsDecodeAsFloats(): void
    {
        $position = $this->float32Field(1, 30.26187)
            . $this->float32Field(2, -97.69447)
            . $this->float32Field(3, 165.0)
            . $this->float32Field(5, 19.66976);
        $feed = $this->feedWithVehicle($this->lenField(2, $position));

        $p = cm_gtfsrt_decode($feed)['entity'][0]['vehicle']['position'];

        self::assertEqualsWithDelta(30.26187, $p['latitude'], 1e-5);
        self::assertEqualsWithDelta(-97.69447, $p['longitude'], 1e-5);
        self::assertEqualsWithDelta(165.0, $p['bearing'], 1e-5);
        self::assertEqualsWithDelta(19.66976, $p['speed'], 1e-5);
    }

    /* ---- feeds we are not meant to read -------------------------------------------- */

    /**
     * A trip updates feed carries entity field 3, not 4. That is a feed with no vehicle
     * positions in it, not a corrupt one, so it decodes to an empty list.
     */
    public function testEntitiesWithoutAVehiclePositionAreSkipped(): void
    {
        $header = $this->stringField(1, '2.0') . $this->varintField(3, 1788300715);
        $entity = $this->stringField(1, 'tu1') . $this->lenField(3, $this->stringField(1, 'trip-1'));
        $feed = $this->lenField(1, $header) . $this->lenField(2, $entity);

        $decoded = cm_gtfsrt_decode($feed);

        self::assertIsArray($decoded);
        self::assertSame([], $decoded['entity']);
    }

    /** @dataProvider incrementalities */
    public function testIncrementalityMapsToItsName(int $wire, string $expected): void
    {
        $header = $this->stringField(1, '2.0')
            . $this->varintField(2, $wire)
            . $this->varintField(3, 1788300715);

        $decoded = cm_gtfsrt_decode($this->lenField(1, $header));

        self::assertSame($expected, $decoded['header']['incrementality']);
    }

    /**
     * DIFFERENTIAL is unreachable from CapMetro today, which is exactly why it is asserted
     * here: a capture can only ever cover what upstream happened to publish, and the claim
     * this suite makes is that every value in the map is right, not every value in service.
     *
     * @return array<string, array{int, string}>
     */
    public static function incrementalities(): array
    {
        return [
            'FULL_DATASET' => [0, 'FULL_DATASET'],
            'DIFFERENTIAL' => [1, 'DIFFERENTIAL'],
        ];
    }

    /* ---- malformed input ----------------------------------------------------------- */

    /** @dataProvider malformed */
    public function testMalformedBytesDecodeToNull(string $bytes, string $why): void
    {
        self::assertNull(cm_gtfsrt_decode($bytes), $why);
    }

    /**
     * The decoder's premise is that it degrades instead of failing, and a raise would break
     * that promise in the loudest possible way: the cron dies, no files are written, and the
     * board freezes on the run whose whole purpose was to rescue it from a frozen board.
     *
     * An enum arriving as a length-delimited field is the shape that does it -- the reader
     * gets a string where the wire type promised a varint. Treated as absent, not guessed at
     * and not fatal.
     *
     * @dataProvider wireTypeConfusions
     */
    public function testAWireTypeMismatchIsSurvivedRatherThanRaised(string $vehicleBytes, string $why): void
    {
        $decoded = cm_gtfsrt_decode($this->feedWithVehicle($vehicleBytes));

        self::assertNotNull($decoded, $why);
        self::assertArrayNotHasKey('currentStatus', $decoded['entity'][0]['vehicle']);
    }

    /** @return array<string, array{string, string}> */
    public static function wireTypeConfusions(): array
    {
        $self = new self('wireTypeConfusions');

        return [
            'enum as string' => [
                $self->stringField(4, 'IN_TRANSIT_TO'),
                'a string where currentStatus expects a varint',
            ],
            'enum as float'  => [
                $self->float32Field(4, 2.0),
                'a float32 where currentStatus expects a varint',
            ],
        ];
    }

    /** A FeedMessage carrying several VehiclePositions, one entity per set of vehicle bytes. */
    private function feedWithVehicles(array $vehicleBytes, int $headerTs = 1788300715): string
    {
        $header = $this->stringField(1, '2.0')
            . $this->varintField(2, 0)
            . $this->varintField(3, $headerTs);

        $out = $this->lenField(1, $header);
        foreach ($vehicleBytes as $i => $bytes) {
            $out .= $this->lenField(2, $this->stringField(1, 'e' . $i) . $this->lenField(4, $bytes));
        }

        return $out;
    }

    /** A minimal well-formed vehicle, distinguishable by its label. */
    private function goodVehicle(string $label): string
    {
        return $this->lenField(1, $this->stringField(1, 'trip-' . $label))
            . $this->lenField(8, $this->stringField(1, 'v' . $label) . $this->stringField(2, $label));
    }

    /**
     * write.php refuses to write a document json_encode() could not encode, and json_encode()
     * fails outright on invalid UTF-8. One bad byte would otherwise cost every file that
     * vehicle appears in. The JSON publication cannot reach this -- json_decode() rejects it
     * upstream -- so the protobuf is what makes the case reachable at all.
     *
     * The corrupt bus is dropped rather than published with a hole in it: an absent field is
     * meaningful here, so a vehicle carrying an unreadable identifier must not be emitted
     * looking like a vehicle that simply had none.
     */
    public function testAVehicleWithInvalidUtf8IsDroppedAndTheRestOfTheFeedStillEncodes(): void
    {
        $corrupt = $this->lenField(8, $this->stringField(1, "bus\xC3\x28") . $this->stringField(2, 'bad'));

        $decoded = cm_gtfsrt_decode($this->feedWithVehicles([
            $this->goodVehicle('4090'),
            $corrupt,
            $this->goodVehicle('4091'),
        ]));

        self::assertNotNull($decoded, 'one bad bus must not cost the whole rescue');
        self::assertCount(2, $decoded['entity'], 'the corrupt bus is dropped, the others are not');
        self::assertSame(
            ['4090', '4091'],
            array_map(static fn (array $e): string => $e['vehicle']['vehicle']['label'], $decoded['entity']),
            'the survivors are the two good buses, in order'
        );
        self::assertNotFalse(json_encode($decoded), 'the whole point: the run can still write');
    }

    /**
     * A vehicle with no `trip` is not an error downstream, it is a deadhead -- join.php reads
     * it as a bus running out of service. So dropping a TripDescriptor that would not decode
     * turns a corrupt field into a confident, wrong statement about that bus. The vehicle is
     * dropped whole instead.
     */
    public function testAnUndecodableSubmessageDropsTheBusRatherThanDeadheadingIt(): void
    {
        $decoded = cm_gtfsrt_decode($this->feedWithVehicles([
            $this->goodVehicle('4090'),
            $this->lenField(1, "\x08\xFF\xFF"),
        ]));

        self::assertNotNull($decoded);
        self::assertCount(1, $decoded['entity'], 'a broken trip must not read as no trip');
        self::assertSame('4090', $decoded['entity'][0]['vehicle']['vehicle']['label']);
    }

    /**
     * The floor on dropping. A handful of unreadable buses is field corruption and the rescue
     * is still worth having; most of them failing means we are reading the message wrongly,
     * and a confident partial fleet is worse than no fallback at all. The stale JSON wins.
     */
    public function testAFeedWhoseEntitiesMostlyFailIsRejectedRatherThanPublishedPartial(): void
    {
        $broken = $this->lenField(1, "\x08\xFF\xFF");

        $mostlyGood = cm_gtfsrt_decode($this->feedWithVehicles([
            $this->goodVehicle('1'),
            $this->goodVehicle('2'),
            $broken,
        ]));
        $mostlyBad = cm_gtfsrt_decode($this->feedWithVehicles([
            $this->goodVehicle('1'),
            $broken,
            $broken,
        ]));

        self::assertNotNull($mostlyGood, 'one failure in three is corruption, not a misread');
        self::assertCount(2, $mostlyGood['entity']);
        self::assertNull($mostlyBad, 'more failures than successes means we are reading it wrongly');
    }

    /**
     * NAN and INF are representable in a float32 on the wire and are not encodable as JSON.
     * Same hole invalid UTF-8 opens, reached through the position fields instead.
     */
    public function testANonFiniteCoordinateIsRejectedRatherThanBreakingEveryWrite(): void
    {
        $nan = $this->lenField(2, $this->varint((1 << 3) | 5) . pack('g', NAN));

        $decoded = cm_gtfsrt_decode($this->feedWithVehicles([$this->goodVehicle('4090'), $nan]));

        self::assertNotNull($decoded);
        self::assertCount(1, $decoded['entity'], 'the bus carrying NAN is dropped');
        self::assertNotFalse(json_encode($decoded));
    }

    /** @return array<string, array{string, string}> */
    public static function malformed(): array
    {
        return [
            'empty'              => ['', 'an empty body is not a feed'],
            'truncated varint'   => ["\x08\xFF\xFF", 'a varint running off the end'],
            'length beyond body' => ["\x0A\x7F" . 'short', 'a length prefix longer than what follows'],
            'no header'          => ["\x12\x02\x0A\x00", 'a feed with entities but no header'],
            'html error page'    => ['<!DOCTYPE html><html>', 'an HTML error page served with a 200'],
        ];
    }

    /* ---- the differential ---------------------------------------------------------- */

    /**
     * The test that actually proves the decoder: the same feed, published both ways, must
     * decode to the same records.
     *
     * Pairing is on (entity id, vehicle timestamp) because the two files are published
     * independently and are never snapshots of the same instant. Only records describing the
     * same observation are compared; everything else is ignored rather than fudged.
     *
     * Needs a capture taken while BOTH publications are healthy, which is why it is not in
     * feeds-20260901-stall: that capture is of the stall itself, with the JSON four hours
     * behind the PB, and nothing in it pairs.
     */
    public function testDecodedProtobufMatchesTheJsonExportForTheSameObservations(): void
    {
        $dir = Runtime::dirOrSkip(
            $this,
            'tests/fixtures/feeds-pb-differential',
            'needs a positions capture with both publications healthy; see issue 14'
        );

        $json = json_decode((string) file_get_contents($dir . '/vehiclepositions.json'), true, 512, JSON_THROW_ON_ERROR);
        $pb = cm_gtfsrt_decode((string) file_get_contents($dir . '/vehiclepositions.pb'));
        self::assertIsArray($pb, 'the PB half of the differential fixture must decode');

        $index = [];
        foreach ($json['entity'] as $entity) {
            $key = ($entity['id'] ?? '') . '@' . ($entity['vehicle']['timestamp'] ?? '');
            $index[$key] = $entity['vehicle'];
        }

        $compared = 0;
        foreach ($pb['entity'] as $entity) {
            $key = ($entity['id'] ?? '') . '@' . ($entity['vehicle']['timestamp'] ?? '');
            if (!isset($index[$key])) {
                continue;
            }
            $this->assertVehiclesAgree($index[$key], $entity['vehicle'], $key);
            $compared++;
        }

        self::assertGreaterThan(
            50,
            $compared,
            'too few paired observations for the differential to mean anything'
        );
    }

    private function assertVehiclesAgree(array $fromJson, array $fromPb, string $key): void
    {
        foreach (['currentStopSequence', 'currentStatus', 'stopId'] as $field) {
            self::assertSame(
                $fromJson[$field] ?? null,
                $fromPb[$field] ?? null,
                "{$field} differs for {$key}"
            );
        }

        foreach (['tripId', 'startTime', 'startDate', 'scheduleRelationship', 'routeId', 'directionId'] as $field) {
            self::assertSame(
                $fromJson['trip'][$field] ?? null,
                $fromPb['trip'][$field] ?? null,
                "trip.{$field} differs for {$key}"
            );
        }

        foreach (['id', 'label'] as $field) {
            self::assertSame(
                $fromJson['vehicle'][$field] ?? null,
                $fromPb['vehicle'][$field] ?? null,
                "vehicle.{$field} differs for {$key}"
            );
        }

        /*
         * Positions are float32 on the wire and shortest-round-trip decimals in the JSON, so
         * they are never bit-identical. 1e-5 degrees is about a metre: far tighter than any
         * decoding error and far looser than the representation gap.
         */
        foreach (['latitude', 'longitude', 'bearing', 'speed'] as $field) {
            $a = $fromJson['position'][$field] ?? null;
            $b = $fromPb['position'][$field] ?? null;
            if ($a === null && $b === null) {
                continue;
            }
            self::assertNotNull($a, "position.{$field} missing from the JSON for {$key}");
            self::assertNotNull($b, "position.{$field} missing from the PB for {$key}");
            self::assertEqualsWithDelta((float) $a, (float) $b, 1e-5, "position.{$field} differs for {$key}");
        }
    }
}
