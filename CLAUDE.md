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
| Node | `npm run test:node` | `build/` shard generation and shared client logic (vitest) |
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
