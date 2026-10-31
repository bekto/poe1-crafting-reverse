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

# poe.ninja has moved its API before; the first base and index path that answer are used
API_BASES = ["https://poe.ninja/api/data", "https://poe.ninja/poe1/api/data"]
INDEX_PATHS = ["getindexstate", "index-state", "economy/index-state"]
API = API_BASES[0]
USER_AGENT = "reverse-crafter-prices/1.0 (static PoE crafting planner; hourly GitHub Action; contact via the repository's issues)"
# poe.ninja overview types with items the planner prices
CURRENCY_TYPES = ["Currency"]
ITEM_TYPES = ["Essence", "Fossil", "Resonator"]


def get(path, fixtures=None):
    if fixtures:
        name = path.split("?")[0].strip("/").replace("/", "_")
        query = dict(urllib.parse.parse_qsl(path.split("?", 1)[1])) if "?" in path else {}
        file = Path(fixtures) / f"{name}{'_' + query['type'] if 'type' in query else ''}.json"
        return json.loads(file.read_text(encoding="utf-8"))
    req = urllib.request.Request(f"{API}/{path}", headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def find_api(fixtures=None):
    """Picks the API base and index path that answer, reporting each try (GitHub annotations)."""
    global API
    if fixtures:
        return "getindexstate"
    for base in API_BASES:
        for path in INDEX_PATHS:
            API = base
            try:
                get(path)
                print(f"::notice title=poe.ninja API::{base}/{path} works")
                return path
            except urllib.error.HTTPError as e:
                print(f"::notice title=poe.ninja API::{base}/{path} -> HTTP {e.code}")
            time.sleep(1)
    raise SystemExit("no poe.ninja index endpoint answered; see the notices above")


def current_league(fixtures=None):
    state = get(find_api(fixtures), fixtures)
    for lg in state.get("economyLeagues", []):
        name = lg.get("name", "")
        if name and "Hardcore" not in name and name not in ("Standard",) and "SSF" not in name:
            return name
    raise SystemExit("couldn't find the current league in poe.ninja's index state")


def fetch(league, fixtures=None):
    prices = {}
    for t in CURRENCY_TYPES:
        data = get(f"currencyoverview?league={urllib.parse.quote(league)}&type={t}", fixtures)
        for line in data.get("lines", []):
            name, value = line.get("currencyTypeName"), line.get("chaosEquivalent")
            if name and isinstance(value, (int, float)) and value > 0:
                prices[name] = round(float(value), 4)
        if not fixtures:
            time.sleep(1)  # be gentle: one request at a time
    for t in ITEM_TYPES:
        data = get(f"itemoverview?league={urllib.parse.quote(league)}&type={t}", fixtures)
        for line in data.get("lines", []):
            name, value = line.get("name"), line.get("chaosValue")
            if name and isinstance(value, (int, float)) and value > 0:
                prices.setdefault(name, round(float(value), 4))
        if not fixtures:
            time.sleep(1)
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
    if league:
        find_api(fixtures)
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
