# Changelog

All notable changes to the Dillo Bus Board are recorded here.
Versions are `MAJOR.MINOR.PATCH.MICRO`.

## [Unreleased]

### Added

- **Transfer chains.** A journey with a change in it — the 800 to the 4, the 337 to
  the 350, the 337 to the 7 to the 837 — saved and shown as one card instead of two
  or three route boards to compare by hand. The card leads with when the first bus
  is actually due and with whether the change holds: **connection holds**, **tight**,
  or **missed**, computed from predicted times rather than the timetable, so a first
  bus nine minutes down turns a comfortable eight-minute change into a missed one an
  hour before anyone reaches the stop. Where a bus is not reporting, its scheduled
  time stands in and the card says so rather than passing a timetable off as a
  prediction. Up to three buses per chain. Chains live only in this browser and are
  never sent anywhere, exactly as saved trips are.

  A transfer is a **pair of stops within a short walk**, not a shared stop id. This
  is not a refinement: routes 800 and 4 share **zero** stop ids on this feed, so the
  obvious implementation would have reported "these routes do not connect" about the
  change this feature was asked for. They meet at Pleasant Valley where the
  MetroRapid platform and the local kerb are 27 m apart under different ids. The walk
  is charged against the slack at a deliberately slow 1.2 m/s rather than assumed
  free.

  The editor only ever offers connections that exist — it walks the real downstream
  stops of the real trip picked and the real departures of the onward route — so an
  unresolvable chain cannot be created, which is the same reasoning saved trips use
  for picking a time from a list rather than typing one.

### Fixed

- **The Saved view was fetching route payloads in an unthrottled loop.**
  `loadRouteData()` is called from `paint()` and its success handler calls
  `render()`; its only guard was "am I already fetching", which is false by the time
  the handler runs. One fetch repainted, the repaint started another fetch, and the
  view sat in a request loop against the origin — measured at 115 requests in three
  seconds — for as long as it was open. Nothing looked wrong on screen, which is why
  it survived: the numbers were right, they were just being re-fetched forever. Found
  because a transfer-chain card was being rebuilt so fast its Remove button could not
  be clicked. Regression test asserts at most one fetch per route between refreshes.
## [0.4.0.1] - 2026-08-20

### Fixed

- **The vhost served the board with no CSP.** nginx inherits `add_header` from
  an enclosing level only when the current level declares none of its own, so a
  single `add_header` inside a `location` silently discards every inherited one.
  Each location sets its own `Cache-Control`, which meant the four security
  headers declared at server level reached only `location /` -- and
  `location = /index.html` shadows it. The one HTML document on the origin, and
  every script, stylesheet and API response, went out with no
  Content-Security-Policy, no Referrer-Policy and no X-Frame-Options. Confirmed
  against `nginx:alpine`: zero of the three on `/index.html`, `/styles.css` and
  `/api/health.json` before, all four present on all five paths after. The
  Apache vhost was never affected -- `mod_headers` is additive across scopes.

### Changed

- The board is called **Dillo Bus Board**, matching the host it runs on.

## [0.4.0.0] - 2026-08-19

### Added

- **Cancelled trips are visible.** A cancelled trip used to render as
  "scheduled, no bus reporting yet", which reads as "it hasn't started" when it
  means "it is never coming". Someone waited at a stop for a bus that was never
  coming because of it. Cancellation is a property of a trip, not of a vehicle
  (a cancelled trip has no vehicle), so it is now published as one: each trip in
  `api/departures/{route}.json` carries `canceled`, and the route payload's
  `schedule` carries `canceled_trips` listing the ids it actually drew. A
  cancelled departure stays on the stop board, says the word CANCELED, and does
  not count as one of the two buses you were shown.
- **Next buses at a stop.** Pick a stop on any route and see the next two each
  way, ordered by when a bus will actually arrive rather than when it was
  scheduled to. A bus running twenty minutes late is still the next bus, and
  ordering by the timetable hides exactly that.
- **Every bus is tappable.** The all-buses screen lists every route with all of
  its buses, and opening one shows its route, next stop, when it is due there
  against when it was scheduled, the stop it just left, where it is, whether it
  is moving, and what it does next.
- **Whether a bus is pulling in or changing route.** `block.next_trip` now
  names the route it becomes, so the board can say "becomes route 333 at Oak
  Hill Plaza" instead of only "it has another trip". Seven buses on the captured
  day change route mid-block.
- **A route catalog and a deploy kit**, so the board can be installed on a plain
  Debian or Ubuntu box behind nginx or Apache with one command.

### Changed

- The vehicle rows read in running order, lead bus first, instead of worst-late
  first. Severity order is how a dispatcher triages a fleet; someone at a stop
  is asking which bus is nearest them.
- The all-buses screen no longer opens with a triage band.
- The map caption is a legend rather than a disclaimer. It stopped explaining at
  length that there are no streets under the drawing, which is plain from
  looking at it, and now says the two things that are not: larger dots are
  timepoints, and the dashed line is the inbound direction.

### Fixed

- The schedule boards were rewritten every sixty seconds, 3.9 GB a day, for data
  that changes about three times a year.
- The test suite was checking a fraction of what it claimed: webroot generation
  was gated on a directory that never existed, so schema validation ran 13
  checks where it should run 305 and eighteen PHP tests silently skipped.
- Both committed fixtures were hand-made and disagreed with real output in two
  ways: one carried a bus on a route the feed cannot attribute it to, and one
  recorded a feed age its own generator never computed. Regenerated from the
  runtime, which let five block fields become schema-required.

## [0.3.0.0] - 2026-08-19

### Added

- **Every route, not six.** The picker offers all 71 routes the build generates,
  with search by number or street name, live bus counts, and a note on the four
  routes that are not running today. The six routes this household rides stay
  pinned at the top as a shortcut. Previously the picker was hard-coded to those
  six while the backend generated seventy-one, so the board was wrong the moment
  either kid took a different bus.
- **An every-bus view, deadheads included.** 392 vehicles right now, 143 of them
  out of service. It leads with a count strip that answers "is anything unusual
  happening" without scrolling, then the buses that need a look, then the
  deadheads explained in plain language and split into moving and parked, then
  every route in order of worst news. Tapping a route opens its board.
- **Saved trips.** Save the departure you actually wait for — a route, a
  direction, a stop and a time chosen from what is really scheduled — and it
  appears from an hour before it is due until after it has gone, leading with
  when the bus will actually arrive rather than with how late it is. Saved trips
  live only in your browser and are never sent anywhere.
- **A real map of the route.** Every stop is plotted at its true position and
  joined in order, so the line traces the streets: 48 points on route 4 where
  the old panel drew 6. North is up, there is a scale bar in miles, and the
  panel height follows the route's own shape instead of squashing every
  north-south route into a horizontal band. There is still no basemap under it,
  and the caption says so.
- Two new endpoints behind all of this: a route catalog, and a full service day
  of scheduled stop times per route covering every stop rather than only the
  timepoints. The stop in the example that motivated saved trips is a minor
  stop, so the existing schedule data could not answer it.

### Fixed

- The test suite was checking a fraction of what it claimed. Webroot generation
  was gated on a directory this checkout never had, so every assertion about
  generated output quietly stood down: schema validation reported 13 passing
  checks where it should report 305, and the staff-privacy assertion — the most
  important test in the repo — was among the silent ones. Two PHP suites named
  the same dead path and a third globbed a shard layout the build abandoned; PHP
  assertions went from 1,843 to 7,914 once they ran.
- Three acceptance criteria then failed on first contact, none of them a code
  regression. Two asserted facts the fixture provably cannot contain, and one
  still enforced the truncation rule from before the stop-name fix. All three
  now assert the same substance where the fact actually lives, and the
  truncation rule is stronger than the one it replaces rather than weaker.
- A saved trip could not find its bus unless you happened to be looking at that
  route's board, which is the opposite of the point.

## [0.2.0.0] - 2026-08-19

### Added

- The ladder now has a real clock along the bottom. Scheduled trips are drawn as
  diagonals against that axis, so you can see the shape of the service, not just
  where one bus is: how far apart the trips are, where a gap opens up, and
  whether the bus you want is the one that already left.
- Every bus carries a stem showing how late it is, drawn to the same scale as
  the clock. A 10-minute stem and 10 minutes of clock are the same width, so
  lateness is something you measure against the schedule rather than read off a
  badge and try to place.

### Changed

- In both-directions mode the vehicle list is now grouped by direction and the
  groups line up with the ladders beneath them. Previously the rows flowed in
  time order across two columns, so the columns alternated southbound and
  northbound and matched neither ladder.
- Bus labels on the map carry a direction tag in both-directions mode. Without
  it there was no way to tell which way a bus was heading, which is the whole
  reason that mode exists.

### Fixed

- The drawn lateness disagreed with the printed lateness. The stem measured
  scheduled time at wherever the bus was standing; the badge measures predicted
  against scheduled at the next stop the bus has not passed. They are different
  measurements and could differ. Both now come from the same number.
- The latest buses drew no stem at all. A trip that started before the visible
  schedule window contributes no diagonal, and those buses are
  disproportionately the very late ones. On the 2026-08-19 feed, route 837 bus
  8030 at 17 minutes down and route 803 bus 2506 at 29 minutes down both
  rendered with no visible lateness.
- Routes that publish only one direction (466 and 642 among them) drew a phantom
  second ladder reading "No timepoints published for direction 1". The ladder
  hard-coded two directions instead of reading the route's own list.
- A bus whose direction the route does not publish is no longer dropped from the
  page. Grouping the rows by direction gave such a bus no group to land in, so it
  vanished while the header above went on counting it. On route 4 with a trimmed
  direction list that was two of six rows, one of them a bus in service. A bus
  that is not drawn reads exactly like a bus that is not running.
- The ladder says why it is empty when a payload names no directions at all.
  Previously it drew a heading over nothing.

## [0.1.0.0] - 2026-08-19

### Added

- First working board: live vehicle positions and schedule adherence for 71
  CapMetro routes, built from the GTFS static feed and the three GTFS-Realtime
  feeds, with a timepoint ladder, vehicle rows, a schematic position panel, and
  service alerts joined to the stops they close.
