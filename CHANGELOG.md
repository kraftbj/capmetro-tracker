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

  Review found three ways this could assert something untrue, all fixed before
  merge and all with a regression test:

  - A **canceled** leg was resolved as though its bus merely had not reported yet,
    so the card could print "Connection holds" about a trip the agency had already
    called off. `trip.canceled` is now checked before the vehicle join, as
    `watch.js` does. On the 2026-08-19 feed that is 100 canceled trips across 10
    routes, 14 of them on route 837 and 8 on route 7 — both legs of "337 to the 7
    to the 837". Swept over all 100: every one now reports canceled, none is graded.
  - On a three-leg chain, **"Connection holds" rendered six lines under "Connection
    missed"** — the second verdict computed from a bus the rider will not be on.
    Grading now stops at the first change that cannot be made; everything after it
    reads "Not reached" and carries no slack figure.
  - The **tightest connection the editor will ever offer graded "holds"**.
    `MIN_SLACK_S` and `TIGHT_S` were both two minutes and the comparison was strict,
    so the case the code itself calls "a coin toss" was presented as comfortable.
  - **A leg with no live payload at all graded confidently from the timetable.**
    Not a dead feed and not an absent bus: nothing loaded. That is the state every
    page load starts in, because the live route map is built from payloads that
    have already landed and the chain paints before they do — so the first frame of
    every visit printed "Connection holds" beside the board's own "No live data for
    route N" banner, the card and the banner contradicting each other on one
    screen.

    This was the fifth hole found in the same place, and the shape of the code is
    why there was always another one. The grading decision was written as a list of
    reasons to *refuse*, which means it had a default, and the default was "grade
    it": every case nobody had enumerated landed there. Four rounds each patched
    one more refusal. It is now written the other way round — an exhaustive set of
    named cases with no fall-through, where a verdict requires evidence and
    anything unnamed is a refusal. The suite asserts the rule case by case, and
    over the whole input space, rather than only through a fully built chain.

    22 tests had been passing an empty routes map, which is what let this stay
    hidden: the suite had normalised "no live evidence" as the ordinary grading
    fixture. Each now says which state it means — a live feed with no bus, which
    the timetable may legitimately stand in for, or nothing loaded, which refuses.

  The walk model also charges a **1.4 circuity factor**: the straight line between
  two stops is not a path anyone walks, and Pleasant Valley — the junction this
  feature was built for — is a divided arterial. A 300 m hop now costs 5.8 minutes
  rather than 4.2. Measured over the corpus, 650 of the 2,086 offered connections
  are wider than the 215 m the hand-picked examples cover, so pricing them honestly
  is what lets the radius stay at 300 without fitting it to three cases.

  A second review round found four more places the card could assert something it
  could not support, all fixed with regression tests:

  - **A dead feed flipped "Connection missed" to "Connection holds".** A suppressed
    lateness was correctly refused as a number and then fell through to the
    timetable — which always reads *on time*. The same chain with the same bus ten
    minutes down graded `missed, 2 minutes short` on a fresh feed and `holds,
    8 minutes spare` on a dead one. Suppression now refuses to grade at all: the
    verdict reads **Connection unknown**, no slack figure is printed, and the copy
    says the feed has stopped updating instead of claiming the bus "is not
    reporting yet" — which was false twice over, since its badge is on the same
    screen. "No bus yet" and "a bus we have stopped being able to judge" are
    different facts and only the first makes the timetable a fair stand-in.
  - **`MAX_WAIT_S` capped post-walk slack rather than the wait**, so the real
    ceiling was the stated 45 minutes *plus* the walk — and the circuity factor
    widened it to 50.8. Now measured from stepping off the first bus, which drops
    21 of the 2,086 offered connections.
  - **The circuity factor never reached a chain already saved.** `walk_s` was frozen
    at save time while everything else in a chain is re-resolved each render, so
    existing chains kept up to 100 s of phantom slack. The walk is now recomputed
    from current stop positions — which also picks up a stop moved by a republish —
    falling back to the stored metres, re-priced, only when a stop has no fix.
  - **A cancellation on a leg nobody reaches became the headline**, burying an
    earlier missed connection and erasing the due time. Cancellations are now
    filtered to legs still reachable given the first failure.

  Also: a chain whose routes' schedules come from **different service days** now
  refuses to compare them rather than reporting "1448 minutes spare", and the board
  evicts a schedule that outlived its service day; a chain route whose payload
  **404s** is shown as missing rather than silently graded against the timetable;
  and from a `file://` board the missing data is explained as a limitation rather
  than a failure with a useless Try again.

  A third round found the same failure had survived twice, both times because the
  code could not reach the reasoning written above it:

  - **The refusal to grade a dead feed was only reachable through the vehicle
    join.** `suppress_adherence` describes a *route*, and it was read inside the
    branch that runs when a bus was found — so the same dead feed refused to grade
    when the frozen snapshot happened to hold that leg's bus and graded confidently
    when it did not. On a cron that died before the bus appeared those two are the
    same observation. It is read from the route now, before the join.
  - **And the refusal covered one of the six ways lateness can be unknown.** A bus
    with `no_trip_update` — about 7% of active vehicle trips — was graded against
    the timetable and described as "not reporting yet" with its own badge on the
    same card. Every unknown state is a refusal now, and the copy has three
    sentences rather than one, because a bus in a dead feed's snapshot, a bus
    *missing* from one, and a bus reporting fine on a live feed with no lateness
    published are three different facts.
  - **A refused verdict was still being asserted as three numbers.** The chain
    retired to "Gone. Back tomorrow" on the scheduled time it had just declined to
    trust, while the onward bus — last seen ten minutes down — was still at the
    kerb; the headline counted down to that same time in the largest type on the
    card; and the two times under the verdict were printed unlabeled in the slot
    used for real predictions, which subtract to the withheld answer in the
    reader's head. The retirement now stands down on the clock, and both times say
    they are the timetable.
  - **The service-day guard defended the wrong field.** It compared the
    `service_date` label while the arithmetic subtracts `service_day_start_epoch`,
    and skipped a document carrying no label rather than refusing it.
  - **The editor called post-walk slack "wait"**, understating the standing-around
    by the whole walk — the same conflation `MAX_WAIT_S` was corrected for.
  - **A schedule the editor could not load was a dead end** for the life of the
    tab: no error, no retry, no way forward, and guaranteed for every route on a
    `file://` board.

### Fixed

- **CapMetro replaced the schedule off-cycle and the board could not tell.** On
  2026-08-27, `260818_1456` became `260826_0956` eight days into a feed advertised
  as valid through 2027-01-09. Every trip id was renumbered, so nothing joined:
  **56 of 71 routes reported 100% of their live trips absent from the schedule
  shard**, every bus showed lateness `unknown` with reason `trip_not_in_schedule`,
  and the board said no bus on the road was in today's schedule. Every clock it
  owned still read healthy — feeds seconds old, `feed_end_date` five months away —
  so nothing raised a banner and nothing said why.

  The board now asks the only question that can detect this: is the `feed_version`
  we built from still the one upstream publishes? It reads `feed_info.txt` out of
  the upstream zip with three HTTP range requests — about 5.4 KB, not the 34 MB
  archive — at most once every fifteen minutes. A mismatch sets the new
  `staleness.schedule_state: "superseded"`, forces `stale`, and draws a banner that
  says CapMetro has published a newer schedule rather than claiming the timetable
  ran out, which would have been false. A probe that cannot answer reports nothing
  and raises nothing: an unreachable upstream is never a mismatch.

  Age was not an option. The rule that graded schedule age was removed for good
  reason (see the entry below) and reinstating it would fail on exactly the feed it
  was meant to protect: this one was nine days old and correct on 08-26, nine days
  old and superseded on 08-27. Identity separates those two; age cannot.

  Delivery was the other half. `deploy/capmetro-update.timer` pulled at 04:17 on a
  box running `Etc/UTC`, **seven hours before** the GTFS job's 11:20 UTC commit, so
  a rebuilt schedule was never picked up until the following day — worst case about
  41 hours from CapMetro publishing to this board serving it. The job now runs four
  times a day and the box pulls an hour after each, putting the worst case under six.

- **A shard rebuild was blocked by a gate that had been wrong all along.** The
  §7 shortener breaks a stop name on a space **or** a slash, because Austin names
  are `Street/CrossStreet` with no space around the slash. `build/verify.mjs` kept
  its own copy of the normalization steps and then demanded the cut land on a
  space, so all 23 slash cuts — `Martin Luther King/…`, `Pleasant Valley/…` — were
  reported as ending mid-word. The names were never wrong; the committed tree
  carries the same 23 and the JS and PHP implementations agree on all 2,326 upstream
  names. `npm run verify` only runs in CI when `feed_version` changes, so the broken
  gate sat latent until the first moment it mattered and then refused the rebuild
  that would have fixed production. `verify.mjs` now imports `stopNameStem` instead
  of keeping a second copy, and accepts both legal cut shapes.

- **A schedule eight days old blanked every lateness number on the board.** The
  staleness ladder graded the realtime feeds and the schedule on one scale, and
  more than seven days past `feed_start_date` forced `stale` — which sets
  `suppress_adherence`, so no bus anywhere may show how late it is. CapMetro
  republishes about three times a year, so that threshold was passed within a week
  of every publication and stayed passed for months. The board spent almost all of
  its life refusing to answer the question it exists to answer, under a warning
  that read "Data 14 sec old. Lateness is hidden until the feed catches up." about
  positions that were fourteen seconds old and arriving on time — a fault where
  there was none, and a wait that could never end.

  Schedule age no longer sets the level. What invalidates a lateness number is a
  schedule that has **run out**: past `feed_end_date` there is no timetable for
  today to measure against, and that — the condition `health.json` already fails
  on — is what forces `stale` now. `schedule_age_days` is still reported and still
  appears under a banner raised by something else; it simply no longer raises one.
  The realtime thresholds are untouched, so a feed that genuinely stops still goes
  `aging`, `stale`, `dead` at 120s, 600s and 3600s exactly as before.

  The banner had no way to say which of the two had happened and always blamed the
  feed. It now names the schedule when the schedule is what gave out, and offers a
  new publication rather than a wait. `?state=schedule-expired` renders that row.

- **One warning, shouted four times.** The Saved view drew a staleness banner per
  saved route and the board drew its own above them, so a single dead feed — one
  cron run, one pair of feeds, the same `staleness` object word for word on every
  route — stacked four identical warnings above the cards they were about. Routes
  are now bucketed by what their banner would actually say and each distinct
  warning is drawn once, labelled with every route it covers ("Routes 4, 800 and
  837"), and the board's unlabelled copy is not drawn on that view at all. Nothing
  is collapsed that is not identical: a route this browser alone has failed to
  refresh reports a different reason, and keeps its own banner and its own retry.

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

  "Every render path" was briefly untrue and is worth recording. The trip view
  arrived separately and read the held schedule directly, so it went on printing
  a finished service day's stop times — on the one screen built entirely around
  scheduled times — while every other surface correctly refused. The whole suite
  stayed green, because every test for this lived on the board and saved views.
  The trip view has its own case now.

  A schedule whose date the board cannot read at all is treated the same way:
  kept, never answered from, asked for again. The comparison used to be a bare
  `<`, which left the answer to JavaScript's coercion rules and landed on
  opposite sides depending on how the document was malformed — an ISO date was
  condemned forever, a missing one was believed forever.

  And a request that never comes back is given up on after two minutes rather
  than blocking that route's schedule for the life of the tab. A fetch has no
  timeout, so one outstanding when a phone suspends may simply never settle;
  withholding turned that from a stale board into an empty one that the network
  returning could not fix.

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

- **A route id from a link could blank the board and blame the reader's phone
  for it.** The bundled offline fixtures are two more maps keyed by whatever
  `?route=` contains, and both were plain objects, so the same prototype-chain
  reach that the stop id had. `?route=__proto__` produced a board showing
  nothing but "This app needs updating. The board received data written for
  format undefined" — not merely broken, but wrong about why, sending the reader
  off to fix a copy of the app that was never the problem. `?route=constructor`
  reached the fixture through a copy that cannot be made of a function, and put
  the parser's own words on screen. Guarded at each lookup, so a fixture written
  by an older generator is covered too.

- **The saved tab talked to the server about sixty times a second.** Each saved
  trip's route document was requested on every repaint, and the response
  repainted, so a board left sitting on that tab — a phone put down, screen
  still on — spun against the origin indefinitely: measured at 364 requests in
  six seconds for a single route file. The status now stops a repeat the way the
  schedule's already did, and the once-a-minute refresh is the only thing that
  asks again.

- **A link could freeze the board while leaving it looking current.**
  `?state=` names an entry in the state-preview table, and that lookup was a bare
  one on a plain object, so every member of `Object.prototype` answered to it.
  `?state=constructor` rewrote the payload into something the schema check
  refused, so the board showed the schema notice and no times at all. `?state=
  valueOf` was quieter and worse: the payload passed through untouched, the board
  rendered correctly — and because the 60s refresh is gated on there being no
  scenario, it never updated again. A board that is visibly broken sends someone
  to look up the timetable; one that looks current and is frozen sends a child to
  a stop. The table is now null-prototype, the same rule already applied to the
  route-keyed maps.

- **Remove did nothing, and said nothing, when the browser refused the delete.**
  `watch.remove()` discarded what `writeStore` reported, exactly as `add()` used
  to. On a full or read-only store the button was simply dead: the card stayed
  where it was, no message appeared, and the trip was still on the device. It
  gets its own words rather than the save wording, because what is wrong is the
  opposite — not that nothing was kept, but that something the reader asked to
  destroy is still there, and what it describes is which stop a child waits at
  and when. A delete that works now says so out loud too; the spoken channel is
  not repainted, so a refusal followed by a success used to leave a screen reader
  holding the refusal.

- **A 200 with an empty body was taken for an answer, three different ways.** A
  proxy error page, or any response parsing to null, was stored under an `ok`
  status, and each of the three documents then failed differently.

  The schedule spun: the cache guard reads a falsy value as "nothing cached", so
  the next paint asked again, and the saved view — which re-asks on every render
  — ran against the origin without limit.

  The fleet document was worse than a wasted request. The board rendered
  "CapMetro is reporting no buses at all … a CapMetro problem rather than a
  problem with this board" — a confident, specific and false statement about
  service, naming somebody else as the cause, while the real can't-reach-the-feed
  notice and its Retry never appeared.

  A route document parked on the one status the retry cannot see. The
  once-a-minute sweep clears `error`; a falsy body landed on `ok`, so a bus
  detail read "Just left · loading the route…" for the life of the tab with
  nothing loading and nothing that ever would.

  And the board's own route document — the first fetch any reader makes — could
  be answered with `[]` or with a captive portal's `"sorry"`, and land on the
  screen that says "This app needs updating… written for format undefined". That
  is the worst of the four, because it is not merely wrong, it is wrong about
  whose fault it is: it sends the reader off to update an app that was never the
  problem. An unreachable feed already had an answer for this — show the bundled
  sample under its banner, or say the feed cannot be reached — and a 200 that is
  not a document is now treated the same way, rather than better-looking and
  worse.

  All four go to the paths that already existed. Arrays are refused along with
  the falsy bodies — `typeof [] === 'object'`, so an array passed every check
  that was not looking for it — and the fleet document additionally has to carry
  a list of vehicles, because `{}` is JSON-shaped enough to satisfy a transport
  check while reproducing that accusation word for word.

- **A stop id from a link could blank the whole board.** `departures[stopId]` was
  a bare lookup on an object parsed from JSON, so it also reached
  `Object.prototype`. `?stop=constructor` returned the Object function — truthy,
  so the `|| []` fallback never fired, with a `length` of 1 and nothing at `[0]`.
  The next line read `rows[0][1]` and threw, and because that happened during
  render the page went blank rather than showing an empty stop. `app.js` takes
  `state.stopId` straight off the query string, so this was reachable by anyone
  who could send a URL. Guarded once, at the single lookup every reader goes
  through, rather than in whichever caller happens to hold an untrusted id.

- **A route document that failed to load stayed failed, on the every-bus view.**
  Stopping the saved tab spinning meant refusing to re-ask on a repaint, and the
  only thing putting a route back in play was the saved view itself — so one
  dropped request on `/buses` left a bus detail reading "loading the route…"
  with nothing loading and nothing that ever would. Any failed route document is
  now retried once a minute, from the timer, whichever view asked for it.

- **The trip view said nothing at all when it withheld a schedule, or when one
  failed to load.** It drew the
  shimmer that means "this is about to arrive", which is a promise the board
  cannot keep when what it is actually doing is holding a schedule from a
  service day that has ended. Those placeholder rows are also hidden from
  assistive technology, so a screen reader reached the bus name and stopped. It
  says which of the three is happening now, in words — arriving, withheld, or
  failed — and only the first of those still gets a shimmer.

- **The saved-trip editor still said the schedule "only loads once".** The board
  view's copy was corrected when schedules started expiring at the service-day
  roll; the editor's was not, and the editor is handed exactly the schedule that
  has been withheld — so the sentence was on screen at the one moment it was
  provably false. Relatedly, "Nothing was saved." outlived the save it described,
  sitting above the list on every later visit until some future save happened to
  succeed; it is cleared when a new one is started.

- **The board said "Saved" when nothing had been saved.** `watch.add()` discarded
  what `writeStore` already told it, so a write refused by Safari private
  browsing, an exhausted quota, or storage switched off was announced as a
  success. The trip was not in the list, and on the next load it was gone
  entirely, with nothing having said so. `add()` now reports whether the store
  took it, and the saved view says so in words — the announcement alone goes to a
  screen-reader-only region and leaves a sighted reader with no sign at all.

## [0.6.0.0] - 2026-08-25

### Added

- **The board has URLs you can share.** `bus.dillo.dev/route/4/eb` opens the
  eastbound 4, `/buses` the fleet, `/trip/1234` the board following bus 1234,
  and `/saved` your saved trips. A bare bus id resolves its own route from the
  fleet document, so the link is short enough to read to somebody over the
  phone; it then upgrades itself to `/trip/{route}/{bus}`, which needs no such
  lookup when the link is opened again.

  `/saved` carries nothing but the tab name. Saved trips live in the browser and
  a watch in a URL would publish somebody's routine to whoever they sent it to.

  Every link that already existed still works. `?view=`, `?route=`, `?dir=`,
  `?bus=` and the `?state=` harness are permanent, not deprecated: they are the
  only form a `file://` copy can use, and a query still overrides a path field
  by field so a pretty URL and a forced state can be combined.

  **This needs a one-time vhost change.** `deploy/nginx-capmetro.conf` gains a
  fallback for the four app paths, and `update.sh` deliberately does not install
  vhosts. Until it is installed by hand and nginx reloaded, path links 404 while
  `/` and every query link keep working:

      sudo cp /srv/capmetro/src/deploy/nginx-capmetro.conf \
        /etc/nginx/sites-available/capmetro
      sudo nginx -t && sudo systemctl reload nginx

  The fallback is scoped to `route`, `buses`, `trip` and `saved` rather than
  being a blanket one, so a mistyped asset still 404s instead of being answered
  with a page of HTML that looks like it loaded.

### Fixed

- **The security headers no longer forbid the board its own bootstrap.** The
  vhosts sent `script-src 'self'` and `base-uri 'none'`, on the stated grounds
  that the client had no inline script. It has one now — the `<base>` bootstrap
  that lets a page served at `/route/4/eb` find its own scripts — so both would
  have been blocked and every pretty URL would have rendered a blank page. The
  snippet is admitted by sha256 hash, `base-uri` is `'self'`, and
  `'unsafe-inline'` stays absent. The end-to-end fixture server now serves the
  real policy read out of the vhost, so this class of break fails the suite
  rather than the deployment.

- **`/route/4/.env` and `/trip/x.php` reached the app fallback.** nginx takes the
  first matching regex location and the two `deny all` blocks were declared last,
  so they were shadowed for every path under the new prefixes — and, already,
  for anything matching the asset block. They now come first.

- **A legacy `?view=`/`?route=`/`?bus=` link no longer contradicts the path it
  rewrites to.** Opening an old query link and switching views produced
  `/buses?view=trip&route=4&bus=2641`, which sent whoever received it to a
  different screen than the sender was looking at. Those four keys are dropped
  when the address bar is rewritten; everything else, `?state=` included, is
  kept.

- **A bare `/trip/1234` no longer sticks when the fleet document fails to load.**
  The callback that resolves a bus id to its route only ran on success, and the
  retry only fires while the all-buses view is open, so one bad fetch stranded
  the link with no way out but a reload.

## [0.5.0.0] - 2026-08-25

### Fixed

- **The nearest-stop panel has been rendering with no styling at all since it
  shipped.** `.watchcard__canceled` in `client/styles.css` was missing its
  closing brace, so the parser ran past the end of that rule and swallowed
  everything up to the next one it could recover at — `.nearhost:empty` and
  the whole `.near` rule, background, border, radius and padding included.
  Nothing about the markup or the logic was wrong; the panel simply never had
  a box around it. Found and fixed while building the trip view below, and
  unrelated to it.
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

- **A trip view: pick a bus, and see every stop it still has ahead of it.**
  Every other panel is anchored at a stop or a route; this one is anchored at
  a vehicle. Pick a route and a bus and the board lists the rest of its trip
  in order, with a scheduled time and an arrival time beside each stop — the
  agency's own predicted time where the feed still publishes one, and the
  board's own projection, marked `~` and separated by a divider, once it runs
  out. Order comes from the stop times' own arrival order rather than the
  published stop sequence, which disagree on 2,221 of the corpus's 4,112
  trips; predictions are matched to stops positionally rather than by id,
  because 234 trips visit one stop twice and an id match would answer both
  visits with the first one. The projection past the feed's last prediction
  carries its last known deviation forward rather than recomputing it fresh,
  which is a materially different number — the two disagree by more than a
  minute on 76.5% of estimated stops and by up to 15 minutes — and neither has
  been checked against what a bus actually did later, so the board says which
  is which rather than presenting one as fact. A bus that drops out of the
  feed mid-read keeps its last answer on screen, dimmed, with a last-seen
  time, instead of the list disappearing under the reader.
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

- **"Connection holds" now takes five minutes of slack, not two.** The estimator
  holds the first leg's currently observed lateness constant all the way to the
  alighting stop, and for a bus twenty minutes upstream that routinely drifts by
  minutes before it arrives — so a three-minute verdict sat inside the noise of the
  measurement that produced it and still read as comfortable. `TIGHT_S` is no
  longer tied to `MIN_SLACK_S`: offering a connection and trusting one are
  different judgments. Nothing is hidden. Connections between the two thresholds
  still appear, still print their slack figure, and still say which half of the sum
  is measured — they read "tight" instead of "holds". The asymmetry is the reason:
  a hedged connection that turns out fine costs a moment's doubt, and a confident
  one that turns out missed leaves a kid at a stop.

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

- **The Saved view was fetching route payloads in an unthrottled loop.**
  `loadRouteData()` is called from `paint()` and its success handler calls
  `render()`; its only guard was "am I already fetching", which is false by the time
  the handler runs. One fetch repainted, the repaint started another fetch, and the
  view sat in a request loop against the origin — measured at 115 requests in three
  seconds — for as long as it was open. Nothing looked wrong on screen, which is why
  it survived: the numbers were right, they were just being re-fetched forever. Found
  because a transfer-chain card was being rebuilt so fast its Remove button could not
  be clicked. Regression test asserts at most one fetch per route between refreshes.

  The first fix here was itself incomplete, and review caught it: it enumerated the
  statuses that stop (`loading`, `ok`), so `error` matched neither and a route that
  could not be fetched looped hardest of all — 178 requests in three seconds, a
  tight spin rather than a round trip, because a rejected fetch has nothing to wait
  for. Reachable two ways in production: a `file://` board, which is a stated
  requirement, and a GTFS republish dropping a route a saved chain still names. Now
  only `idle` proceeds, matching `loadDepartures`.

- **A route that loaded once and then stopped refreshing was trusted completely.**
  Its payload still says `fresh`, because it was — an hour ago. So the new banner
  did not draw and the chain leg on it was graded against positions frozen an hour
  back. That is the "the cron stopped an hour ago" case the banner exists for, and
  the one case it structurally could not see: no document can report how long the
  client has been holding it. The feed age used on the Saved view is now the age
  the server measured plus the time this browser has held the answer, judged
  against the contract's own thresholds.

- **A cached schedule from another service day was a request loop.** Evicting it
  also deleted the route's fetch guard, so the eviction refetched inside the paint
  that evicted, the refetch repainted, and the repaint evicted again — 143 requests
  in three seconds. It also evicted schedules *newer* than the board, which after a
  republish means the board's own year-old fallback fixture throwing away today's
  perfectly good schedule, forever. The third loop of this exact shape in one file.

- **Not rebuilding the open editor had stopped the board's clock.** The guard
  returned before the refreshes as well as before the repaint, so ten minutes spent
  in the editor left the Saved view behind it counting down from a ten-minute-old
  payload. The repaint is deferred now; the fetches keep running.

- **The Saved view trusted stale feeds it never showed a banner for.** Staleness was
  rendered for the route on the board and for nothing else — but this view's routes
  are by definition not the one being watched, so nobody is looking at their board
  to notice the feed died. A chain leg on a route whose cron stopped an hour ago was
  graded against frozen positions. Each such route now gets its own banner, labeled
  with the route number because an unlabeled one cannot say which card to distrust.

- **A refused save was announced as a success.** When `localStorage` says no —
  private browsing, quota, storage disabled — the board said "Saved …", left a
  six-step editor, and landed on "No transfer chains yet". `add()` now returns
  whether the chain is in the store and the editor stays put and says the browser
  refused. Related: a hand-edited store whose `legs` was an object passed validation
  (`length` on a non-array is `undefined`, and every comparison against it is false)
  and then threw inside `resolve()`, taking out the whole Saved view until the store
  was cleared by hand.

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
