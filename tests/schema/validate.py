#!/usr/bin/env python3
"""Standalone JSON Schema validation for the route-state API contract.

Runs with no build step and no network: python3 tests/schema/validate.py
Depends only on `jsonschema` and `referencing`.

Covers acceptance criterion 1 (every endpoint validates against its schema) for
whatever generated output exists, plus the committed golden fixture, which is the
part that can run before the runtime job lands. Also covers criterion 7 (no
a schema alone cannot prove a value
was stripped -- only that a key is absent.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

try:
    from jsonschema import Draft202012Validator
    from referencing import Registry, Resource
except ImportError:  # pragma: no cover
    sys.stderr.write("missing dependency: pip3 install jsonschema referencing\n")
    sys.exit(2)

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_NAMES = ["common", "route-state", "all", "watch", "health", "routes", "departures"]

# Where the runtime job is expected to write. Overridable so CI can point at a
# staging webroot. Absent directory is not a failure yet; see NOTES.md.
WEBROOT = Path(os.environ.get("CAPMETRO_WEBROOT", ROOT / "webroot")).resolve()

results: list[tuple[bool, str, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((ok, name, detail))
    print(f"{'ok  ' if ok else 'FAIL'} - {name}" + (f"\n       {detail}" if detail and not ok else ""))


def skip(name: str, why: str) -> None:
    results.append((True, name, "SKIP"))
    print(f"skip - {name}\n       {why}")


def load_registry():
    store = {}
    for n in SCHEMA_NAMES:
        p = ROOT / "schemas" / f"{n}.schema.json"
        store[f"{n}.schema.json"] = json.loads(p.read_text())
    reg = Registry().with_resources(
        [(k, Resource.from_contents(v)) for k, v in store.items()]
    )
    return store, reg


def strip_test_metadata(doc):
    """Fixtures carry _comment/_expected/_now keys. They are not wire format."""
    if isinstance(doc, dict):
        return {k: strip_test_metadata(v) for k, v in doc.items() if not k.startswith("_")}
    if isinstance(doc, list):
        return [strip_test_metadata(v) for v in doc]
    return doc


def validate(label: str, doc, schema_key: str, store, reg) -> None:
    errs = sorted(
        Draft202012Validator(store[schema_key], registry=reg).iter_errors(doc),
        key=lambda e: list(e.absolute_path),
    )
    detail = "; ".join(
        f"/{'/'.join(str(p) for p in e.absolute_path)}: {e.message}" for e in errs[:5]
    )
    check(f"{label} validates against {schema_key} with zero errors", not errs, detail)


def main() -> int:
    store, reg = load_registry()

    for n in SCHEMA_NAMES:
        try:
            Draft202012Validator.check_schema(store[f"{n}.schema.json"])
            check(f"schemas/{n}.schema.json is itself a valid Draft 2020-12 schema", True)
        except Exception as e:  # noqa: BLE001
            check(f"schemas/{n}.schema.json is itself a valid Draft 2020-12 schema", False, str(e))


    golden = ROOT / "tests" / "fixtures" / "golden" / "route-4-20260819.json"
    doc = json.loads(golden.read_text())
    validate("the committed route 4 golden output", doc, "route-state.schema.json", store, reg)

    dead = ROOT / "tests" / "fixtures" / "synthetic" / "route-4-dead-cron.json"
    if dead.exists():
        validate(
            "the dead-cron route file",
            strip_test_metadata(json.loads(dead.read_text())),
            "route-state.schema.json",
            store,
            reg,
        )

    torn = ROOT / "tests" / "fixtures" / "synthetic" / "torn-route-4.json"
    if torn.exists():
        try:
            json.loads(torn.read_text())
            ok = False
        except json.JSONDecodeError:
            ok = True
        check("the torn-write fixture is genuinely unparseable, so the atomic-write test has teeth", ok)

    # Generated output, once the runtime job writes it.
    api = WEBROOT / "api"
    if not api.is_dir():
        skip(
            "every generated endpoint validates against its schema",
            f"no generated output at {api} yet; runtime job has not run. "
            "Set CAPMETRO_WEBROOT to point at one.",
        )
    else:
        seen: set[str] = set()
        for path in sorted(api.rglob("*.json")):
            rel = path.relative_to(WEBROOT)
            parts = rel.parts
            # routes.json sits directly under api/, so it must be matched by name
            # before the api/route/ directory test -- the prefix would otherwise
            # never see it, but a future api/routes/ directory would collide.
            if rel.name == "routes.json" and len(parts) == 2:
                key = "routes.schema.json"
            elif parts[:2] == ("api", "route"):
                key = "route-state.schema.json"
            elif parts[:2] == ("api", "departures"):
                key = "departures.schema.json"
            elif parts[:2] == ("api", "watch"):
                key = "watch.schema.json"
            elif rel.name == "all.json":
                key = "all.schema.json"
            elif rel.name == "health.json":
                key = "health.schema.json"
            else:
                continue
            seen.add(key)
            text = path.read_text()
            validate(str(rel), json.loads(text), key, store, reg)
        # Six endpoint kinds now: the four originals plus the route catalog and
        # the per-route departure boards. Counting kinds rather than files is
        # what gives this teeth -- 71 route files would satisfy any file count.
        expected_kinds = {
            "route-state.schema.json",
            "all.schema.json",
            "watch.schema.json",
            "health.schema.json",
            "routes.schema.json",
            "departures.schema.json",
        }
        check(
            "the generated webroot carries all six endpoint kinds",
            seen >= expected_kinds,
            f"missing under {api}: {sorted(expected_kinds - seen)}",
        )

    failed = [r for r in results if not r[0]]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
