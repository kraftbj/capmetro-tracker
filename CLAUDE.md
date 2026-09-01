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
| Schema | `npm run test:schema` | Generated output vs `schemas/*.json`, plus the staff-PII assertion |
| Node | `npm run test:node` | `build/` shard generation, shared client logic, and the `deploy/` scripts (vitest) |
| PHP | `npm run test:php` | `runtime/` pure functions (phpunit) |
| E2E | `npm run test:e2e` | The client at 412px against fixture scenarios (playwright) |

Expectations:

- Write a test alongside new functions, and a regression test for every bug fix.
- QA and manual checks run against **real generated output**, not the golden fixture. The
  fixture covers route 4 only, the smallest of the six watched routes. Both bugs found by
  `/qa` on 2026-08-19 came from route 7 and the full 2,348-stop corpus; a fixture-only pass
  reported clean.
- `build/lib/stop-names.mjs` and `runtime/lib/stopnames.php` MUST stay behaviourally
  identical. They both write `stop_name`, so a divergence renders one stop two ways on one
  screen. Any change to either needs a differential run over all upstream names, not unit
  tests alone. This has already bitten once: ISSUE-002 in `.gstack/qa-reports/`.
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
- CapMetro publishes vehicle positions **twice**: as JSON (`cuc7-ywmd`) and as
  protobuf (`eiei-9rpf`). The runtime reads the JSON and falls back to the protobuf
  when the JSON is more than `CM_STALE_STALE_S` behind, because on 2026-09-01 the
  JSON publication froze for over five hours while the protobuf stayed current. Both
  are fetched server-side by the cron; neither is ever fetched by the browser, which
  only ever reads our own `/api/*.json`. `health.json`'s `feeds.positions_source`
  says which one a run used — if it reads `protobuf`, the JSON feed has stalled
  upstream and the board is running on the fallback. A stalled feed serves a clean
  200 with internally consistent content, so only its header age gives it away.
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
