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
- Alteration (+ Augmentation) → Regal → Exalted Orb, restarting the item when a slam misses
- One bench craft at the end, with a check that a free affix is left for it

### Assumptions to verify

These aren't in the game data. Each one is a named constant in `public/js/engine/craft.js`.

- `RARE_COUNTS`: a rare roll (Chaos, Alchemy, essence, fossil) gets 4, 5 or 6 mods with chances 8/12, 3/12 and 1/12. These are community-measured values that crafting simulators such as Craft of Exile also use; GGG hasn't published them.
- `JEWEL_COUNTS`: jewels get 3 or 4 mods, with chances 8/12 and 4/12 (an estimate).
- `MAGIC_TWO_MOD_CHANCE`: an Alteration or Transmutation gives 2 mods half the time (an estimate).
- Fossil weights multiply: a 1000 entry means ×10, and a 0 entry blocks the mod.
- Each new mod is picked with chance proportional to its spawn weight, among the mods that are still allowed (no mod from a group already on the item, and a free prefix or suffix slot).

`test/reference.mjs` checks that the simulator gives the exact answers that follow from these assumptions on a small made-up pool (Chaos, Alteration, Alteration + Augmentation, essence). It checks the maths, not the assumptions themselves.

### Not covered yet

Harvest, Eldritch currency, metacrafting, multimod, veiled mods, Awakener's and Conqueror's orbs, recombinators, beastcrafting, Aisling, the 3.29 Allflame mechanic, and prices from poe.ninja.

## Tests

```bash
node test/run.mjs                 # parser on the sample items
node test/plan.mjs ring 0,3,5     # planner for chosen mods of a sample
node test/unit.mjs                # unit tests
node test/reference.mjs           # simulator against odds worked out by hand
NODE_PATH=$(npm root -g) node test/browser.cjs boots   # full UI run (needs Playwright and a server on :8765)
```

Fan-made tool. Not affiliated with or endorsed by Grinding Gear Games.
