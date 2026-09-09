# Test fixtures

> **THIS REPOSITORY MUST STAY PRIVATE, OR THIS FIXTURE MUST BE SANITIZED FIRST.**
>
> `feeds-20260819/servicealerts.json` contains **20 real CapMetro employees'** full names and
> `@capmetro.org` email addresses (`userFullname`, `userEmail` on every alert object). CapMetro
> publishes them; those people did not choose to appear in this repo.
>
> The application strips both fields at ingest and no generated file contains them, which
> `tests/schema/validate.py` asserts. That protects the app's output. It does **not** protect
> this raw fixture, which is committed and is in git history.
>
> Before making this repository public, or sharing it outside your household, replace those 20
> identities with synthetic ones and purge the originals from history. Decided 2026-08-19.

## `feeds-20260819/`

Live CapMetro feed responses captured 2026-08-19 at 10:10 CT, plus the GTFS static
`calendar_dates.txt` and `feed_info.txt` they correspond to. See `MANIFEST.json`.

**Why this date.** 2026-08-19 runs one-off service `3-172`: a single-date, full-system schedule
of 2,388 trips across 46 routes. Only 8 of the 145 dates in this feed have a one-off service
(2026-08-18 through 08-22, plus 10-31, 12-12, and 12-31). Capturing on an ordinary weekday would
have produced a fixture that silently hides trip-ID instability, which is exactly the failure
mode saved watches have to survive.

**Do not regenerate these files casually.** After 2026-08-22 the next one-off service date is
2026-10-31.

Gotchas these fixtures encode:
- `servicealerts.json` is NOT GTFS-Realtime. It is a bespoke Socrata array: camelCase keys,
  `informedEntities` (plural), `activePeriods`, and no `header`/`entity` envelope.
- `servicealerts.json` contains CapMetro staff PII (`userEmail`, `userFullname`). Strip it before
  rendering, caching, or logging.
- `tripupdates.json` has predicted times only. There is no `delay` field, so lateness requires
  GTFS `stop_times`.
- At capture time, 6 stop/route pairs were scheduled but under an active `NO_SERVICE` alert,
  including route 4 stops `1967` and `1971`, two of the three stops the Austin High special
  pattern adds.

## `feeds-20260901-stall/`

The vehicle positions stall of 2026-09-01, captured live at 17:12 CDT while it was happening.
Both halves are the same feed at the same moment, published two different ways:

- `vehiclepositions.json` — CapMetro's JSON publication (`cuc7-ywmd`), **frozen at 12:40:09
  CDT**, 404 entities, 272 minutes stale at capture.
- `vehiclepositions.pb` — the protobuf publication of the same feed (`eiei-9rpf`), current to
  the second, 413 entities.

**Why this pair is worth keeping.** It is the failure mode itself, not a reconstruction of it:
a JSON feed serving a clean 200 with well-formed, internally consistent, four-hour-old content
while the alternative publication is fine. Every per-vehicle timestamp in the JSON agrees with
its header, which is what makes the stall invisible to anything that checks only for a
successful fetch. `GtfsRtDecoderTest` decodes the PB half; the fallback logic in `fetch.php`
exists because of this capture.

**It also drives the fallback end to end.** `generate-api.php --fixtures=<dir>` runs the same
choice the network path runs whenever the directory holds a `vehiclepositions.pb` beside the
JSON, so `PositionsFallbackTest` points the real generator at this pair and asserts the webroot
it writes reports `positions_source: protobuf`. That run exits 1: the positions are from
2026-09-01 and the only committed shards are `260818_1456`, so the trips do not correlate and
the generator says so. The mismatch is the fixtures', not the fallback's — the test asserts
which source was used and that a webroot was written, never the board's content.

**This pair cannot serve the differential test.** The two files are four hours apart, so
nothing in them pairs. Proving the decoder agrees with the JSON export needs a capture where
both publications describe one instant; see `feeds-pb-differential/` below, which now holds the
trip updates pair but still not the positions one.
`GtfsRtDecoderTest::testDecodedProtobufMatchesTheJsonExportForTheSameObservations` skips until
`feeds-pb-differential/vehiclepositions.pb` exists. See issue 14.

**No PII.** Vehicle positions carry vehicle and trip identifiers and nothing about a person.
The staff-identity problem described at the top of this file is confined to `servicealerts.json`.

## `feeds-pb-differential/`

Captures where **both** of CapMetro's publications of one feed describe the **same instant**, so
a decoder can be compared against the real export rather than only against the spec. CLAUDE.md
treats that distinction as the whole point of these files: unit tests prove the decoder matches
the GTFS-RT spec, and only a differential run proves it matches what CapMetro actually emits,
because we own neither half of the comparison and CapMetro can change its export without telling
us.

Each test guards on **its own file**, not on this directory, since the two pairs arrived years
apart in project time. `Runtime::fileOrSkip` is what makes that possible.

### `tripupdates.json` + `tripupdates.pb` — taken 2026-09-09

Both publications of the trip updates feed (`mqtr-wwpy` JSON, `rmk2-acnw` protobuf), each with
header timestamp **1788946436**, 2,299 entities, decoding to identical structures down to key
order. `TripUpdatesFallbackTest::testDecodedProtobufIsIdenticalToTheJsonExportOfTheSameInstant`
compares them with `===` per entity.

**Why this capture was possible at all is the odd part.** It was taken during a total outage:
every CapMetro publication to data.texas.gov stopped within four minutes that morning. Frozen
publications make an unusually good differential pair — both halves stopped on the same instant
and neither moves under you while you fetch them, which is exactly the property a live capture
has to race for.

**A companion test pins what the capture contains** (SKIPPED and SCHEDULED rows, arrivals,
departures, an embedded VehicleDescriptor), so a future re-take that loses a case fails loudly
instead of quietly weakening the equality above.

### `vehiclepositions.json` + `vehiclepositions.pb` — not taken yet

The positions pair still needs a capture. The 2026-09-09 outage could **not** provide one: its
two positions publications froze 29 seconds apart, and the differential test pairs entities on
`id@vehicle.timestamp`, so only 9 of 260 vehicles matched against a floor of 50. Buses move in
29 seconds; trip updates for a given trip mostly do not, which is why one pair survived that day
and the other did not.

**No PII.** Trip updates carry trip, stop and vehicle identifiers and nothing about a person;
verified by key inventory over all 2,299 entities before committing.
