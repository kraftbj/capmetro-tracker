# Changelog

All notable changes to the Dillo Bus Board are recorded here.
Versions are `MAJOR.MINOR.PATCH.MICRO`.

## [Unreleased]

### Fixed

- **A phone left on the counter overnight answered from yesterday's schedule.**
  A departures document was fetched once and kept for the life of the tab, so a
  board opened the previous evening and picked up at breakfast was still reading
  the previous service day: saved trips reporting "the last one today has gone",
  or times belonging to a day that had ended, on the surface someone consults
  while deciding whether to drive.

  A document is now kept for the service day it describes. The live route payload
  refreshes every 60 seconds and carries the current service date, so it — never
  a device clock — is what says the schedule has expired. Two details are load
  bearing and each is asserted directly. The comparison is **older**, not merely
  different: `!==` also condemns a document from the future, which is what a tab
  holds for a few seconds either side of the service-day roll, and re-fetching it
  once a minute until the live payload catches up. And the current date is never
  read off the bundled fixture, a frozen capture that would otherwise let one
  failed request declare every genuinely current schedule expired.

  Keeping an out-of-date document and answering from one are separate decisions,
  and only the first was safe to make. Every render path goes through a single
  accessor that hands back nothing when the schedule describes a service day that
  has ended, so the board falls to its existing "schedule has not loaded" state
  rather than reading yesterday's times out under today's heading. The first
  version of this change marked the document and did not do this, which left the
  original bug intact in the branch where the replacement has not arrived.

  The roll is acted on as soon as the live payload carrying it lands. The refresh
  timer sweeps schedules synchronously, so the sweep judges against the service
  date from before that tick's payload arrived; without a re-check when the
  payload resolves, a roll stayed invisible for a further full minute.

  An expired document is kept and re-requested rather than deleted first.
  Deleting is only safe when the fetch cannot fail, and this one demonstrably
  can — taking a correct schedule with it and leaving "Schedule not loaded" where
  a minute earlier there was a whole service day. The replacement is swapped in
  once it has arrived, and until then the document is marked `stale`: kept, but
  not believed, and not re-requested on every repaint.

- **A stop id from a link could blank the whole board.** `departures[stopId]` was
  a bare lookup on an object parsed from JSON, so it also reached
  `Object.prototype`. `?stop=constructor` returned the Object function — truthy,
  so the `|| []` fallback never fired, with a `length` of 1 and nothing at `[0]`.
  The next line read `rows[0][1]` and threw, and because that happened during
  render the page went blank rather than showing an empty stop. `app.js` takes
  `state.stopId` straight off the query string, so this was reachable by anyone
  who could send a URL. Guarded once, at the single lookup every reader goes
  through, rather than in whichever caller happens to hold an untrusted id.

- **The board said "Saved" when nothing had been saved.** `watch.add()` discarded
  what `writeStore` already told it, so a write refused by Safari private
  browsing, an exhausted quota, or storage switched off was announced as a
  success. The trip was not in the list, and on the next load it was gone
  entirely, with nothing having said so. `add()` now reports whether the store
  took it, and the saved view says so in words — the announcement alone goes to a
  screen-reader-only region and leaves a sighted reader with no sign at all.

- **Every northbound bus said its next run was another northbound one.** Spotted
  on route 837, where all seven live buses claimed a continuation 2.5 hours out
  on a route that runs every fifteen minutes — the bus obviously runs the return
  leg first. Measured over the whole feed, **92,418 of 539,513 published
  continuations named the wrong successor: 17.1%.** It is now 4.

  A `service_id` in this feed is not a service day. `calendar_dates` puts several
  on one date, and CapMetro splits a physical block across them **by direction**:
  block 837001 keeps its northbound trips under `9-172` and its southbound trips
  under `5-172`, and both run on a Friday. The build chained a block per
  `service_id`, so it saw half of one and linked each trip to the next in the
  same direction, skipping the return leg in between. Chains are now keyed on the
  set of services co-active on a date.

  The error was reporting itself and we read it as something else. Skipping the
  return leg inflates the gap the handoff is graded on, so the wrong successors
  came out `low` for `layover_too_long` and `stops_too_far_apart` — 88 minutes
  and 12 km for the 837 case, against a true handoff of 32 minutes and 0 metres.
  Correcting it drops `stops_too_far_apart` by 90% (3,809 to 395) and
  `layover_too_long` by 82% (3,724 to 686), and moves 2,791 continuations from
  `low` to `high`. **Any earlier reading of the grade-reason distribution was
  measuring this bug rather than real interlining.**

  The successor's facts do not vary by date but its identifier does: of 865 trips
  in more than one co-active set, none disagree on the successor's direction or
  start time and 781 differ only in `trip_id`, because CapMetro mints one id per
  service variant. The shard now carries `next_trip.trip_id_by_service` and the
  runtime resolves it against the day's services; the API payload is unchanged,
  so no client needed touching. Four trips genuinely chain differently by date —
  the build warns about those rather than silently picking one.

### Added

- **Nearest stop, and when the next bus reaches it.** Tap "Use my location" and
  the board finds the stop you are standing at on the route you are looking at,
  then shows when each approaching bus is due there — "4 min", "due" — with the
  matching vehicle row marked. It uses the browser's own location and nothing
  else: no map service, no key, and no request of any kind. Your position is
  used in the page and thrown away; it is never sent anywhere and, unlike the
  saved route, never written to storage. The prompt only ever appears when you
  press the button.

  Every time shown is the agency's own prediction for that stop. The board does
  not estimate: when the feed is too far behind to stand behind a number, the
  panel says so instead of counting down. And it never guesses which stop you
  are at — if your location is too coarse to tell two stops apart, it says that
  too.

### Changed

- `Vehicle.predictions` added to `/api/route/{id}.json`: the arrival times the
  agency already publishes for every stop still ahead of a bus, within the same
  45-minute window the schedule uses. Nothing is published for a cancelled trip
  or for a stop the bus has already passed. Costs 104 KB across all 71 route
  files; route 4 goes from 16 KB to 17 KB. `/api/all.json` deliberately does not
  carry it — the fleet view does not ask the question, and it would take that
  document from 317 KB to 422 KB. See api-contract.md §2.
- **The Next buses panel now uses the agency's own arrival times** where it has
  them, instead of adding a bus's current lateness to the scheduled time. That
  shortcut assumes a bus stays exactly as late as it is now all the way down the
  line; measured against the real feed it is off by more than a minute on 64% of
  stops and by more than two minutes on 41%. Where the agency publishes no
  prediction — mostly buses that have not started their trip yet — the previous
  estimate is still used, because it is the only answer there is.

  A row that takes its time from the agency now drops the lateness badge and
  prints the scheduled time instead, so the arrival and the schedule beside it
  always subtract correctly. The bus's overall state is still there in words —
  "bus 8012 · running very late" — which stays true whether or not the bus makes
  up time before it reaches you.

### Fixed

- `node client/data/regenerate.js` could not run at all: it used CommonJS
  `require` in a package declaring `"type": "module"`. The bundled offline copy
  of the fixture had drifted from the golden file as a result, and is now back
  in sync.

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
