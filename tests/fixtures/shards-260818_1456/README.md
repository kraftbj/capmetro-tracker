# Frozen shards — `260818_1456`

The schedule shards `feeds-20260819/` was captured against, pinned so that tests about **join
logic** stop depending on whatever `data/` happens to hold today.

## Why this exists

`data/` moves. `feeds-20260819/` does not. Tests that pinned real trip ids and then read them
out of `data/` were really asserting "the committed shards are still the August 18 ones", and
they went red the moment that stopped being true — which is to say, the moment the board was
*fixed*. On 2026-08-27 CapMetro replaced `260818_1456` with `260826_0956`, and the rebuild that
restored production turned nine passing tests red without a single line of source changing.

It was worse than nine tests. `260826_0956` starts on service date 2026-08-26, and the capture
is from 2026-08-19 — a date that does not exist in the new calendar at all. So the fixture-driven
webroot came out with 71 departure boards carrying **zero departures each** and an `ok:false`
health file, and every acceptance criterion that binds to generated output stood down. Not
failing: skipping, against a corpus that was present and empty. The suite reported ~13 schema
checks where it had been reporting over 300.

That is the wrong shape for a test. "Does the watch tuple resolve to the right trip?" is a
question about `runtime/lib/watch.php`, and its answer must not change because an agency
renumbered its trips.

**Freshness is not tested here.** "Are the committed shards still what CapMetro publishes?" is
a live question about upstream, and no frozen fixture can answer it. `runtime/lib/upstream.php`
asks it for real — `feed_version` identity, every fifteen minutes — and reports it as
`staleness.schedule_state`. See `tests/php/UpstreamTest.php`.

## What is here

The complete shard tree as built from `260818_1456`: `manifest.json`, `calendar.json`,
`stops.json`, and all 71 routes under `routes/`, each with `schedule`, `blocks`, `patterns`,
`timepoints` and `calendar`.

All 71, not a useful subset. A subset was tried first and recreated the same coupling one level
down: `BlockRouteContinuationTest` needs block 1010, which interlines across routes 1, 4 and
485, and the interlining assertion needs route 152. Deciding which routes matter is exactly the
judgment that goes stale. The whole tree costs ~30 MB in the working copy and is written once
and never rebuilt, unlike `data/`, which is rewritten on every publication.

## Who reads it

| Reader | Why |
|---|---|
| `runtime/config.fixture.php` | Generates the offline webroot the acceptance criteria bind to. Its `shard_dir`. |
| `tests/php/ShardFreshnessTest.php` | The resolution-rate metric, measured on a matched pair. |
| `tests/php/WatchResolutionTest.php` | Pins the `800 / dir 1 / 6293 / 07:52:09` tuple to a real trip. |
| `tests/php/DeparturesTest.php` | Stop 6293 Simond SB is a minor stop on the 800. |
| `tests/php/BlockRouteContinuationTest.php` | Cross-checks a published `next_trip` against the shard it came out of. |

## Regenerating

Do not rebuild these from today's feed — that defeats the point. They are extracted from git at
`473aa0c`, the last commit before `f47a501` rebuilt `data/` for `260826_0956`:

    SNAP=tests/fixtures/shards-260818_1456
    git show 473aa0c:data/manifest.json > $SNAP/manifest.json
    git show 473aa0c:data/calendar.json > $SNAP/calendar.json
    git show 473aa0c:data/stops.json    > $SNAP/stops.json
    python3 -c "
    import json,subprocess,os
    m=json.load(open('$SNAP/manifest.json'))
    for r in m['routes']:
        os.makedirs(f\"$SNAP/routes/{r['dir']}\", exist_ok=True)
        for f in ['schedule','blocks','patterns','timepoints','calendar']:
            o=subprocess.run(['git','show',f\"473aa0c:data/routes/{r['dir']}/{f}.json\"],capture_output=True)
            if o.returncode==0: open(f\"$SNAP/routes/{r['dir']}/{f}.json\",'wb').write(o.stdout)
    "

Re-pin only alongside a fresh `feeds-*/` capture. The two are a matched pair and the whole
value here is that they agree — `ShardFreshnessTest` asserts exactly that, so half a re-pin
fails loudly rather than quietly measuring nothing. Any new capture wants a date carrying a
one-off service, for the reason `../README.md` gives.
