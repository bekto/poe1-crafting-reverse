#!/usr/bin/env python3
"""Build the compact crafting data file the web app loads.

Input:  RePoE export JSON files (https://github.com/repoe-fork/repoe-fork.github.io, data/)
Output: public/data/poe1.json

Usage:  python3 tools/build_data.py <repoe_data_dir> <out_file> <game_version>
Re-run this after every league/patch once RePoE has been updated.
"""
import json
import sys
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "data_src")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "public/data/poe1.json")
VERSION = sys.argv[3] if len(sys.argv) > 3 else "unknown"

# Item classes the crafter supports (RePoE item_class ids)
CLASSES = [
    "Ring", "Amulet", "Belt", "Body Armour", "Boots", "Gloves", "Helmet", "Shield", "Quiver",
    "Bow", "Claw", "Dagger", "Rune Dagger", "One Hand Axe", "One Hand Mace", "One Hand Sword",
    "Thrusting One Hand Sword", "Sceptre", "Staff", "Warstaff", "Two Hand Axe", "Two Hand Mace",
    "Two Hand Sword", "Wand", "Jewel",
]
INFLUENCE_ORDER = ["crusader", "elder", "hunter", "redeemer", "shaper", "warlord"]
# item_classes.json lists influence tags in this internal order
INFLUENCE_INTERNAL = {"crusader": "crusader", "elder": "elder", "basilisk": "hunter",
                      "eyrie": "redeemer", "shaper": "shaper", "adjudicator": "warlord"}


def load(name):
    with open(SRC / f"{name}.json", encoding="utf-8") as f:
        return json.load(f)


mods = load("mods")
bases = load("base_items")
essences = load("essences")
fossils = load("fossils")
bench = load("crafting_bench_options")
item_classes = load("item_classes")

# ---- item classes -------------------------------------------------------
classes_out = {}
for cid in CLASSES:
    ic = item_classes[cid]
    infl = {}
    for t in ic.get("influence_tags") or []:
        suffix = t.rsplit("_", 1)[1]
        if suffix in INFLUENCE_INTERNAL:
            infl[INFLUENCE_INTERNAL[suffix]] = t
    classes_out[cid] = {"name": ic["name"], "influence": infl}

# ---- bases --------------------------------------------------------------
# base domain -> one-letter code shared with the mods that can roll on it
BASE_DOMAINS = {"item": "i", "misc": "m"}
bases_out = []
all_tags = set()
domain_tags = {}
for bid, b in bases.items():
    if b.get("item_class") not in classes_out:
        continue
    # jewels live in the "misc" domain; cluster and abyss jewels have their own crafting rules
    if b.get("domain") not in BASE_DOMAINS:
        continue
    if "Royale" in bid:  # PoE Royale event bases, not in the real game
        continue
    if b.get("release_state") != "released":
        continue
    name = b.get("name") or ""
    if not name or name.startswith("[") or "DNT" in name:
        continue
    bases_out.append({
        "id": bid,
        "name": name,
        "cls": b["item_class"],
        "tags": b["tags"],
        "implicits": b.get("implicits", []),
        "lvl": b.get("drop_level", 1),
        "dom": BASE_DOMAINS[b["domain"]],
    })
    all_tags.update(b["tags"])
    domain_tags.setdefault(b["domain"], set()).update(b["tags"])
for c in classes_out.values():
    all_tags.update(c["influence"].values())
    domain_tags.setdefault("item", set()).update(c["influence"].values())

# ---- mods ---------------------------------------------------------------
def can_spawn_somewhere(m):
    tags = domain_tags.get(m["domain"], set())
    return any(w["weight"] > 0 and w["tag"] in tags for w in m.get("spawn_weights", []))

keep = {}
for mid, m in mods.items():
    dom, gen = m["domain"], m["generation_type"]
    if gen not in ("prefix", "suffix"):
        continue
    if "Royale" in mid:  # PoE Royale event mods, not in the real game
        continue
    if dom in BASE_DOMAINS:
        if not (can_spawn_somewhere(m) or m.get("is_essence_only")):
            continue
    elif dom == "crafted":
        pass  # filtered below to bench-reachable mods
    else:
        continue
    keep[mid] = m

# implicits used by kept bases (for parsing implicit lines)
implicit_ids = {i for b in bases_out for i in b["implicits"]}

bench_out = {}
for opt in bench:
    mid = opt["actions"].get("add_explicit_mod")
    if not mid or mid not in mods:
        continue
    classes = [c for c in opt.get("item_classes", []) if c in classes_out]
    if not classes:
        continue
    keep[mid] = mods[mid]
    entry = bench_out.setdefault(mid, {"classes": [], "cost": opt.get("cost", {}), "tier": opt.get("bench_tier")})
    for c in classes:
        if c not in entry["classes"]:
            entry["classes"].append(c)

# essence and fossil-added mods must be present
for e in essences.values():
    for mid in (e.get("mods") or {}).values():
        if mid in mods:
            keep[mid] = mods[mid]
for f in fossils.values():
    for mid in (f.get("added_mods") or []) + (f.get("forced_mods") or []):
        if mid in mods:
            keep[mid] = mods[mid]


def compact_mod(mid, m):
    return {
        "id": mid,
        "n": m.get("name") or "",
        "g": "p" if m["generation_type"] == "prefix" else "s" if m["generation_type"] == "suffix" else m["generation_type"][0],
        "d": m["domain"][0],  # i=item, m=misc (jewels), c=crafted
        "l": m.get("required_level", 1),
        "gr": m.get("groups", []),
        "ty": m.get("type"),
        "t": m.get("implicit_tags", []),
        "sw": [[w["tag"], w["weight"]] for w in m.get("spawn_weights", [])],
        "gw": [[w["tag"], w["weight"]] for w in m.get("generation_weights", [])],
        "st": [[s["id"], s["min"], s["max"]] for s in m.get("stats", [])],
        "x": m.get("text") or "",
        "e": 1 if m.get("is_essence_only") else 0,
    }

mods_out = [compact_mod(mid, m) for mid, m in keep.items()]
implicits_out = [
    {"id": mid, "x": mods[mid].get("text") or "", "st": [[s["id"], s["min"], s["max"]] for s in mods[mid].get("stats", [])]}
    for mid in implicit_ids if mid in mods
]

# ---- essences -----------------------------------------------------------
ess_out = []
for eid, e in essences.items():
    if not e.get("name") or not e.get("mods"):
        continue
    ess_out.append({
        "id": eid,
        "name": e["name"],
        "level": e["level"],
        "corrupt": bool(e["type"]["is_corruption_only"]),
        "ilvl": e.get("item_level_restriction"),
        "mods": {c: mid for c, mid in e["mods"].items() if c in classes_out and mid in keep},
    })

# ---- fossils ------------------------------------------------------------
fos_out = []
for fid, f in fossils.items():
    if not f.get("name"):
        continue
    fos_out.append({
        "id": fid,
        "name": f["name"],
        "pos": [[w["tag"], w["weight"]] for w in f.get("positive_mod_weights", [])],
        "neg": [[w["tag"], w["weight"]] for w in f.get("negative_mod_weights", [])],
        "added": [m for m in f.get("added_mods", []) if m in keep],
        "forced": [m for m in f.get("forced_mods", []) if m in keep],
        "allowed": f.get("allowed_tags", []),
        "forbidden": f.get("forbidden_tags", []),
        "desc": list((f.get("descriptions") or {}).values()),
    })

out = {
    "version": VERSION,
    "classes": classes_out,
    "bases": bases_out,
    "mods": mods_out,
    "implicits": implicits_out,
    "essences": ess_out,
    "fossils": fos_out,
    "bench": bench_out,
}
OUT.parent.mkdir(parents=True, exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
print(f"bases={len(bases_out)} mods={len(mods_out)} essences={len(ess_out)} fossils={len(fos_out)} "
      f"bench={len(bench_out)} size={OUT.stat().st_size/1e6:.2f} MB")
