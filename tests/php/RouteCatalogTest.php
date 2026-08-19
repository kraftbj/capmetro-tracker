<?php

declare(strict_types=1);

namespace CapMetro\Tests;

use CapMetro\Tests\Support\Fixtures;
use CapMetro\Tests\Support\Runtime;
use PHPUnit\Framework\TestCase;

/**
 * Contract section 15: the route catalog behind api/routes.json.
 *
 * The catalog exists because the picker cannot hard-code a route list. The
 * build generates 71 route files; a client that names six of them is wrong the
 * day CapMetro adds a route, and wrong silently. Everything asserted here is
 * about the two ways a catalog can still mislead after it is complete: an order
 * a rider cannot scan, and a row that hides a route instead of explaining it.
 */
final class RouteCatalogTest extends TestCase
{
    private const FILES = ['runtime/lib/catalog.php'];

    protected function setUp(): void
    {
        Runtime::functionsOrSkip(
            $this,
            [
                'cm_route_sort_key',
                'cm_sort_route_catalog',
                'cm_catalog_vehicle_counts',
                'cm_catalog_entry',
                'cm_build_route_catalog',
            ],
            self::FILES
        );
    }

    /** @param list<string> $shortNames */
    private static function rows(array $shortNames): array
    {
        return array_map(
            static fn (string $n): array => ['id' => $n, 'short_name' => $n],
            $shortNames
        );
    }

    /** @return list<string> */
    private static function order(array $sorted): array
    {
        return array_map(static fn (array $r): string => (string) $r['short_name'], $sorted);
    }

    public function testSortsRouteNumbersByValueSoTenLandsAfterSevenAndNotBetweenOneAndOneHundredThree(): void
    {
        /*
         * The exact failure lexicographic order produces on this feed: "10" < "103" < "18"
         * < "2" puts the 10 nine rows above the 4. CapMetro route numbers are read as
         * numbers, so they have to sort as numbers.
         */
        $sorted = cm_sort_route_catalog(self::rows(['103', '10', '4', '1', '18', '7', '2']));

        self::assertSame(['1', '2', '4', '7', '10', '18', '103'], self::order($sorted));
    }

    public function testPutsEveryNonNumericShortNameAfterEveryNumericOneAndOrdersThoseAlphabetically(): void
    {
        /*
         * No route in feed 260818_1456 has a letter in its short_name, but route ids are
         * strings by contract (section 0) precisely because that is not guaranteed. A
         * lettered route sorting into the middle of the numbers would be worse than one
         * sorting to the end, so the rule is a two-bucket one and it is tested now rather
         * than discovered later.
         */
        $sorted = cm_sort_route_catalog(self::rows(['MetroRail', '803', 'Airport', '4']));

        self::assertSame(['4', '803', 'Airport', 'MetroRail'], self::order($sorted));
    }

    public function testBreaksATieBetweenTwoSpellingsOfTheSameNumberDeterministically(): void
    {
        /*
         * "07" and "7" are numerically equal, so the numeric key alone leaves their order
         * to usort's internals. Two runs over one feed must produce byte-identical files
         * or every diff between two days is unreadable, so the key falls through to the
         * string and then to the route id.
         */
        $twice = [
            cm_sort_route_catalog(self::rows(['7', '07'])),
            cm_sort_route_catalog(self::rows(['07', '7'])),
        ];

        self::assertSame(self::order($twice[0]), self::order($twice[1]));
    }

    public function testSortsARouteWithAnEmptyShortNameIntoTheAlphaBucketRatherThanTreatingItAsZero(): void
    {
        /*
         * ctype_digit('') is false, but a naive (int) cast makes an empty name sort as 0
         * and therefore first, which would put the least identifiable row at the top of
         * the picker.
         */
        self::assertSame([1, 0, ''], cm_route_sort_key(''));
    }

    public function testCountsVehiclesByTheirOwnInServiceFlagRatherThanByHowManyAreListed(): void
    {
        $counts = cm_catalog_vehicle_counts([
            ['vehicle_id' => '1', 'in_service' => true],
            ['vehicle_id' => '2', 'in_service' => true],
            ['vehicle_id' => '3', 'in_service' => false],
        ]);

        self::assertSame(['in_service' => 2, 'out_of_service' => 1], $counts);
    }

    public function testReportsZeroForBothCountsWhenTheRouteHasNoVehiclesAtAll(): void
    {
        /*
         * A route with no bus is the empty state the whole board is designed around. It
         * must produce two zeroes, never an absent key: section 0 forbids the client
         * inferring a number from a missing field.
         */
        self::assertSame(
            ['in_service' => 0, 'out_of_service' => 0],
            cm_catalog_vehicle_counts([])
        );
    }

    public function testKeepsARouteWithNoServiceTodayInTheCatalogSoThePickerCanSaySo(): void
    {
        /*
         * Four of the 71 routes run no trips on 20260819. Dropping them would leave a
         * rider who searches for the 492 with nothing on screen and no reason why, which
         * is exactly the inference the client is forbidden to make.
         */
        $entry = cm_catalog_entry(
            ['id' => '492', 'short_name' => '492', 'long_name' => '492-Test', 'directions' => []],
            [],
            false
        );

        self::assertSame('492', $entry['id']);
        self::assertFalse($entry['has_service_today']);
    }

    public function testPublishesLongNameVerbatimIncludingTheLeadingRouteNumberPrefix(): void
    {
        /*
         * api/route/{id}.json publishes long_name untouched. Stripping it here would give
         * the same route two different names on two screens; consistency between the two
         * documents is worth more than saving the client one call to a strip function.
         */
        $entry = cm_catalog_entry(
            ['id' => '1', 'short_name' => '1', 'long_name' => '1-North Lamar/South Congress', 'directions' => []],
            [],
            true
        );

        self::assertSame('1-North Lamar/South Congress', $entry['long_name']);
    }

    public function testFallsBackToASingleUnnamedDirectionZeroWhenTheShardNamesNone(): void
    {
        /*
         * The schema requires at least one direction. A route whose manifest entry lost
         * its directions must still produce a valid row rather than failing validation
         * and taking the whole catalog down with it.
         */
        $entry = cm_catalog_entry(['id' => '900', 'short_name' => '900', 'long_name' => ''], [], true);

        self::assertSame([['id' => 0, 'headsign' => null]], $entry['directions']);
    }

    public function testTheEnvelopeCarriesTheSystemServiceDayUnchanged(): void
    {
        /*
         * The catalog is a system document, so it carries the system service day exactly
         * as all.json does. A per-route calendar cannot go in this field: it would have
         * to be 71 different answers at once, which is what has_service_today is for.
         */
        $serviceDay = ['date' => '20260819', 'service_ids' => ['3-172'], 'is_exception_day' => true];

        $doc = cm_build_route_catalog(1787152239, $serviceDay, self::rows(['4']));

        self::assertSame(1, $doc['schema']);
        self::assertSame(1787152239, $doc['generated_at']);
        self::assertSame($serviceDay, $doc['service_day']);
    }

    public function testTheGeneratedCatalogAgreesWithAllJsonOnHowManyBusesAreInService(): void
    {
        /*
         * The two documents are built from one join in one run. If they ever disagree,
         * the picker's row counts and the system board's header are reporting different
         * realities and one of them is a lie.
         */
        $webroot = Fixtures::webroot();
        foreach (['/api/routes.json', '/api/all.json'] as $rel) {
            if (!is_file($webroot . $rel)) {
                self::markTestSkipped(sprintf(
                    'no generated output at %s. Regenerate with runtime/config.fixture.php and set '
                    . 'CAPMETRO_WEBROOT. See tests/NOTES.md.',
                    $webroot
                ));
            }
        }

        $catalog = json_decode((string) file_get_contents($webroot . '/api/routes.json'), true);
        $all = json_decode((string) file_get_contents($webroot . '/api/all.json'), true);

        $summed = array_sum(array_column(array_column($catalog['routes'], 'vehicles'), 'in_service'));

        self::assertSame($all['counts']['in_service'], $summed);
    }
}
