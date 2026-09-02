<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\TestCase;

/**
 * What the board publishes for an enum value neither feed's vocabulary covers (issue 14).
 *
 * The protobuf decoder deliberately refuses to guess: an enum wire number it does not
 * recognize comes back as the raw integer, because defaulting a future ScheduleRelationship
 * to SCHEDULED could quietly reinstate a canceled trip, and that is the worst failure this
 * feed has available. But a raw integer is not one of the names the published schema declares
 * these fields to hold, so passing it straight through would put the board's own output
 * outside its contract -- swapping a silent data error for a silent schema violation.
 *
 * join.php is where the two requirements meet. Reading the JSON feed nothing changes, since
 * CapMetro's export has only ever emitted names; it is the protobuf path that makes these
 * reachable at all.
 */
final class UnknownEnumPublishingTest extends TestCase
{
    private const FILES = ['runtime/lib/join.php'];

    protected function setUp(): void
    {
        Runtime::functionsOrSkip($this, ['cm_build_vehicle'], self::FILES);
    }

    /** One vehicle in service, with whatever trip and progress fields the case needs. */
    private function entity(array $trip = [], array $vehicle = []): array
    {
        return [
            'id'      => 'e1',
            'vehicle' => array_merge([
                'trip'      => array_merge(['tripId' => 'TRIP_1'], $trip),
                'position'  => ['latitude' => 30.26, 'longitude' => -97.74],
                'timestamp' => '1788300715',
                'vehicle'   => ['id' => '4090', 'label' => '4090'],
            ], $vehicle),
        ];
    }

    private function build(array $entity): array
    {
        $out = cm_build_vehicle($entity, null, null, null, false, null, 1788300715);
        self::assertIsArray($out, 'the fixture vehicle must build');

        return $out;
    }

    /* ---- schedule_relationship ------------------------------------------------------- */

    /** @dataProvider knownRelationships */
    public function testAKnownRelationshipIsPublishedUnchanged(string $name): void
    {
        $out = $this->build($this->entity(['scheduleRelationship' => $name]));

        self::assertSame($name, $out['trip']['schedule_relationship']);
    }

    /** @return array<string, array{string}> */
    public static function knownRelationships(): array
    {
        return [
            'SCHEDULED'   => ['SCHEDULED'],
            'CANCELED'    => ['CANCELED'],
            'ADDED'       => ['ADDED'],
            'UNSCHEDULED' => ['UNSCHEDULED'],
            'REPLACEMENT' => ['REPLACEMENT'],
            'DUPLICATED'  => ['DUPLICATED'],
            'DELETED'     => ['DELETED'],
        ];
    }

    /**
     * The decoder's honest integer, published as UNKNOWN. Not SCHEDULED, which would be a
     * guess, and not "42", which the schema's closed enum forbids.
     */
    public function testAnUnrecognizedRelationshipIsPublishedAsUnknown(): void
    {
        $out = $this->build($this->entity(['scheduleRelationship' => 42]));

        self::assertSame('UNKNOWN', $out['trip']['schedule_relationship']);
    }

    /** The property that actually matters: an unknown value is never mistaken for a cancellation. */
    public function testAnUnrecognizedRelationshipIsNotTreatedAsCanceled(): void
    {
        /* Wire 3 is CANCELED, and the decoder hands join.php the name, not the number. */
        $out = $this->build($this->entity(['scheduleRelationship' => 'CANCELED']));
        self::assertSame('CANCELED', $out['trip']['schedule_relationship'], 'the control');

        $unknown = $this->build($this->entity(['scheduleRelationship' => 42]));
        self::assertNotSame('CANCELED', $unknown['trip']['schedule_relationship']);
    }

    public function testAMissingRelationshipStillDefaultsToScheduled(): void
    {
        $out = $this->build($this->entity());

        self::assertSame('SCHEDULED', $out['trip']['schedule_relationship'], 'absent is not unknown');
    }

    /* ---- current_status -------------------------------------------------------------- */

    /** @dataProvider knownStatuses */
    public function testAKnownStatusIsPublishedUnchanged(string $name): void
    {
        $out = $this->build($this->entity([], ['currentStatus' => $name]));

        self::assertSame($name, $out['progress']['current_status']);
    }

    /** @return array<string, array{string}> */
    public static function knownStatuses(): array
    {
        return [
            'INCOMING_AT'   => ['INCOMING_AT'],
            'STOPPED_AT'    => ['STOPPED_AT'],
            'IN_TRANSIT_TO' => ['IN_TRANSIT_TO'],
        ];
    }

    /**
     * current_status already publishes null when the feed does not say, so an unrecognized
     * value reads as "we do not know where this bus is in its trip" -- true, and already a
     * value the schema and the client both handle.
     */
    public function testAnUnrecognizedStatusIsPublishedAsNullRatherThanAnInteger(): void
    {
        $out = $this->build($this->entity([], ['currentStatus' => 9]));

        self::assertNull($out['progress']['current_status']);
    }

    /* ---- the contract these exist to keep -------------------------------------------- */

    /**
     * The published values must be exactly what the schema declares. A name added to one and
     * not the other is how the board's own output drifts outside its contract, which is the
     * whole failure this test is here to catch.
     */
    public function testThePublishedVocabulariesMatchTheSchema(): void
    {
        $schema = json_decode(
            (string) file_get_contents(Runtime::root() . '/schemas/common.schema.json'),
            true
        );

        $vehicle = $schema['$defs']['vehicle']['properties'] ?? null;
        self::assertIsArray($vehicle, 'schemas/common.schema.json must still define a vehicle');

        /* Compared as sets: an enum's declaration order carries no meaning, and pinning it
           would fail on a harmless reordering while catching nothing real. */
        self::assertEqualsCanonicalizing(
            $vehicle['trip']['properties']['schedule_relationship']['enum'],
            CM_SCHEDULE_RELATIONSHIPS,
            'join.php and the schema disagree on schedule_relationship'
        );
        self::assertEqualsCanonicalizing(
            $vehicle['progress']['properties']['current_status']['enum'],
            [...CM_VEHICLE_STOP_STATUSES, null],
            'join.php and the schema disagree on current_status'
        );
    }
}
