#!/usr/bin/env python3
"""Fetch currency prices from poe.ninja into public/data/prices.json.

Run by .github/workflows/prices.yml at most once an hour. The app never calls poe.ninja from users' browsers;
it only reads the static prices.json this script writes.

Usage:  python3 tools/fetch_prices.py [out_file] [--league NAME] [--fixtures DIR]
  --league    league name as poe.ninja spells it (default: the current challenge league from poe.ninja's index)
  --fixtures  read saved API responses from DIR instead of the network (used by the tests)
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# poe.ninja's PoE 1 economy API (checked 2026-10-31 from a GitHub runner; the old /api/data/*overview routes are gone)
NINJA = "https://poe.ninja/poe1/api"
USER_AGENT = "reverse-crafter-prices/1.0 (static PoE crafting planner; hourly GitHub Action; contact via the repository's issues)"
INDEX_PATH = "data/index-state"
OVERVIEW_PATH = "economy/exchange/current/overview"
# exchange overview types with items the planner prices
TYPES = ["Currency", "Essence", "Fossil", "Resonator"]


def get(path, fixtures=None):
    if fixtures:
        name = path.split("?")[0].strip("/").replace("/", "_")
        query = dict(urllib.parse.parse_qsl(path.split("?", 1)[1])) if "?" in path else {}
        file = Path(fixtures) / f"{name}{'_' + query['type'] if 'type' in query else ''}.json"
        return json.loads(file.read_text(encoding="utf-8"))
    req = urllib.request.Request(f"{NINJA}/{path}", headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def current_league(fixtures=None):
    state = get(INDEX_PATH, fixtures)
    for lg in state.get("economyLeagues", []):
        name = lg.get("name", "")
        if name and "Hardcore" not in name and name != "Standard" and "SSF" not in name:
            return name
    raise SystemExit("couldn't find the current league in poe.ninja's index state")


def chaos_factor(core):
    """primaryValue is in core['primary'] (normally chaos); returns the factor that turns it into Chaos Orbs."""
    primary = (core or {}).get("primary", "chaos")
    if primary == "chaos":
        return 1.0
    rate = ((core or {}).get("rates") or {}).get("chaos")  # chaos per 1 primary
    if not rate:
        raise SystemExit(f"prices are in {primary!r} and there is no chaos rate to convert them")
    return float(rate)


def fetch(league, fixtures=None):
    prices = {}
    for t in TYPES:
        try:
            data = get(f"{OVERVIEW_PATH}?league={urllib.parse.quote(league)}&type={t}", fixtures)
        except urllib.error.HTTPError as e:
            print(f"::warning title=poe.ninja::type {t}: HTTP {e.code}, skipped")
            continue
        factor = chaos_factor(data.get("core"))
        names = {i["id"]: i["name"] for i in data.get("items", []) if i.get("id") and i.get("name")}
        for c in (data.get("core") or {}).get("items", []):
            if c.get("id") and c.get("name"):
                names.setdefault(c["id"], c["name"])
        for line in data.get("lines", []):
            name, value = names.get(line.get("id")), line.get("primaryValue")
            if name and isinstance(value, (int, float)) and value > 0:
                prices.setdefault(name, round(float(value) * factor, 4))
        if not fixtures:
            print(f"::notice title=poe.ninja {t}::{len(data.get('lines', []))} lines; core keys {sorted((data.get('core') or {}).keys())}; primary {(data.get('core') or {}).get('primary')}")
            time.sleep(1)  # be gentle: one request at a time
    prices["Chaos Orb"] = 1.0
    return prices


def main(argv):
    out = Path("public/data/prices.json")
    league, fixtures = None, None
    args = list(argv)
    while args:
        a = args.pop(0)
        if a == "--league":
            league = args.pop(0)
        elif a == "--fixtures":
            fixtures = args.pop(0)
        else:
            out = Path(a)
    league = league or current_league(fixtures)
    prices = fetch(league, fixtures)
    if "Divine Orb" not in prices:
        raise SystemExit("no Divine Orb price in the response; not writing prices.json")
    data = {
        "league": league,
        "source": "poe.ninja",
        "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) if not fixtures else "fixture",
        "divine": prices["Divine Orb"],
        "prices": dict(sorted(prices.items())),
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{league}: {len(prices)} prices, 1 divine = {prices['Divine Orb']} chaos -> {out}")
    if not fixtures:
        sample = {k: prices.get(k) for k in ("Divine Orb", "Exalted Orb", "Orb of Alteration", "Regal Orb", "Orb of Annulment")}
        print(f"::notice title=prices::{league}: {len(prices)} prices; {json.dumps(sample)}")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except BaseException as e:  # show the reason as a GitHub annotation, readable without the full log
        if isinstance(e, SystemExit) and not e.code:
            raise
        detail = getattr(e, "code", None) if isinstance(e, SystemExit) else f"{type(e).__name__}: {e}"
        if isinstance(e, urllib.error.HTTPError):
            detail += f" ({e.url})"
        print(f"::error title=fetch_prices failed::{detail}")
        raise
