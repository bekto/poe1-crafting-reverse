#!/usr/bin/env python3
"""One-off probe: which poe.ninja overview endpoints answer, and what their JSON looks like.
Prints GitHub annotations. Delete once fetch_prices.py is updated."""
import json, sys, time, urllib.error, urllib.parse, urllib.request
UA = "reverse-crafter-prices/1.0 (static PoE crafting planner; endpoint probe; contact via the repository's issues)"
def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)
idx = get("https://poe.ninja/poe1/api/data/index-state")
print("::notice title=index::" + json.dumps(idx)[:900])
league = next(l["name"] for l in idx.get("economyLeagues", []) if "Hardcore" not in l["name"] and l["name"] != "Standard")
q = urllib.parse.quote(league)
cands = [
  f"https://poe.ninja/api/data/currencyoverview?league={q}&type=Currency",
  f"https://poe.ninja/poe1/api/economy/exchange/current/overview?league={q}&type=Currency",
  f"https://poe.ninja/poe1/api/economy/currencyexchange/overview?league={q}&type=Currency",
  f"https://poe.ninja/poe1/api/economy/stash/current/currency/overview?league={q}&type=Currency",
  f"https://poe.ninja/api/data/itemoverview?league={q}&type=Essence",
  f"https://poe.ninja/poe1/api/economy/stash/current/item/overview?league={q}&type=Essence",
  f"https://poe.ninja/poe1/api/economy/exchange/current/overview?league={q}&type=Essence",
  f"https://poe.ninja/poe1/api/economy/exchange/current/overview?league={q}&type=Fossil",
]
for u in cands:
    try:
        d = get(u)
        shape = {k: (type(v).__name__, len(v) if isinstance(v, (list, dict)) else v) for k, v in d.items()} if isinstance(d, dict) else type(d).__name__
        sample = {}
        for k in ("lines", "items", "core"):
            if isinstance(d, dict) and d.get(k):
                sample[k] = d[k][0] if isinstance(d[k], list) else d[k]
        print(f"::notice title=OK {u[19:80]}::{json.dumps(shape)[:300]} | {json.dumps(sample)[:700]}")
    except urllib.error.HTTPError as e:
        print(f"::notice title=HTTP {e.code}::{u}")
    time.sleep(1)
