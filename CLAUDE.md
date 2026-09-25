# capmetro-tracker

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Testing

Run everything: `npm test` (wraps `tests/run-all.sh`).

| Suite | Command | Covers |
|---|---|---|
| Schema | `npm run test:schema` | Generated output vs `schemas/*.json` |
| Node | `npm run test:node` | `build/` shard generation, shared client logic, the `deploy/` scripts, and the staff-PII sweep over generated output (vitest). That sweep needs a webroot: under `npm test` it binds, on a bare `vitest run` it skips |
| PHP | `npm run test:php` | `runtime/` pure functions, including the alert ingest allowlist that strips staff PII before anything is written (phpunit) |
| E2E | `npm run test:e2e` | The client at 412px against fixture scenarios (playwright) |

Expectations:

- Write a test alongside new functions, and a regression test for every bug fix.
- QA and manual checks run against **real generated output**, not the golden fixture. The
  fixture covers route 4 only, one of the smallest of the watched routes. Both bugs found by
  `/qa` on 2026-08-19 came from route 7 and the full 2,348-stop corpus; a fixture-only pass
  reported clean.
- `build/lib/stop-names.mjs` and `runtime/lib/stopnames.php` MUST stay behaviourally
  identical. They both write `stop_name`, so a divergence renders one stop two ways on one
  screen. Any change to either needs a differential run over all upstream names, not unit
  tests alone. This has already bitten once: ISSUE-002 in `.gstack/qa-reports/`.
- `runtime/lib/gtfsrt.php` MUST keep producing exactly what CapMetro's JSON exports produce,
  for **both** the positions pair (`cuc7-ywmd` / `eiei-9rpf`) and the trip updates pair
  (`mqtr-wwpy` / `rmk2-acnw`). It is the second shape of this kind in the codebase and the same
  rule applies for the same reason: two producers feeding one consumer, where a divergence is
  invisible until the day the fallback runs. The difference from the stop-names pair is that we
  own neither half of the comparison — CapMetro can change its JSON export without telling us,
  and the decoder would keep agreeing with a spec nobody is publishing any more. Unit tests
  prove the decoder matches the **spec**; only a differential run over both live publications
  proves it matches the **export**.
  - **Trip updates: captured.** `tests/fixtures/feeds-pb-differential/tripupdates.{json,pb}`,
    both halves stamped `1788946436`, 2,299 entities equal under `===` including key order.
  - **Positions: still owed.** `feeds-pb-differential/vehiclepositions.pb` does not exist, so
    `GtfsRtDecoderTest::testDecodedProtobufMatchesTheJsonExportForTheSameObservations` skips
    and says why. Take it the next time both publications are healthy. Note that a total stall
    is a *fine* moment to capture a pair — both halves stop moving — but only if the two froze
    on the same instant; on 2026-09-09 the positions halves froze 29s apart and only 9 of 260
    vehicles paired, against the test's floor of 50.
  - Anything touching either decoder needs a differential run over the pair it affects, not
    unit tests alone. The mutation check that matters: swap the two `ScheduleRelationship`
    maps and confirm the differential fails.
- Never commit code that makes existing tests fail.

## Deploy Configuration (configured by /setup-deploy)
- Platform: self-hosted Linode (Ubuntu 24.04), single origin
- Production URL: https://bus.dillo.dev
- Deploy workflow: none. `deploy/update.sh` on the box, run over ssh
- Repo: public, so the box clones over HTTPS with no key and no deploy key
- Deploy status command: `systemctl status capmetro-generate.timer`
- Merge method: merge to `trunk`, then update the box
- Project type: static client + PHP CLI cron job. No app server, no database
- Post-deploy health check: `https://bus.dillo.dev/api/health.json` (`"ok":true`)

### Custom deploy hooks
- Pre-merge: `npm test`
- Deploy trigger: `ssh <host> 'sudo /srv/capmetro/src/deploy/update.sh'`
- Deploy status: `curl -sf https://bus.dillo.dev/api/health.json | grep -q '"ok":true'`
- Health check: `https://bus.dillo.dev/api/health.json`
- `update.sh` exit codes: **0** clean; **1** anything that stopped the deploy (a
  precondition refusal — not root, no checkout, not a fast-forward — or the generator
  failed and the commit was rolled back); **3** the deploy succeeded but the committed
  systemd units are not the ones installed, so run `sudo deploy/install.sh`.
  Anything treating a non-zero exit as a failed deploy must special-case 3, or it
  will report a healthy board as broken. Note that systemd itself does not: the unit
  carries no `SuccessExitStatus=3`, so a drift run shows as failed in
  `systemctl status`, deliberately, since that is the loudest signal available until
  something alerts. Read `ExecMainStatus` to tell 3 from 1.

### Notes
- CapMetro publishes vehicle positions **twice** (JSON `cuc7-ywmd`, protobuf
  `eiei-9rpf`) and trip updates **twice** (JSON `mqtr-wwpy`, protobuf `rmk2-acnw`).
  Alerts are published once and are not GTFS-RT, so they have no fallback. The
  runtime reads each JSON and falls back to that feed's protobuf when the JSON is
  more than `CM_STALE_STALE_S` behind, because on 2026-09-01 the positions JSON
  froze for over four hours while its protobuf stayed current. Each JSON is fetched
  every cycle; a protobuf is fetched **only** on a cycle that has already seen that
  feed's JSON stalled, which is what makes recovery need no stored state and keeps a
  healthy run costing what it always did. All are fetched server-side by the cron
  when they are fetched at all; none is ever fetched by the browser, which only ever
  reads our own `/api/*.json`. `health.json`'s `feeds.positions_source` and
  `feeds.trip_updates_source` say which one each run used — if either reads
  `protobuf`, that JSON feed has stalled upstream and the board is running on the
  fallback for it.
- **A `json` source is not evidence of health.** On 2026-09-09 every CapMetro
  publication to data.texas.gov stopped inside four minutes — both positions
  halves, both trip updates halves, and alerts — and both source fields correctly
  read `json` throughout, because neither protobuf was any fresher than the JSON it
  would have replaced. That is the fallback declining, working as designed. Read
  `errors` and `ok` to judge health; read the source fields only to learn which
  publication answered. When diagnosing, check Socrata's own
  `viewLastModified` (`https://data.texas.gov/api/views/<id>.json`) to tell a
  publisher that stopped uploading from one still uploading stale content. The generator also writes a
  `notice:` line to stderr, and therefore to the journal, when the source is not
  `json`, when the fallback was consulted and could not help, and when the decode
  dropped vehicles. Those go to stderr **unconditionally**, not through the `--quiet`
  logger: production runs the generator with `--quiet` (see the `GEN` line in
  `install.sh`), so anything routed through `$log` reaches nobody on the box. A
  stalled feed serves a clean 200 with internally consistent content, so only its
  header age gives it away. The fallback gets a bounded 10s timeout rather than the
  full `timeout_s` — it is not what brings a run inside the unit's
  `TimeoutStartSec=50`, which the fetch budget already exceeds without it; see TODOS.
- Nothing under the webroot executes. The runtime is a PHP CLI job on a systemd
  timer that writes JSON to disk; there is no PHP handler in the vhost and that
  is deliberate, not an omission.
- `update.sh` does not restart anything. The generator is a systemd oneshot, so
  new code is picked up on the next firing and there is no window where the
  board is down for a deploy.
- `update.sh` does not install systemd units either; only `install.sh` writes
  `/etc/systemd/system`. It does now *detect* when the committed units have moved
  on: it names them and exits **3** (distinct from 1, which means the deploy itself
  failed and rolled back), after the code and schedule are already live. A unit
  change therefore needs `sudo deploy/install.sh` to take effect — a plain
  `update.sh` will tell you, not fix it. Anything reading update.sh's exit status
  as a deploy verdict should treat 3 as "deployed, units stale", not as a failure.
- The record it checks against is `/etc/capmetro/installed-units.sha256`, written by
  `install.sh`. It lives in the root-owned config dir rather than the state dir
  because the state dir belongs to the nologin job account, and a stamp that account
  could rewrite is a check it could switch off. A box that has never run an
  `install.sh` carrying this feature has no record; `update.sh` says so once per run
  and carries on, because "cannot tell" is not "drifted".
- `update.sh` does not install the **vhost** either, and now says so when it matters.
  It fingerprints `deploy/nginx-capmetro.conf` and `deploy/apache-capmetro.conf` the
  same way it fingerprints the units, against
  `/etc/capmetro/installed-vhost.sha256` — a second record, written by `install.sh`,
  kept separate because the two are installed by different remedies at different
  times and one file would be rewritten wholesale by whichever ran last.
  Unlike unit drift this **never changes the exit code**: 3 keeps meaning
  specifically "the committed systemd units are not the ones installed", one
  condition with one remedy, and a vhost needs a different one. The notice goes to
  stdout and therefore to the journal. A box with no record — every box installed
  before this — stays silent, except on the one deploy whose own pulled range
  changed a vhost, which is the case that would otherwise land unannounced.
  `install.sh` prints one line for the vhost when the enabled file (and apache's
  `-le-ssl.conf` HTTPS copy, if certbot wrote one) carries the committed vhost's lines
  IN ORDER, rendered with this run's `--domain` and `--webroot`; certbot's inserted
  lines are allowed between them, and `listen`/`<VirtualHost` lines are skipped
  because certbot rewrites them. Otherwise it prints a short checklist, and
  `--show-vhost` forces it. It decides from `/etc`, not from the drift record, which
  is written whether or not the steps were run; the record can only veto (a change
  to this server's vhost since the last install prints the steps, on the one run
  after it -- that run restamps the record, as every printed run does -- which is
  what catches a change that only deletes a line). A matching vhost with no TLS keeps the certificate step, and an
  apache box whose only stale file is certbot's HTTPS copy is told how to fix that
  file. It reads files, not the running server. The reasons behind each step live
  in the script's comments, not its output.
  **Pass `--domain` when you run `install.sh` for a vhost.** Without it the script
  now refuses to print the install commands at all, and that refusal is the fix for
  an outage on 2026-09-21: it used to substitute the literal string `your.domain`
  into a block formatted for pasting, which wrote `server_name your.domain;`. nginx
  validates neither that a server_name resolves nor that any block matches, so
  `nginx -t` reported success, the reload was clean, and every request for
  bus.dillo.dev fell through to `default_server` — which on that box is a WordPress
  site, so the board answered with a database error page and looked like a DNS
  fault. The one-command diagnosis for that shape: a bogus `Host:` header and the
  real one returning the IDENTICAL response means no server block matches.
  The same step overwrote certbot's 443 block, so HTTPS went too; the printed
  instructions now diff first and end with `certbot install --cert-name`.
  Note also that the drift record fingerprints the COMMITTED vhosts, never the
  installed ones — it answers "has the repo's vhost moved since install.sh last ran
  here", and cannot see what is actually in `/etc`. It was silent all through that
  outage, correctly by its own definition.

  Why it earns a bullet at all: a stale timer fires at the wrong hour and the board
  still renders, while a stale vhost can refuse `manifest.webmanifest` and `sw.js`
  outright — not installable, no offline board, nothing on screen, and
  `health.json` still `ok:true`, so the documented post-deploy health check cannot
  see it. Installing one is a `sed` plus a reload, and on a TLS box the installed
  file is not the committed one because certbot rewrote it, so diff before
  overwriting rather than copying over the top.
- `/etc/capmetro/config.php` is never overwritten by the installer. It carries
  the watch list, which is the one file on the box describing somebody's routine.
- The GTFS Action is still required and is also the delivery mechanism: it
  rebuilds `data/` when CapMetro republishes (~3x/year, gated on `feed_version`)
  and commits it; the box picks it up on the next `update.sh`. `--src-from`
  bypasses git and therefore bypasses schedule delivery - it is a fallback for
  a box with no git, not a recommended path.
- Serving `data/` from GitHub Pages was considered and rejected: it is 3.1 MB
  gzipped committed ~3x/year, about 9 MB a year against an 8.8 MB `.git`, and
  it would buy that back at the cost of a publish step, a fetch-and-extract
  path in the runtime, and a new failure mode for schedule data.
- dillo.dev itself is on Pressable behind Automattic's edge cache. The board is
  a subdomain pointed at the Linode precisely so it does not inherit that cache:
  `/api/*` must be served `no-cache` or the board shows stale positions while
  looking current.
