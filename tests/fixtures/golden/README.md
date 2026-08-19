# Golden output fixture

`route-4-20260819.json` is a real `/api/route/4.json` payload, generated from the live feed
fixtures in `../feeds-20260819/` joined against CapMetro GTFS `260818_1456`. It validates against
`schemas/route-state.schema.json` with zero errors.

`generate-reference.py` is the throwaway generator that produced it. It is **not** the
implementation. It exists so the contract's claims are reproducible and so the real
implementation has a reference output to diff against.

Regenerate with the GTFS static feed extracted to `/tmp/gtfs/`, from the repo root — it
overwrites `route-4-20260819.json` in place (set `OUT=` to write elsewhere):

    python3 tests/fixtures/golden/generate-reference.py

If `/tmp/gtfs/` is missing, rebuild it from the published static feed:

    curl -L -o /tmp/gtfs.zip 'https://data.texas.gov/download/r4v4-vz24/application%2Fzip'
    unzip -o -d /tmp/gtfs /tmp/gtfs.zip

Verify with:

    python3 - <<'PY'
    import json
    from jsonschema import Draft202012Validator
    from referencing import Registry, Resource
    store={n+".schema.json": json.load(open(f"schemas/{n}.schema.json"))
           for n in ["common","route-state","all","watch","health"]}
    reg=Registry().with_resources([(k,Resource.from_contents(v)) for k,v in store.items()])
    doc=json.load(open("tests/fixtures/golden/route-4-20260819.json"))
    errs=list(Draft202012Validator(store["route-state.schema.json"], registry=reg).iter_errors(doc))
    print(f"{len(errs)} error(s)")
    PY

Note the generator does not yet exercise every branch of the contract: the captured minute had no
CANCELED or no-trip-update vehicle on route 4, so `adherence.state` covers only `ontime` and
`deadhead` here. Acceptance criterion 2 in `docs/api-contract.md` requires all six states, which
means the real test suite needs synthetic fixtures in addition to this one.

## What this fixture covers

- **Both directions.** 3 timepoints for `direction_id` 0 and 3 for direction 1, in one flat
  array, matching contract §1. (Before 2026-08-19 the generator hardcoded direction 0 and the
  fixture carried half a route, which made the direction-1 ladder untestable.)
- **`route.next_departure`** (§1) — the 10:21 Mopac WB from Pleasant Valley/5th.
- **`schedule`** (§3.2) — the windowed timepoint schedule, 6 trip rows per direction inside
  `generated_at - 900 .. generated_at + 2700`. All five in-service vehicles have a matching
  trip row with an identical `start_epoch`, which is the join the string-line renders on.
- **`alerts[].stop_ids` deduplicated** (§5). The upstream feed repeats a stop once per informed
  route, so all three alerts arrived as `["940","940"]`-style pairs.
- **No `8Th/Lavaca`** — §7 rule 4 normalizes intercapped ordinals.
