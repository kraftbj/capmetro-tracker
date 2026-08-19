# Golden output fixture

`route-4-20260819.json` is a real `/api/route/4.json` payload, generated from the live feed
fixtures in `../feeds-20260819/` joined against CapMetro GTFS `260818_1456`. It validates against
`schemas/route-state.schema.json` with zero errors.

`generate-reference.py` is the throwaway generator that produced it. It is **not** the
implementation. It exists so the contract's claims are reproducible and so the real
implementation has a reference output to diff against.

Regenerate with the GTFS static feed extracted to `/tmp/gtfs/`:

    python3 tests/fixtures/golden/generate-reference.py

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
