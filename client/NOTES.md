# client/ — notes, and things other agents need to know

I own `client/` only. Everything below that touches `build/`, `runtime/`, `tests/`,
`schemas/`, `docs/` or `.github/` is written here rather than changed there.

---

## How to run it

Open `client/index.html` from disk. No server, no build step, no install.

It loads the committed golden fixture through `client/data/route-4-20260819.js`, a
verbatim generated copy of `tests/fixtures/golden/route-4-20260819.json`. The copy
exists because `fetch()` is blocked for `file://` URLs and being openable from disk
is a requirement. Regenerate it with:

```
node client/data/regenerate.js
```

Served over HTTP next to a webroot containing `api/route/{id}.json`, the client
fetches the live file first and only falls back to the bundled fixture, showing a
"Sample data" banner whenever the fallback is what you are looking at.

### State harness

Every row of the design doc's interaction-state table can be forced from the URL,
because a state table that cannot be looked at does not get verified:

| URL | What it shows |
|---|---|
| `?state=loading` | Skeletons; the payload never resolves |
| `?state=empty` | No vehicles — the non-blank empty state |
| `?state=error` | Feed unreachable, retry offered, panels explain themselves |
| `?state=partial` | Some buses have positions but no prediction |
| `?state=stale` | `suppress_adherence: true` — no lateness value anywhere |
| `?state=dead` | Feed down over an hour |
| `?state=schema` | `schema: 2` — the app refuses to render |
| `?state=first-run` | Route picker with the six watched routes |
| `?state=no-timepoints` | Ladder with no timepoint list for either direction |
| `?state=all-states` | Synthetic adherence covering all six states (grayscale check) |
| `?state=ladder-probe` | Synthetic 8+9 timepoint route: the BOTH-mode layout ruler |
| `?view=trip` | The trip view; add `&bus=2641` to follow a specific bus |
| `?view=trip&bus=2641&state=trip-gone` | The followed bus has left the feed — dimmed list, last-seen time |
| `?view=trip&bus=2641&state=trip-no-anchor` | No anchor: whole trip listed, no arrival times |
| `?view=trip&bus=2641&state=trip-canceled` | Canceled trip: scheduled times only |
| `?view=trip&bus=2641&state=trip-estimated` | Synthetic: half the feed predictions removed, so the feed/estimate divider and `~`/"estimated" markers actually render. The bundled fixture gives every in-service vehicle full feed coverage on its own, so without this the estimate branch — this feature's whole honesty mechanism — cannot be seen or tested at all. |

Also `?route=4` and `?dir=0|1|both`, and `?view=board|stops|all|saved`. The last
route, direction and view persist in `localStorage`.

There is no `?state=` scenario for the stops view, and there cannot be a useful
one yet: a stop card needs `api/departures/{route}.json`, the scenarios rewrite
the bundled route fixture, and no departures document is bundled. The view is
covered end to end instead, in `tests/e2e/stops.spec.mjs`, against fixtures the
e2e server serves over HTTP.

### Shareable URLs

Served over HTTP the board also answers to paths, so a link can be read out loud:

| Path | What it opens |
|---|---|
| `/route/4/eb` | The board, route 4, eastbound. Also `wb`, `nb`, `sb`, `both`, `0`, `1` |
| `/buses` | Every bus in the system |
| `/trip/1234` | The trip view following bus 1234 |
| `/trip/7/1234` | The same, with the route named |
| `/saved` | Saved trips |

Four things about this are load-bearing rather than incidental.

**The query form is permanent.** `?view=`, `?route=`, `?dir=`, `?bus=` and the
whole `?state=` harness above keep working, and are the ONLY form used from
`file://`, where a path means nothing and the History API refuses on an opaque
origin. A path is read first and the query then overrides it field by field, so
a pretty URL and a forced interaction state can be combined — which is the only
way to look at a state on a path.

**Direction tokens are per-route.** `eb` is direction 0 on the 4 and means
nothing on the 7, so a token cannot become a `direction_id` until that route's
document has loaded and its headsigns are known. It resolves during load,
before the first meaningful paint. A route that does not run the direction asked
for keeps the saved one rather than retrying forever.

**Every fetch hangs off a derived base, never a hardcoded `/api/`.** The client
fetches relative to the page, so `api/route/4.json` read from `/trip/1234` asks
for `/trip/api/route/4.json`. `urls.baseFor()` strips a recognised app path to
get the directory the board is served from. Hardcoding `/api/` would break every
browser test in this repo, because `tests/e2e/server.mjs` serves the whole client
under a scenario prefix.

**The `<base>` bootstrap in `index.html` is not optional, and the CSP has to
admit it.** Same problem, one layer earlier: a relative `<script
src="format.js">` read from `/route/4/eb` resolves to `/route/4/format.js`,
which no server answers with the script. nginx matches it against `location ~*
\.(js|css)$`, declared before the app-path fallback, and 404s; the e2e fixture
server has no such ordering and returns the page's own HTML. Either way the
board renders nothing, with no console error saying why.

The bootstrap is the one inline script in this client, and the vhosts admit it
by **sha256 hash** rather than by adding `'unsafe-inline'`, which would readmit
every injected inline script on an origin whose whole defence is having none.
`base-uri` is `'self'` rather than `'none'` for the same reason: `'none'` makes
every `<base>` inert however it is inserted, including one built with
`createElement`. Both are pinned by `tests/node/deploy-vhost-headers.test.mjs`,
which recomputes the hash from `index.html` on every run — edit the snippet
without updating the config and the suite goes red instead of the board going
blank on the box. The e2e fixture server serves the real policy, parsed from the
vhost, so the browser tests would fail too. The inline snippet must stay first in
`<head>`, because an external script would need the same base in order to load.
It states the same rule `urls.baseFor()` does and the two must agree;
`tests/e2e/urls.spec.mjs` covers it by loading the board at depth and asserting
`window.CMB` exists.

`/saved` carries nothing but the tab name. Saved trips live in `localStorage`,
and a watch in a URL would publish somebody's routine to whoever they were sent
the link by.

The address bar is written with `replaceState`, never `pushState`, so Back
leaves the site exactly as it did before any of this existed. A bare
`/trip/1234` upgrades itself to `/trip/{route}/{bus}` once the fleet document
names the route, so the link that gets copied onward is the one that needs no
extra fetch.

### What the real nginx actually does

Run against the rendered vhost in a throwaway container, because the fixture
server is a different program and this is the seam where the two disagree:

| Path | | |
|---|---|---|
| `/route/4/eb`, `/buses`, `/trip/1234`, `/saved` | 200 | the board |
| `/route/4/eb/` | 200 | a trailing slash is fine |
| `/routeXYZ` | 404 | the `(/|$)` in the regex is doing its job |
| `/route/4/format.js` | **404** | `location ~* \.(js|css)$` is declared first and has no `try_files` — this is why the `<base>` bootstrap exists, and why the failure has no console error |
| `/route/4/.env`, `/trip/x.log` | **403** | 200 before the deny blocks were moved above the asset and app-path locations |
| `/saved/../../etc/passwd`, `%00` | 400 | nginx rejects before any location matches |
| `/route/4/%2e%2e/api/health.json` | 200 | normalizes inside the app path; nothing escapes |
| `/Route/4/eb` | 404 | **verbs are case-sensitive** — see below |

**Case is not normalized on the verb.** `/route/4/EB` works because direction
tokens are lowercased, but `/Route/4/eb` 404s at nginx and never reaches the
client. It fails honestly rather than rendering something wrong, and links are
pasted rather than typed, so this is recorded rather than fixed. Making it
case-insensitive means `~*` in both vhosts AND lowercasing the verb in
`urls.split()` — one without the other is worse than neither.

**This needs a vhost change to work in production.** `deploy/nginx-capmetro.conf`
gains a fallback for the four app verbs. `update.sh` does not install vhosts —
deliberately — so until it is installed by hand and nginx reloaded, path links
404 while `/` and every `?query=` link keep working.

The `all-states` and `ladder-probe` scenarios rewrite the fixture and are labelled
on screen as synthetic. They are instruments, not data — nothing in the shipped
board invents a value.

---

## The stops link (`#plan=`)

The fourth view. A **saved trip** is one named departure — "the 7:50a 800 SB from
Simond/Berkman". A **stop** is a place and a time of day — "the 4 eastbound from
Campbell/5th in the afternoons" — and it resolves to the next few departures,
because which of the afternoon's buses gets caught is decided on the day.

### The grammar

```
https://bus.dillo.dev/#plan=1;800.1.6293.am;4.0.3337.am;4.1.6243.pm
                            │ └───────────┘
                            │  route . direction . stop . window
                            └ format version
```

`direction` is the GTFS `direction_id`, `0` or `1` — not a compass letter, since
which of the two is northbound is a property of the route. `window` is `am`
(04:00–12:00), `pm` (12:00–20:00), `all`, or an explicit `HHMM-HHMM` whose end may
run past midnight (`2200-0200` is 22:00 to 26:00 in service-day seconds, the same
convention every other clock in this contract uses). It is optional and defaults
to `all`.

A window decides which SECTION a stop lands in, never whether it is on the page.
An afternoon stop at seven in the morning sits under "Later today" with its next
departure printed, because "where did my stop go" is a worse question than "why is
that one greyed out".

Malformed entries are dropped and the rest still open. A plan is not a
transaction; if four of five stops parse, the reader is standing at one of the
four.

### Why the fragment, and not the query — and what that does not buy

Contract §9 hashes the watch tuple for one stated reason: *"so a URL or server log
never carries a legible description of a child's daily routine."* A feature whose
whole point is a URL has to answer that rather than inherit it.

The fragment answers the half about **passive** leakage. Browsers do not send it,
so `bus.dillo.dev`'s access log sees `GET /` however many stops the link carries,
and it does not ride along in a `Referer` header either. `index.html` declares
`referrer: no-referrer` as well as the vhost doing so, because the board is also
meant to open from disk, where no vhost applies.

**It is not the guarantee the hash gives, and an earlier draft of this file said it
was.** The sha256 in §9 is one-way: no decoder exists, only guess-and-check against
a stop you already suspect. This encoding is reversible and *this application is
the decoder* — paste a link into the board and the stops are on screen, named, with
times. No stop table needed, and stop ids are public GTFS besides. The true claim,
which is still worth having:

> The server never learns which stops a link carries. Anyone the link is *given* to
> can open it and read them, which is the entire point of sharing it.

A link somebody chose to send is a different thing from a URL that leaks into logs
and referrers by itself, and only the second is what §9 is about.

One thing the fragment does not hide: opening a plan immediately fetches that
plan's **routes**, so the access log does learn the route set — just not the stops,
the directions or the times.

A `?plan=` query is still accepted, because a link that has been through three
messaging apps can arrive in any shape — and is rewritten into the fragment via
`replaceState` before any fetch goes out, with the banner saying so. That does not
un-send the request that already reached the server; it stops the leak repeating on
reload and on the next share.

### What a link may carry

At most 12 entries across at most 6 routes, and the rest of the fragment is
dropped. Every surviving entry becomes a route whose schedule and live payload are
fetched, and the refresh timer re-runs the set every 60 seconds; a fragment with a
few hundred entries is a few hundred requests a minute from one phone, and a wedged
board with the fan on is indistinguishable from the app being broken. The commute
this shipped for has five entries on three routes.

A link is also the first untrusted string this codebase feeds into paths that only
ever saw internal state. `departures['constructor']` on a plain object returns the
`Object` function — truthy, so an `|| []` fallback never fires, with a `.length` of
1 and nothing at `[0]` — and the next read threw during render, blanking the board.
Guarded once in `watch.rowsFor()`, which every caller goes through, and the
route-keyed caches in `app.js` are `Object.create(null)`.

The same string reaches the ROUTE field, where it becomes a request path. That one
did not blank the board; it killed the e2e fixture server, which looked its route
ids up in a bare object and then handed `path.join()` a function. An uncaught throw
in a request handler ends the process, so one hostile link took the server down and
every test scheduled after it failed for reasons of its own. Guarded there too, with
a `try`/`catch` behind it so the next one is a 500 on one request rather than an
invisible cause for a whole run.

### A second link, and what it must not do to the first

Keeping is an ADD, never a replace. The case is a parent with one child's stops kept
who opens the other child's link: `save()` overwrites, so the obvious button threw
the first set away with no warning and no way back but the original link. `merge()`
puts the existing entries first, so if a cap bites it bites on what is arriving —
and returns what it dropped rather than swallowing it, because 12 entries across 6
routes is a limit somebody can actually reach with two children. The offer says
which case it is in: "This phone already keeps 3 stops", and the button reads "Add
to this phone".

A decline is about a SET OF STOPS, not about a page load. `adoptPlan()` rebuilds the
offer from the link and storage every time it runs, and anything that sends the
reader through it a second time — a detour to another link and Back is the ordinary
way — used to put the offer they had just dismissed back on screen. Asking twice is
how a board teaches somebody to stop reading it.

And a fragment carrying no plan is not about this view at all, so nothing reacts to
it. Rebuilding the plan whenever the board had been opened from a link meant an
in-page anchor, or a Back onto the URL as it was before the link, replaced the stops
on screen with "No stops on this phone yet".

### Turnarounds, which are the reason this is not a list of times

Three of the five stops this was built for are turnaround points: route 4 eastbound
starts at Campbell/5th and at Veterans/Atlanta, route 837 northbound starts at
Republic Square. **There is no eastbound bus approaching Campbell/5th, ever.** The
bus that answers the question is westbound until it gets there, turns its headsign
round and leaves as the eastbound trip. A board that looks for an approaching
eastbound vehicle shows a scheduled time and no bus — the exact blank the design
doc calls the failure this project exists to avoid.

Three published facts answer it, and the card says which one it is using:

| What is known | The card says |
|---|---|
| The trip is cancelled | "CANCELED · CapMetro has canceled this trip. No bus is coming for it." |
| A vehicle is on the outbound trip and `STOPPED_AT` the stop | "Bus 2867 is at the stop now." |
| A vehicle is on the inbound leg and `STOPPED_AT` the stop | "Bus 2867 is standing at this stop now, in on the 3:04p WB, and goes back out as this trip." |
| A vehicle is running the inbound leg elsewhere | "Bus 2867 brings it in on the 3:04p WB — due here in 4 minutes, running 35 seconds late." |
| The inbound leg itself is canceled, and nothing is reporting | "The 3:04p WB that would bring this bus in is canceled, and nothing in the schedule says what runs this trip instead." |
| The inbound leg is canceled but a bus is reporting on it anyway | "Bus 2867 is standing at this stop now, and goes back out as this trip. The 3:04p WB it was scheduled to come in on is canceled." |
| Only the schedule knows | "Comes in on the 3:04p WB. No bus is reporting on that trip yet." |

**Live evidence is read before the cancellation, not after it.** The last two rows
are the same schedule fact and they read very differently, because a bus you can
see out of the window settles the question and a withdrawn leg does not. The
ladder in `decorate()` therefore asks what is reporting — `at_stop`, then any
vehicle at all — before it asks what was planned, and the cancellation comes back
as a trailing clause rather than the whole sentence. Both facts get said; neither
gets to delete the other. Ordering these the other way round told a reader nothing
was coming for a trip whose bus was idling in front of them, which is the failure
this board exists to prevent, inverted.

**A continuation the feed has not confirmed is a likelihood, not a fact** —
contract §4, and the same hedge `rows.js` `continuationText()` makes: "Bus 8021
*likely* brings it in on the 10:20a SB". The word is on every line; what it means
is said once per card, because three identical caveats in a row bury the times the
card exists to show. That is not an edge case here. Every route 837 block in the
2026-08-19 capture is `confidence: low`, so it is the ordinary reading on one of
the three turnarounds this shipped for, and it matters more on this card than on
the rows band — the whole point of a turnaround card is answering "is a bus
actually coming for me" at a stop where none is visible, which is exactly where a
false certainty costs somebody a wait in the dark.

**Cancellations, ranking and the grace window are `stopboard.js`'s**, not restated
here: `plan.js` calls `stopboard.upcoming()` and decorates each departure with the
turnaround facts. So a departure is upcoming when its *predicted* arrival is still
ahead, a cancelled one is listed and does not consume one of the three slots, and a
cancelled trip gets no continuation reasoning at all — "Bus 8021 brings it in"
printed beside CANCELED is the contradiction this board exists to avoid. Those
rules were paid for once, when a kid waited for a bus that was never coming.

The inbound leg gets the same check. "Comes in on the 3:04p WB. No bus is
reporting on that trip yet" means *it has not started*, and using it for *it is
never running* is the confusion cancellations exist to remove — worst here, since
the inbound leg is the only evidence a bus is coming at a stop where none is
visible. The whole-block case never reaches that code (the outbound is cancelled
too, and `decorate()` returns first), so what it covers is one leg of a block
called off on its own. The real capture only cancels whole blocks, so the test
edits a fixture rather than pretending the case is in the data.

**The screen-reader summary mirrors the card, not just its first row.** The card
lists a cancellation and then the buses still running; taking only the first entry
meant that when the soonest departure was cancelled a screen-reader user heard
"cancelled" and nothing else — the half of the message that sends someone home.

### A cancellation announced after the page loaded

`trip.canceled` rides the departures document, which is cached for the service day
it describes, so on its own it cannot carry a cancellation announced since the tab
was opened. `watch.isCanceled()` (0.4.0.2) takes the union of that and the live
`route.schedule.canceled_trips`, which is rebuilt every 60 seconds.

Both paths on this view go through it: the outbound departures via
`stopboard.upcoming()`, and the inbound leg via `legCanceled()`. The second is easy
to miss — the leg is looked up in the cached document, so reading `trip.canceled`
off it directly would have been the natural thing to write and would have left
exactly the hole 0.4.0.2 closed, on the one card where the inbound leg is the only
evidence a bus is coming.

The live half comes from `vehicle.block.next_trip` (§2), the server's own block
continuity with `is_direction_flip` already computed, falling back to the vehicle
running the scheduled inbound leg — route 837 publishes `next_trip` without ever
setting `is_direction_flip`, so that flag is read as extra information and never as
a gate. The scheduled half comes from `departures.trips[].block_id`: the latest
arrival at this stop, on the same block, in the other direction. Block continuity
is the only honest link. Two trips sharing a stop and a plausible gap is a guess;
two trips sharing a `block_id` is the agency saying one vehicle runs both.

Whether a stop is a turnaround is **detected, never encoded in the link** — a
departure is compared against its own trip's published `start_time`, so a schedule
change three times a year cannot leave a hand-written flag lying about the
geometry. It is also compared against `start_time` rather than a `stop_sequence`
of 1, because sequence numbers belong to whichever pattern a trip runs and route 4
publishes six patterns in one direction.

### What is deliberately not computed

When the inbound bus is nine minutes late, the outbound departure it becomes will
almost certainly leave late too. The board does not print that number. Both facts
are shown next to each other and the subtraction — which is one subtraction — is
left to a reader who can see where it came from. A predicted departure derived from
another trip's lateness is an invention with a plausible face, and nothing on this
board invents a value.

### Verified

Rendered at 412×915 against **real generated output** (`.local/test-webroot` from
`runtime/generate-api.php` over the committed shards), not the golden fixture,
because CLAUDE.md says so and because the fixture is route 4 only.

- All five stops resolve. Campbell/5th, Veterans/Atlanta and Republic Square are
  detected as turnarounds; Simond SB and 7th/Pleasant Valley are not.
- The inbound sentence names a real bus, a real leg and a real lateness on all
  three turnarounds: "Bus 2867 brings it in on the 10:14a WB — due here in 4
  minutes, running 35 seconds late."
- No horizontal overflow at 412px; no console errors.
- From a `file://` URL the cards say the schedule is fetched rather than bundled
  and that this view needs the board served — not "loading", which would be a lie
  with a spinner attached.
- The cancelled 10:13 northbound at Republic Square renders as CANCELED with no
  bus attributed to it, and does not displace a running departure from the three.

Not verified on real hardware.

---

## Gaps in the API contract that the design spec depends on

These are the ones that changed what I could build. Each is a request to whoever
owns `docs/api-contract.md`, `schemas/` and the build job.

**1. There is no next-departure field, and the empty state is specified to need one.**
The design doc is explicit that `"No buses on route 350 right now."` alone is the
failure being designed against, and that the line must continue
`"Next departure 2:14pm from Airport/12th."` The route-state payload carries no
scheduled departure for a route with no live vehicles, so the client currently says
so in plain words instead of inventing one. Suggested addition to §1:

```jsonc
"next_departure": {            // null when the service day is over
  "scheduled_at": 1787169240,
  "stop_id": "1368",
  "stop_name": "Pleasant Valley/5th",
  "direction_id": 0,
  "headsign": "4 Mopac WB"
}
```

The client already reads `route.next_departure` defensively and will use it the
moment it appears — no client change needed beyond deleting the fallback sentence.

**2. The golden fixture has timepoints for direction 0 only.**
`route-4-20260819.json` carries three timepoints, all `direction_id: 0`. Two of the
five in-service vehicles are `direction_id: 1` and the design table lists route 4 as
3 timepoints per direction. The client renders an explicit "No timepoints published
for 4 Shady EB" state rather than an empty box, but this looks like a generator bug
or a truncated fixture rather than reality. Worth checking before the ladder is
judged on it.

**3. There are no scheduled times per timepoint, so a time-axis string-line is not
possible from this payload.** The sketch's horizontal axis is clock time; the
payload has clock times only for `adherence.against` (one stop per vehicle). What I
built instead: y is route position (interpolated stop sequence) and **x is signed
schedule deviation**, early left, late right, ±10 min full scale. A healthy route is
a column of dots hugging the spine, which answers the same question. If a true
time-axis string-line is wanted, the contract needs scheduled arrival times per
timepoint per trip — that is a much larger payload and I would question it before
adding it.

**4. `alerts[].stop_ids` contains duplicates.** All three alerts in the fixture
repeat their stop id (`["940","940"]`). Harmless here, but it will double-count if
anything ever groups by stop.

**5. Stop-name shortening (task D8) has a capitalisation artefact.** `"8Th/Lavaca"`
in the fixture. Rule 3 of §7 standardises directional suffixes but nothing
normalises an intercapped ordinal. Cosmetic, build-side.

**6. Not built, and out of the four-panel hierarchy I was given:** the watchlist
(`/api/watch/{id}.json`, §9) and the all-buses view (`/api/all.json`, §8). The
design doc's state table has rows for both. They need their own panels and a
saved-watch creation gesture, which the design doc itself still lists as an
unresolved decision.

---

## Nearest stop / "when is my bus here" (`near.js`)

Answers a rider's question rather than a dispatcher's: which bus is coming to the
stop I am standing at, and when. Uses `navigator.geolocation` and nothing else —
no tile server, no geocoder, no key, no network call.

- **The fix never leaves the browser and is never stored.** Not sent, not logged,
  and deliberately not in `localStorage` next to the saved route and direction.
  A saved route is a preference; a saved position is a record of where somebody
  was. The permission prompt is only ever raised by tapping the button.
- **It does not measure the distance to a bus.** That number is wrong in a way
  that looks right: the nearest bus by metres is routinely one on the parallel
  street going the other way. Instead the USER is snapped to a stop, and
  `Vehicle.predictions` says which buses still have that stop ahead of them —
  presence in that list IS "approaching", so there is no distance derivative to
  get wrong. `bearing` could not have helped either: 208 of 392 vehicles in the
  capture do not report one.
- **Stops are matched by `stop_id`, never `stop_sequence`**, because route 4 runs
  a 17-stop baseline on five services and a 19-stop one on three others.
- **Every time shown is the agency's own `predicted_at`.** Nothing here adds a
  deviation to a scheduled time or divides a distance by a speed, and the
  countdown is measured against `generated_at` like every other age on the board.
  When the feed is stale the server sends an empty list and the panel says why,
  because a countdown is the number a rider acts on fastest.
- **It renders in the banner slot above the rows, not as a fourth panel.** The
  rows/ladder/map order is settled; this is a stated answer in the slot the
  staleness banners already use. The vehicle rows get a marker, not a re-sort —
  promoting "your" bus above a very late one would defeat the sort.
- **Verified on `file://`** (the board must open from disk). Measured, not
  assumed: Chromium reports `isSecureContext: true` there and exposes
  `navigator.geolocation`, so the common claim that `file://` is not a secure
  context does not hold for it. The panel gates on `isSecureContext` itself
  rather than on the protocol, so a browser where it IS false says "this page
  cannot ask" instead of blaming the reader. What the harness cannot show is a
  real permission *prompt* on an opaque `file://` origin, since headless has no
  prompt UI; a browser that refuses to grant one reports the same code 1 a
  person tapping Block does, so that message names both possibilities rather
  than picking one. Still worth ten minutes in a real browser opened from disk.
- **The arrival time is NOT shared with the stop board, and that is deliberate.**
  The two panels sound like they ask one question and do not. This panel asks
  "when is this bus next here", where the soonest occurrence is the answer even
  on the 234 trips that visit a stop twice — so it reads `fmt.predictionFor()`,
  which matches on `stop_id` and returns exactly that. The stop board asks about
  one scheduled departure, and a loop trip has two of them at the same stop, so
  it joins positionally instead (see its `feedArrivalFor()`). Asking
  `predictionFor()` the stop board's question is what made both rows print the
  first pass's time; six rendered rows carried the wrong arrival, the worst by
  51 minutes.
  stopboard.js used to add the bus's current lateness to the scheduled time,
  which assumes the deviation measured at whatever stop the bus is approaching
  still holds by the time it reaches yours — across the corpus the two disagree
  by over a minute on 64% of comparable pairs and by up to 53 minutes. It keeps
  that estimate as a fallback, because predictions only cover stops ahead of a
  bus inside the 45-minute window (4,528 of 9,865 departures); the rest are
  buses that have not started yet.

  **A stop board row shows its lateness badge only when the badge and the time
  are the same computation.** Making the time more accurate broke the identity
  that used to hold — the row prints an arrival, a scheduled time and a badge,
  so a reader can subtract, and 1,438 of 4,205 rendered rows would have been
  off by more than two minutes with 325 pointing opposite ways. On a
  feed-sourced row the badge, the state colour and the signed number go; the
  scheduled time is printed always instead, since it becomes the only thing
  saying how late the bus is *here*. The bus's overall state survives as a
  phrase — "running very late" — because a word can carry the scope a bare
  number cannot: a bus eleven minutes late at its anchor that reaches this stop
  five minutes late is the feed modelling recovery, not a contradiction.

Gap 3 above is now partly closed: `Vehicle.predictions` gives per-stop predicted
times, so a rider-facing arrival time no longer has to be invented. A true
time-axis string-line would still need scheduled times per timepoint per trip.

---

## Trip view: "I'm on this bus. Where does it go from here?" (`trip.js`)

Every other panel is anchored at a stop or a route: pick a place, see which
buses pass it. This one is anchored at a bus: pick a vehicle, see every stop it
still has ahead of it on its current trip, with a scheduled time and an
arrival time beside it. It is the transpose of `stopboard.js`, not a
variation on it.

- **Stop order comes from `arrival_seconds`, never from `stops[].stop_sequence`.**
  The two are different numbering schemes and they disagree on **2,221 of the
  corpus's 4,112 trips**. `stops[].stop_sequence` is the order the greatest
  number of trips happen to agree on, not the order any one trip runs in;
  ordering a trip's own stop list by it would draw stops out of the order the
  bus actually visits them.
- **Predictions are consumed positionally, with a forward-only cursor, never
  by looking up `stop_id`.** `fmt.predictionFor()` matches on `stop_id` alone
  and returns the SOONEST occurrence, and **234 trips visit one stop twice**.
  That is the right answer for `near.js` — a rider standing there wants the
  next arrival — and the wrong one for anything asking about a specific
  scheduled departure. `arrivalPlan()` walks `vehicle.predictions` in order and
  never rewinds, so the two passes of a repeat-stop trip land on their own
  occasions. `stopboard.js` was fixed to join through this same path rather
  than by `stop_id`; `near.js` still calls `predictionFor()` on purpose.
- **Past the last stop the feed predicts, the deviation last seen from the
  feed is carried forward and held flat**, rather than recomputed from the
  bus's current anchor the way `stopboard.js` does. The two rules are not a
  rounding of each other: across the corpus they disagree by more than a
  minute on **76.5% of estimated stops, and by up to 15 minutes**. Carrying
  forward keeps whatever dwell and recovery the feed's own predictions already
  modelled as far as they go; the anchor rule discards that and assumes the
  bus's lateness right now holds unchanged for the rest of the trip. **Neither
  rule has been measured against ground truth** — no capture in this repo
  records what a bus actually did after the feed stopped predicting it, so
  this is a structural argument, not a measured one, and it should not be
  written up as though it were. The feed/estimate divider and the `~` marker
  exist because of this: a reader should be able to tell CapMetro's own number
  from the board's projection at a glance, not just trust that it is right.
- **A bus that leaves the feed keeps its last answer on screen, dimmed, with a
  last-seen time — the list is not cleared.** The feed can drop a bus for a
  trip genuinely ending, a vehicle going out of service, or one missed poll,
  and those look identical from here. Taking the stop list away the moment
  that happens erases the one thing a rider was mid-read on; showing it dimmed
  says plainly what is known and that it is no longer current, instead of
  either lying that it still is or leaving a blank screen.

---

## Decisions I made that reviewers should check

- **The badge sits in the leftmost column, not after the vehicle id.** The approved
  sketch orders them id-then-badge. The written spec says the badge must be the
  strongest repeated object, fixed-column aligned so the eye scans one vertical
  strip. Leftmost does that better; the id moved into the first meta line where it
  is still the first thing read. If the sketch order is load-bearing, this is a
  one-line change in `rows.js`.

- **Rows sort worst-news-first** (very late, late, early, unknown, on time), then by
  trip start. A dispatch board should surface the problem, not the schedule order.
  Deadheads are always listed, in their own "not in service" group, in every
  direction filter — they have no direction, so filtering them out would make a bus
  disappear for no reason the user can see.

- **BOTH mode keeps the pitch and grows the page, rather than compressing to fit.**
  The design doc worried that route 7 stacks to 17 rows at 23.8px. Measured with
  `?state=ladder-probe` at 412px: 17 rows, **44px pitch on every row**, accordion
  buttons 47×44, ladder band 1158px tall. So the answer to "keep pitch ≥ 24px" is
  yes, at the cost of the ladder no longer fitting one screen in BOTH mode. That
  trade is deliberate: the glance the ladder exists for is the single-direction
  view, and BOTH is an explicit request for more.

- **The map is a schematic, and says so.** Real coordinates projected into the
  route's own bounding box, no basemap, labelled "Schematic · no basemap yet". A
  tile source is a network dependency and this board has to open from disk.

- **Times render in `America/Chicago`, not the device timezone.** The question is
  always what time it is on the route.

- **"Now" is `generated_at`.** The client never uses the device clock to judge
  freshness; every age comes from `staleness.oldest_feed_age_s`.

- **A transfer is a PAIR of stops within a short walk, not a shared stop id.**
  `chain.js` finds connections geometrically because on this feed the headline
  example cannot be found any other way: routes 800 and 4 share **zero** stop ids
  and meet at Pleasant Valley under two ids 27 m apart. Radius 300 m, walking pace
  1.2 m/s charged against the slack, minimum 2 minutes of slack, maximum 45 minutes
  from alighting to the onward departure, walk included. All four numbers are read off this feed rather than off a standard, and
  all four are exported so a test can assert against them instead of restating them.

- **`chain.js` uses `watch.js` rather than copying it.** Departure matching, the
  service-day clock and the trip-to-vehicle join are one rule each, and ISSUE-002 is
  what two copies of one rule cost. It is loaded after `watch.js` and throws on load
  if that is not there, rather than failing one `undefined` at a time.

- **A chain is over when the last bus is BOARDED, not when it finishes its run.**
  Nothing records where the rider gets off the final leg, so the last boarding is the
  only honest end marker. Using the trip's final stop would leave a finished chain on
  screen for another forty minutes on the 800. The cost is that the card cannot say
  "she gets in at 8:40" — see `TODOS.md`.

- **A leg the feed cannot supply a lateness for refuses the verdict, it does not
  fall back to the timetable.** Refusing to read `null` as zero is only half the
  job; the other half is where the `null` leads. The timetable always reads *on
  time*, so substituting it is never neutral — it moves the verdict optimistically
  on exactly the input that should make it cautious. There is one case where it is
  still honest, and it is the only one: **no vehicle on a live feed**, where the
  bus has not started its run and the schedule is the prior. Everything else is a
  refusal, and `unknown` is a reachable verdict. Measured: the same chain, same
  ten-minutes-late bus, graded `missed` fresh and `made` dead.

  Two ways this was got wrong, both found by review, both because the reasoning
  above was written where the code could not act on it:

  - `suppress_adherence` is a property of the **route**, and it was read inside
    `if (out.vehicle)`. The refusal therefore only fired when the frozen snapshot
    happened to contain that leg's bus. On a cron that died before the bus
    appeared, "no vehicle" and "a vehicle we have stopped hearing from" are the
    same observation and the join cannot tell them apart. Read it from
    `route.staleness`, before the join, always.
  - The refusal covered `stale_data` and none of the other unknown reasons, so a
    reporting bus with `no_trip_update` graded confidently and was called "not
    reporting yet" with its badge on the same card. The copy needs three
    sentences, not one: a bus in a dead feed's snapshot **is** on the road, a bus
    missing from one cannot be described either way, and a bus on a live feed with
    no lateness published is reporting perfectly well.

- **A refused verdict must not come back as a number somewhere else.** Three did.
  `end_at` retired the chain on `predicted_board_at`, which on an ungraded leg is
  the timetable — so the card went to "Gone. Back tomorrow" about a bus still at
  the kerb; an ungraded chain now stands down on the clock (`UNGRADED_HOLD_S`).
  The headline counted down to the same time in the largest type on the card. And
  the two times under the verdict were printed unlabeled in the slot used for real
  predictions, where they subtract to the withheld answer in the reader's head.

- **The walk is recomputed from current stop positions on every render.** Everything
  else in a chain is re-resolved from current documents; the walk was the one frozen
  value, so a cost-model change reached new chains and not saved ones. The stored
  metres survive only as a fallback for a stop with no fix, and even then the
  seconds are re-derived rather than trusted.

- **A canceled leg is never graded.** `resolveLeg()` checks `trip.canceled` before
  the vehicle join, because every check after it concludes "not reporting yet" —
  which reads as *not yet* when it means *never*, and would then grade the transfer
  against a timetable for a bus that is not running. Same order `watch.js` uses, and
  for the same reason its comment records. Transfers either side of a canceled leg
  are `void`, not graded.

- **Grading stops at the first change that cannot be made.** Everything downstream
  of a missed, broken or canceled change is `void` and says why, rather than showing
  a slack figure computed from a bus the rider will not be on. Grading each transfer
  independently printed "Connection holds" six lines under "Connection missed" on a
  three-leg chain, which is the shipped path for "337 to the 7 to the 837".

- **`TIGHT_S` is five minutes, and deliberately not `MIN_SLACK_S`.** The two used
  to be the same two minutes, on the reasoning that offering a connection and
  trusting one are the same judgment. They are not. The estimator holds the first
  leg's *currently observed* lateness constant all the way to the alighting stop,
  and for a bus twenty minutes upstream that number moves by minutes before it
  arrives — so a three-minute verdict sat inside the noise of the measurement that
  produced it and still read "Connection holds". Nothing is hidden by the higher
  threshold: those connections still appear, still print their slack, and still say
  which half of the sum is measured. They say "tight" instead. The comparison is
  `<=`, which mattered acutely while the constants were equal (a strict `<` graded
  the tightest connection the board will ever offer as comfortable) and is still
  the honest boundary. Tests assert the verdict at `MIN_SLACK_S`, at `MIN_SLACK_S
  + 1`, at `TIGHT_S` and at `TIGHT_S + 1`.

- **A verdict requires evidence; there is no default.** `gradeDecision()` is
  written as an exhaustive set of named cases with no fall-through, and that shape
  is the point. It was previously an enumeration of reasons to *refuse*, which
  means it had a default, and the default was "grade it" — so every case nobody had
  thought of graded confidently from the timetable. Four review rounds each found
  another one and each fixed it by adding a fifth refusal. The last one found was
  `route === null`, which is the state **every page load starts in**, because the
  live route map is built from payloads that have already landed and the chain
  paints before they do: the first frame of every visit printed "Connection holds"
  beside the board's own "No live data for route N" banner. Adding a case here
  means adding a branch, not discovering later that an unnamed one graded.

- **The walk is charged with a 1.4 circuity factor.** Great-circle distance is
  accurate to centimetres here and still wrong for the purpose: the straight line
  between two stops is not a path anyone walks, and Pleasant Valley is a divided
  arterial. Kept as a separate constant from `WALK_SPEED_MS` because they are
  different claims — one about the street, one about the rider — and a blended
  number would leave neither checkable. This is also what lets `WALK_RADIUS_M` stay
  at 300 m when the cited examples only cover 215: the wide pairs are offered but
  priced, at 5.8 minutes for a 300 m hop.

- **A connection's verdict is computed from predicted times, and says which halves
  are predictions.** A bus that has not started its run contributes its scheduled
  time and the card prints "the timetable, not a prediction". A lateness the feed
  will not supply is treated as absent rather than as zero, and refuses the verdict
  outright — the `adherence.view()` contract already decides when a number may be
  shown, and this reads that rather than re-deciding it.

- **The Saved view ages the payloads it holds.** `staleness` describes the feed
  when the file was generated and cannot speak for the minutes since, so a route
  fetched once and never refreshed kept saying `fresh` for the life of the tab and
  was graded with full confidence against hour-old positions. `liveRouteMap()` adds
  the time this browser has held each document to the age the server measured and
  applies the contract's own thresholds to the sum. `Date.now()` is the right clock
  for that and the wrong one almost anywhere else here: it subtracts two readings of
  the same local clock and never compares one with a time in a payload.

- **A cached schedule is evicted only when it is STRICTLY older than the board's
  service day, and eviction marks the route rather than clearing its fetch guard.**
  Both halves are a request loop otherwise. Evicting on "different" threw away
  today's schedule whenever the board was on the embedded fixture; clearing the
  guard let the eviction refetch inside the paint that evicted. `YYYYMMDD` compares
  chronologically as text, which is why no parsing is involved.

---

## Verification performed

Rendered headless at 412×915 (`gstack browse`) against the golden fixture.

- All 6 fixture vehicles render: 2858, 2867, 2216, 2701, 2641 in service, 2305 as
  deadhead. Confirmed by DOM query, not by eye alone.
- Interpolation: with the first accordion collapsed, #2701 (`stop_sequence` 5) sits
  between the Pleasant Valley/5th and 8th/Congress timepoints; expanding that
  segment lands it exactly on 7th/Northwestern, which is stop 4181 — the stop the
  feed actually reports it at. Edge cases unit-checked in the browser: before the
  first anchor, exact hit, between anchors, past the last, null sequence, no
  anchors.
- `?state=stale` and `?state=dead`: no lateness value renders anywhere. Scanned the
  full rendered text and every SVG label for `[+−-]\d+m` — no matches. The deviation
  axis drops its minute labels too, since a scale implies a reading.
- Grayscale: `?state=all-states` screenshotted and converted to grey. Every state
  still separable.
- Focus order: route chip → WB → EB → BOTH → each vehicle row → each accordion →
  alerts. All targets ≥ 44px.
- No horizontal overflow at 412px; no console errors.

Not verified on real hardware, and not verified under `prefers-reduced-motion`
(the headless harness has no media emulation) — the reduced-motion rules are
code-level only: animations off, durations zeroed, transitions disabled.
