# Reverse Crafter (Path of Exile 1)

Paste an item and the app works out how to craft it: which method to use, the steps in order, and the odds of each one.

Everything runs in the browser. It's a static site with no server.

## Run it locally

```bash
cd public
python3 -m http.server 8000
# open http://localhost:8000
```

The page has to be served over HTTP, because browsers block module scripts and `fetch` from `file://` pages.

## Update the game data after a new league or patch

The app reads one data file, `public/data/poe1.json`. You build it from the community RePoE export:

```bash
git clone --depth 1 https://github.com/repoe-fork/repoe-fork.github.io repoe
python3 tools/build_data.py repoe/data public/data/poe1.json "$(cat repoe/version.txt)"
```

You don't need to change any code for a new league, unless GGG adds a new crafting system.

## Project layout

```
public/
  index.html, css/style.css
  js/app.js            UI
  js/worker.js         runs the simulations in a background thread
  js/samples.js        example items
  data/poe1.json       game data built from RePoE
  data/manual/         hand-written mechanics RePoE doesn't export (Harvest), with sources
  js/engine/data.js    loads the data, compiles mod text into regexes
  js/engine/parse.js   parses Ctrl+C / Ctrl+Alt+C item text and identifies each mod and tier
  js/engine/pool.js    mod pools, spawn weights, tiers, bench options
  js/engine/craft.js   Monte Carlo simulator and planner
  js/engine/run.js     shared entry point (worker and main-thread fallback)
tools/build_data.py    turns the RePoE export into public/data/poe1.json
test/                  Node and Playwright checks
```

## How the odds are calculated

The engine uses the game's spawn weights, mod groups (an item can't have two mods from the same group), affix limits and item level.

- **Exact odds** (marked "exact") for crafts with one or two wanted mods (`public/js/engine/exact.js`). Rolling mods one by one, with chance proportional to weight, works the same as giving each mod group a random "clock" and taking groups in the order their clocks ring. In that picture prefixes and suffixes are independent, so the chance comes from a one-dimensional integral that the engine computes numerically to about 1 part in a million. Bench crafts, essences, fossil-forced mods and fractured mods are included. The alteration route is worked out by going through every possible item, with interchangeable mods grouped together.
- **Simulation** for three or more wanted mods, or for pools the exact method doesn't handle (for example a jewel mod group that can be a prefix or a suffix). The engine simulates the craft thousands of times and then spends extra time on the most promising methods. When an estimate rests on fewer than 30 successful simulations, the UI marks it as a "rough estimate".

The planner currently covers:

- Chaos Orb spam
- Essences: the lowest-tier essence that still gives the needed mod, including corrupted-only essences
- Fossils: the best combinations of 1 to 3 fossils, chosen by how much they raise the share of the wanted mods
- Alteration (+ Augmentation) → Regal → Exalted Orb, restarting the item when a slam misses, or annulling the miss (up to 1, 2 or 3 times per item, simulated) when prices say that's cheaper, also with "Cannot roll Attack/Caster Modifiers" crafted for the exalts when none of the missing mods have that tag
- Metacrafting in two stages: roll one side with the best reroll method, then "Prefixes (or Suffixes) Cannot Be Changed" + Chaos Orb until the other side is right
- Harvest (approximate, from hand-written data in `public/data/manual/harvest.json`): "Reforge ... including a <tag> modifier" for the tags of the wanted mods, and "Reforge keeping all Prefixes/Suffixes" as the second stage of a two-stage plan
- Influence: for one wanted influenced mod, roll the rest on a base without influence, then slam the matching influenced Exalted Orb (Crusader's, Hunter's, ..., Shaper's, Elder's). For a wanted influenced mod from each of two influences: one influenced Exalted Orb on each of two bases, then an Awakener's Orb
- Bench crafts at the end: one, or two with "Can have up to 3 Crafted Modifiers" (shown as "+ multimod"), with a check that the free slots are left. Bench costs come from the game data.

### Assumptions to verify

These aren't in the game data. Each one is a named constant in `public/js/engine/craft.js`.

- `RARE_COUNTS`: a rare roll (Chaos, Alchemy, essence, fossil) gets 4, 5 or 6 mods with chances 8/12, 3/12 and 1/12. These are community-measured values that crafting simulators such as Craft of Exile also use; GGG hasn't published them.
- `JEWEL_COUNTS`: jewels get 3 or 4 mods, with chances 8/12 and 4/12 (an estimate).
- `MAGIC_TWO_MOD_CHANCE`: an Alteration or Transmutation gives 2 mods half the time (an estimate).
- Fossil weights multiply: a 1000 entry means ×10, and a 0 entry blocks the mod.
- `LOCKED_REROLL_MIN_NEW`: a Chaos Orb on an item with "Prefixes/Suffixes Cannot Be Changed" keeps that side and rolls new mods only on the other side. The mod count is rolled as usual and the kept mods count towards it, with at least 1 new mod. The plan assumes the locked side is full, apart from slots kept for bench crafts.
- Harvest "including a <tag> modifier": the first new mod has the tag, and the tag's mods are `moreCommonMultiplier` (10) times more likely for the rest of the roll (in `harvest.json`). Lifeforce costs aren't filled in yet.
- "Cannot roll Attack/Caster Modifiers" blocks mods whose tags include `attack` / `caster`.
- An influenced Exalted Orb adds one random mod of its influence; the odds assume both sides have room, which is on the safe side. The Awakener's Orb keeps one influenced mod from each item (each has exactly one in the plan) and rolls the rest like a Chaos Orb, with the kept mods counting towards the usual mod count.
- An Orb of Annulment removes one explicit mod chosen uniformly at random.
- Each new mod is picked with chance proportional to its spawn weight, among the mods that are still allowed (no mod from a group already on the item, and a free prefix or suffix slot).

`test/reference.mjs` checks that the simulator gives the exact answers that follow from these assumptions on a small made-up pool (Chaos, Alteration, Alteration + Augmentation, essence). It checks the maths, not the assumptions themselves.

### Not covered yet

Harvest crafts other than reforges, Eldritch currency, veiled mods, recombinators, beastcrafting, Aisling, the 3.29 Allflame mechanic, and prices from poe.ninja.

## Tests

```bash
node test/run.mjs                 # parser on the sample items
node test/plan.mjs ring 0,3,5     # planner for chosen mods of a sample
node test/unit.mjs                # unit tests
node test/reference.mjs           # simulator against odds worked out by hand
NODE_PATH=$(npm root -g) node test/browser.cjs boots   # full UI run (needs Playwright and a server on :8765)
```

Fan-made tool. Not affiliated with or endorsed by Grinding Gear Games.
