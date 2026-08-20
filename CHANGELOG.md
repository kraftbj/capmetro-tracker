# Changelog

All notable changes to the Dillo Bus Board are recorded here.
Versions are `MAJOR.MINOR.PATCH.MICRO`.

## [Unreleased]

### Added

- **A stops link.** `#plan=1;800.1.6293.am;4.1.6243.pm` opens the board on the
  places somebody actually waits, resolved and on screen, and offers to keep
  them on that phone. A saved trip pins one departure; a stop is a place and a
  time of day, and shows the next few — which of the afternoon's buses gets
  caught is decided on the day, not in advance.
- **Turnaround stops answer the question that has no visible bus.** Route 4
  eastbound starts at Campbell/5th and Veterans/Atlanta; route 837 northbound
  starts at Republic Square. No eastbound bus ever approaches Campbell/5th — the
  bus that answers the question is westbound until it gets there. The card names
  the inbound leg and, when one is reporting, the bus running it: "Bus 2867
  brings it in on the 3:04p WB — due here in 4 minutes, running 35 seconds
  late." A continuation the feed has not confirmed is said as a likelihood, per
  contract section 4; every route 837 block in the 2026-08-19 capture is
  `confidence: low`, so that is the ordinary case, not an edge one.
- The plan rides in the URL fragment, which browsers never send, so the access
  log never carries the stops. `index.html` now also declares
  `referrer: no-referrer` so that holds where the vhost does not reach — a board
  opened from disk, or served by something other than the shipped nginx config.

### Fixed

- **An unbounded fetch-and-render loop.** `loadRouteData` and `loadDepartures`
  call `render()` from their callbacks, and the views that need them call the
  loaders from inside `paint()`. Both treated any status other than `loading` as
  fetchable, so a route that had already resolved was re-fetched by the very
  paint its own response triggered — a request per animation frame. It made the
  stops view's offer button unclickable, being detached and rebuilt faster than
  a tap could land, and spun hardest from a `file://` URL where the rejection is
  immediate. Only an idle status is fetchable now, which is the contract the
  refresh timer was already written to.
- **A schedule was cached for the life of the tab.** A departures document
  describes one service day, and nothing evicted it. A phone left on the counter
  overnight and picked up at seven still held yesterday's: every stop reading
  "the last one today has gone", on the exact surface someone consults at
  breakfast and has no reason to doubt. It is now checked against the service
  date the live payload reports, and re-asked for on the timer.
- **A stop id naming something on `Object.prototype` blanked the board.**
  `departures['constructor']` returns the `Object` function — truthy, so an
  `|| []` fallback never fires, with a length of 1 and nothing at [0]. The next
  read threw, during render. Unreachable while every id came from internal
  state; a URL fragment made it reachable. Guarded at the shared lookup, and the
  route-keyed caches are now prototype-free.
- **"Keep on this phone" reported success when nothing was kept.** Both
  `plan.save()` and `watch.add()` already reported a refusal — Safari private
  browsing, an exhausted quota — and both call sites discarded it. The board
  said saved, and the stops were gone on the next load with nothing on screen
  having suggested otherwise.
- The refresh timer forced a route's status back to idle even while its fetch
  was still in flight, firing a second request alongside the first — on a slow
  connection, which is exactly when it mattered.
- Opening a kept stops link a second time landed on the route board: the view
  switch hung off the unanswered offer rather than off the link. Removing a stop
  also left the old fragment in the address bar, so a reload restored it. The
  same applies to pasting a link into a tab that is already open, which is the
  commonest way a link gets used and went through a different code path.
- **A failed route fetch could delete a good schedule.** Falling back to the
  bundled fixture made its frozen `20260819` read as today, so every cached
  departures document looked expired and was dropped -- on a connection that had
  just proved it could not fetch a replacement, and on route 4, which is the
  default and the only bundled route. The fixture is no longer treated as a
  statement about today, and a document is now swapped out only when its
  replacement has actually arrived rather than deleted before the request.
- **A cancelled inbound leg was named as the bus bringing a turnaround departure
  in**, with "no bus is reporting on that trip yet" -- the sentence that means
  "it has not started" used for "it is never running". That is the confusion
  cancellations were surfaced to remove, on the one card where the inbound leg is
  the only evidence a bus is coming at all. It reads the same cached/live union
  `watch.isCanceled()` gives every other surface, so a cancellation announced
  after the page loaded reaches it too.
- **The screen-reader summary announced only the cancellation** when the soonest
  departure on a card was cancelled, hiding the buses that were still running.
  It now mirrors the card.
- Two more bare object lookups reachable from a link: a window name resolving
  through `Object.prototype` rendered `NaN:NaNp-NaN:NaNp` permanently, and a
  prototype-named route id was dropped from the preload and the refresh while
  paint went on fetching it.

## [0.4.0.2] - 2026-08-20

### Fixed

- **A cancellation announced after the page loaded never reached the board.**
  0.4.0.0 shipped `canceled` on each trip in `api/departures/{route}.json`, but
  contract §16 declares that document free of realtime fields precisely so it
  can be cached to the end of the service day, and the client fetches it once
  per session and keeps it. So the feature worked when you opened the page
  *after* the cancellation published, and not when you left it open -- which is
  how somebody waiting at a stop actually uses it. A trip canceled at 10:05 for
  a 10:13 departure could not reach a tab opened at 07:00. The stop board and
  saved trips now take the union of the cached `trips[].canceled` and the live
  `schedule.canceled_trips`, and §16 says so instead of claiming the document
  carries nothing realtime.

- **`schedule.canceled_trips` was empty on every route from the day it shipped.**
  `cm_build_schedule()` built the map of canceled trip ids into `$canceled`, and
  the trip loop below it then assigned a per-trip boolean to the same variable
  name. `isset()` on a bool returns false for every key, so the published list
  was always `[]`. Nothing caught it: no error, no warning, and the schema only
  requires the field to exist, so a plausible empty array validated cleanly. It
  surfaced only by comparing the two carriers over real generated output -- 100
  cancellations in the feed, 100 in the departures documents, 0 in
  `canceled_trips`. This is the carrier the fix above depends on, so the first
  fix was worthless without this one.
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
