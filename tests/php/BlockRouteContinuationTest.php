<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Fixtures;
use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\TestCase;

/**
 * Contract section 4: which routes a block covers, and which route the bus
 * becomes next.
 *
 * A rider watching a bus finish a trip is asking one of two questions -- is it
 * going to the garage, or is it about to run something else -- and the payload
 * used to answer neither. `next_trip` named a trip id with no route on it, so
 * "it has more work" was sayable and "it becomes the 485" was not, and a `low`
 * confidence grade arrived with no way to explain that a multi-route block
 * caused it.
 *
 * Every fact here already exists in blocks.json. The failure mode these tests
 * guard is not a missing computation but a wrong join: taking the successor's
 * route from the bus reading the record rather than from the successor. That
 * mistake is invisible on the 214 single-route blocks in the capture and wrong
 * on exactly the 7 cross-route continuations the field exists for.
 */
final class BlockRouteContinuationTest extends TestCase
{
    private const FILES = ['runtime/lib/shards.php', 'runtime/lib/join.php'];
    private const SHARD_DIR = 'data';

    protected function setUp(): void
    {
        Runtime::functionsOrSkip(
            $this,
            ['cm_shard_block', 'cm_shard_route_short_name', 'cm_trip_is_last_of_block'],
            self::FILES
        );
    }

    public function testAVehicleOnASingleRouteBlockSaysTheBlockCoversOnlyThatRoute(): void
    {
        /*
         * Blocks 4001-4004 are route 4 and nothing else. This is the majority case
         * and the one a bug in the join would still get right, so it is here to pin
         * the shape rather than to catch the interesting error.
         */
        $vehicle = $this->generatedVehicle('4', '2701');

        self::assertSame('4001', $vehicle['block']['block_id']);
        self::assertFalse($vehicle['block']['spans_routes']);
        self::assertSame(['4'], $vehicle['block']['route_ids']);
    }

    public function testAVehicleOnBlock1010SaysTheBlockCoversAllThreeOfItsRoutes(): void
    {
        /*
         * Block 1010 is 92 trips across routes 1, 4 and 485, and bus 2867 was on it
         * on the captured minute. It is the reason section 4 downgrades a
         * multi-route block, so it is the reason the route set is published.
         */
        $vehicle = $this->generatedVehicle('4', '2867');

        self::assertSame('1010', $vehicle['block']['block_id']);
        self::assertTrue($vehicle['block']['spans_routes']);
        self::assertSame(['1', '4', '485'], $vehicle['block']['route_ids']);
    }

    public function testTheRouteSetIsWhatExplainsALowConfidenceGradeOnAnOtherwiseNormalBus(): void
    {
        /*
         * Bus 2867 is on time, in service, and graded low purely because its block
         * interlines. Before route_ids the client could report the hedge and not
         * the reason for it.
         */
        $vehicle = $this->generatedVehicle('4', '2867');

        self::assertSame('low', $vehicle['block']['confidence']);
        self::assertTrue($vehicle['block']['spans_routes']);
        self::assertGreaterThan(1, count($vehicle['block']['route_ids']));
    }

    public function testTheSuccessorsRouteIsTheSuccessorsOwnRouteAndNotTheBusesCurrentOne(): void
    {
        /*
         * Bus 2754 is running the 50 and its next trip is a 152. Copying the
         * vehicle's route_id onto next_trip would pass every single-route test in
         * this file and produce "it stays the 50", which is false.
         *
         * The claim is checked against the shard, not against the generator: the
         * successor trip id has to actually be a trip of route 152 in
         * data/routes/152/blocks.json.
         */
        $vehicle = $this->generatedVehicle('50', '2754');
        $next = $vehicle['block']['next_trip'];

        self::assertIsArray($next, 'bus 2754 has a successor in the capture');
        self::assertSame('50', $vehicle['route_id']);
        self::assertNotSame(
            $vehicle['route_id'],
            $next['route_id'],
            'this bus interlines; a next_trip route equal to the current route is the copy bug'
        );
        self::assertSame('152', $next['route_id']);
        self::assertSame('152', $next['route_short_name']);
        self::assertArrayHasKey(
            $next['trip_id'],
            $this->shardTrips('152'),
            'the successor trip must be a trip of the route next_trip.route_id names'
        );
    }

    public function testASuccessorOnTheSameRouteStillCarriesThatRouteRatherThanNull(): void
    {
        /*
         * The common case has to be populated too, or a client reading route_id gets
         * a usable answer only on the rare interlining bus and has to fall back to
         * the vehicle's route everywhere else -- which is the very inference this
         * field exists to remove.
         */
        $vehicle = $this->generatedVehicle('4', '2701');
        $next = $vehicle['block']['next_trip'];

        self::assertIsArray($next);
        self::assertSame('4', $next['route_id']);
        self::assertSame('4', $next['route_short_name']);
    }

    public function testAVehicleFinishingItsBlockReportsNoSuccessorAndSaysItIsTheLastTrip(): void
    {
        /*
         * Bus 201 on route 550 is the one vehicle in the capture whose trip ends its
         * block. Section 4 keeps confidence high here: "there is no continuation" is
         * a confident statement.
         */
        $vehicle = $this->generatedVehicle('550', '201');

        self::assertNull($vehicle['block']['next_trip']);
        self::assertTrue($vehicle['block']['is_last_trip']);
        self::assertSame('high', $vehicle['block']['confidence']);
    }

    public function testATripTheShardDoesNotKnowIsNotClaimedToBeTheLastOfItsBlock(): void
    {
        /*
         * The distinction is_last_trip carries: the build ASSERTS that a trip ends
         * its block, and an unresolvable trip asserts nothing. After a GTFS reset
         * every live trip id is unknown, and a bus whose successor cannot be found
         * must not be rendered as pulling into the garage.
         */
        self::assertFalse(cm_trip_is_last_of_block(null));
        self::assertFalse(cm_trip_is_last_of_block(['grade_reasons' => ['layover_too_long']]));
        self::assertTrue(cm_trip_is_last_of_block(['grade_reasons' => ['last_trip_of_block']]));
    }

    public function testNoVehicleNamesASuccessorRouteItsBlockDoesNotCover(): void
    {
        /*
         * The sweep. A successor naming a route absent from its own block's route
         * set is a join bug -- the successor was looked up in the wrong table, or
         * the route set was copied from the wrong block -- and it would be invisible
         * on the 214 single-route blocks where both answers coincide. Run it over
         * every generated route, not the golden fixture: the fixture is route 4,
         * and route 4 has one interlining block out of five.
         */
        $checked = 0;
        foreach ($this->generatedRouteFiles() as $path) {
            $doc = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
            foreach ($doc['vehicles'] as $vehicle) {
                $block = $vehicle['block'] ?? null;
                if ($block === null || $block['next_trip'] === null) {
                    continue;
                }
                $checked++;
                self::assertContains(
                    $block['next_trip']['route_id'],
                    $block['route_ids'],
                    sprintf(
                        'vehicle %s on block %s continues onto route %s, which is not in %s',
                        $vehicle['vehicle_id'],
                        (string) $block['block_id'],
                        (string) $block['next_trip']['route_id'],
                        json_encode($block['route_ids'])
                    )
                );
            }
        }

        self::assertGreaterThan(
            200,
            $checked,
            'the sweep found almost no continuations to check, which means it swept the wrong thing'
        );
    }

    public function testNoVehicleClaimsToBePullingInWhileNamingItsNextTrip(): void
    {
        /*
         * is_last_trip and next_trip are two readings of the same fact from two
         * different places -- the build's grade reasons and its successor link -- so
         * they are worth holding against each other. A vehicle asserting both is a
         * shard the runtime is reading inconsistently.
         */
        foreach ($this->generatedRouteFiles() as $path) {
            $doc = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
            foreach ($doc['vehicles'] as $vehicle) {
                $block = $vehicle['block'] ?? null;
                if ($block === null) {
                    continue;
                }
                if ($block['is_last_trip']) {
                    self::assertNull(
                        $block['next_trip'],
                        sprintf('vehicle %s ends its block and still names a successor', $vehicle['vehicle_id'])
                    );
                }
            }
        }
    }

    public function testAllJsonCarriesTheSameBlockShapeAsTheRouteFile(): void
    {
        /*
         * all.json republishes the same Vehicle object. A field added to one and not
         * the other means the map and the route board disagree about the same bus.
         */
        $fromRoute = $this->generatedVehicle('4', '2867');
        $fromAll = null;
        foreach ($this->readGenerated('/api/all.json')['vehicles'] as $vehicle) {
            if ($vehicle['vehicle_id'] === '2867') {
                $fromAll = $vehicle;
                break;
            }
        }

        self::assertNotNull($fromAll, 'bus 2867 is in the capture and belongs in all.json');
        self::assertSame($fromRoute['block'], $fromAll['block']);
    }

    /** @return array<string, mixed> the trips table of a committed route shard */
    private function shardTrips(string $routeId): array
    {
        $dir = Runtime::dirOrSkip(
            $this,
            self::SHARD_DIR,
            sprintf('no schedule shards at %s. See tests/NOTES.md.', self::SHARD_DIR)
        );
        $path = $dir . '/routes/' . $routeId . '/blocks.json';
        if (!is_file($path)) {
            self::markTestSkipped(sprintf('no block shard for route %s at %s.', $routeId, $path));
        }

        return json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR)['trips'] ?? [];
    }

    /** @return list<string> every generated per-route file */
    private function generatedRouteFiles(): array
    {
        $dir = Fixtures::webroot() . '/api/route';
        $files = is_dir($dir) ? (glob($dir . '/*.json') ?: []) : [];
        if ($files === []) {
            self::markTestSkipped(sprintf(
                'no generated route files at %s. Regenerate with runtime/config.fixture.php and set '
                . 'CAPMETRO_WEBROOT. See tests/NOTES.md.',
                $dir
            ));
        }
        sort($files);

        return $files;
    }

    /** @return array<string, mixed> */
    private function generatedVehicle(string $routeId, string $vehicleId): array
    {
        $doc = $this->readGenerated('/api/route/' . $routeId . '.json');
        foreach ($doc['vehicles'] as $vehicle) {
            if ($vehicle['vehicle_id'] === $vehicleId) {
                return $vehicle;
            }
        }

        self::fail(sprintf('vehicle %s is not on route %s in the generated output', $vehicleId, $routeId));
    }

    /** @return array<string, mixed> */
    private function readGenerated(string $rel): array
    {
        $path = Fixtures::webroot() . $rel;
        if (!is_file($path)) {
            self::markTestSkipped(sprintf(
                'no generated output at %s. Regenerate with runtime/config.fixture.php and set '
                . 'CAPMETRO_WEBROOT. See tests/NOTES.md.',
                $path
            ));
        }

        return json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    }
}
