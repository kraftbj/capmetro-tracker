# Test fixtures

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
