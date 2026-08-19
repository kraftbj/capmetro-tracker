# Changelog

All notable changes to the CapMetro dispatch board are recorded here.
Versions are `MAJOR.MINOR.PATCH.MICRO`.

## [Unreleased]

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
  45-minute window the schedule uses. `/api/all.json` deliberately does not
  carry it — the fleet view does not ask the question, and it would cost that
  document about 190 KB. See api-contract.md §2.

### Fixed

- `node client/data/regenerate.js` could not run at all: it used CommonJS
  `require` in a package declaring `"type": "module"`. The bundled offline copy
  of the fixture had drifted from the golden file as a result, and is now back
  in sync.

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
