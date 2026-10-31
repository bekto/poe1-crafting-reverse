# Reverse Crafter (Path of Exile 1)

Paste an item and the app works out how to craft it: which method to use, the steps in order, and the odds of each one.

Everything runs in the browser. It's a static site with no server.

## How to use it

1. **Paste the item.** In the game, hover the item and press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd> (or <kbd>Ctrl</kbd>+<kbd>C</kbd>), then paste it into the box. It's read straight away. No item text? Open "Build the item by hand" and pick the base and mods from lists.
2. **Choose what you need.** Untick mods you don't care about and lower the tier where a weaker roll is fine; each relaxed tier makes the craft cheaper. Check the item level of the base you'll use.
3. **Find crafting plans.** Each plan shows the steps in order, the odds ("exact", "approximate", or a simulated estimate) and, when prices are available, the expected cost in Chaos and Divine Orbs. Plans are ranked by cost (or by chance, with the toggle). Open a plan to read its steps.
4. **Share it.** "Copy link to this plan" gives a link that opens the same item and plan.

The tool only gives advice. It never sends input to the game or reads game memory.

## Deploy

`.github/workflows/pages.yml` runs the Node tests and publishes `public/` to GitHub Pages on every push to `main`, and again after each hourly price update. To turn it on: repository Settings → Pages → Source: "GitHub Actions". The price workflow needs "Read and write permissions" for `GITHUB_TOKEN` (Settings → Actions → General) so it can commit `prices.json`.

## Run it locally

```bash
cd public
python3 -m http.server 8000
# open http://localhost:8000
```

The page has to be served over HTTP, because browsers block module scripts and `fetch` from `file://` pages.

## Without item text

Open "No item text? Build the item by hand" under the paste box. Pick a base type, item level and influences, then add mods from a searchable list (best tier first; you can relax tiers in step 2) and mark any fractured ones. "Use this item" continues as if you had pasted it.

## Shareable links

After "Find crafting plans", the address bar holds the base, item level, influences and wanted mods, and "Copy link to this plan" copies it. Opening the link fills in the item and runs the plan. The format is a plain `#` fragment with no escaping, which every static host (including GitHub Pages) serves as is:

```
#b=<base id>&i=<item level>&f=<influence>,<influence>&w=<mod id>[~<lowest acceptable tier id>],...&x=<fractured mod id>,...
#b=Metadata/Items/Rings/Ring12&i=85&w=IncreasedLife5~IncreasedLife3,ColdResist7
```

Ids are RePoE ids (letters, digits, `_` and `/`). A link made with older game data shows an error if an id no longer exists.

## Update the game data after a new league or patch

The app reads `public/data/poe1.json`, built from the community RePoE export, plus the hand-written files in `public/data/manual/`. Rebuild `poe1.json` like this:

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
  data/manual/         hand-written mechanics RePoE doesn't export (Harvest, eldritch, recombinator, league), with sources
  js/engine/data.js         loads the data (poe1.json + data/manual/*.json), compiles mod text into regexes
  js/engine/parse.js        parses Ctrl+C / Ctrl+Alt+C item text: mods, tiers, summed lines, eldritch implicits
  js/engine/pool.js         mod pools, spawn weights, tiers, bench options, the bench-slot rule, builder lists
  js/engine/assumptions.js  every mechanic the game data doesn't give (see "Assumptions" below)
  js/engine/exact.js        exact odds: reroll integral, alteration-route DP, unveil choices
  js/engine/sim.js          Monte Carlo core (used for 3+ wanted mods)
  js/engine/stage1.js       alteration stage 1 in closed form, plus a sampler of good magic items
  js/engine/annul.js        the annul-on-miss variant of the alteration route (simulated)
  js/engine/craft.js        the planner: builds every method and ranks them
  js/engine/cost.js         expected currency use and price of each method
  js/engine/steps.js        turns a method into step-by-step text
  js/engine/run.js          shared entry point (worker and main-thread fallback)
tools/build_data.py    turns the RePoE export into public/data/poe1.json
tools/fetch_prices.py  poe.ninja prices into public/data/prices.json (run by the hourly GitHub Action)
test/                  Node and Playwright checks
```

## How the odds are calculated

The engine uses the game's spawn weights, mod groups (an item can't have two mods from the same group), affix limits and item level.

- **Exact odds** (marked "exact") whenever the mod pool has the usual structure: every mod in one group, every group on one side, and every wanted mod met by a single group (`public/js/engine/exact.js`). That covers almost every item, with any number of wanted mods. Rolling mods one by one, with chance proportional to weight, works the same as giving each mod group a random "clock" and taking groups in the order their clocks ring. In that picture prefixes and suffixes are independent, so the chance comes from a one-dimensional integral that the engine computes numerically to about 1 part in a million. Bench crafts, essences, fossil-forced mods and fractured mods are included. The alteration route is worked out by going through every possible item, with interchangeable mods grouped together.
- **Simulation** for pools the exact method doesn't handle (for example a jewel mod group that can be a prefix or a suffix), and for the annul-on-miss comparison. The engine simulates the craft thousands of times and then spends extra time on the most promising methods. When an estimate rests on fewer than 30 successful simulations, the UI marks it as a "rough estimate".

The planner currently covers:

- Chaos Orb spam
- Essences: the lowest-tier essence that still gives the needed mod, including corrupted-only essences
- Fossils: the best combinations of 1 to 3 fossils, chosen by how much they raise the share of the wanted mods
- Alteration (+ Augmentation) → Regal → Exalted Orb, restarting the item when a slam misses, or annulling the miss (up to 1, 2 or 3 times per item, simulated) when prices say that's cheaper, also with "Cannot roll Attack/Caster Modifiers" crafted for the exalts when none of the missing mods have that tag
- Metacrafting in two stages: roll one side with the best reroll method, then "Prefixes (or Suffixes) Cannot Be Changed" + Chaos Orb until the other side is right
- Harvest (approximate, from hand-written data in `public/data/manual/harvest.json`): "Reforge ... including a <tag> modifier" for the tags of the wanted mods, and "Reforge keeping all Prefixes/Suffixes" as the second stage of a two-stage plan
- Influence: for one wanted influenced mod, roll the rest on a base without influence, then slam the matching influenced Exalted Orb (Crusader's, Hunter's, ..., Shaper's, Elder's). For a wanted influenced mod from each of two influences: one influenced Exalted Orb on each of two bases, then an Awakener's Orb
- Eldritch currency (`public/data/manual/eldritch.json`): reads the Searing Exarch / Eater of Worlds implicits and which one is dominant; two-stage plans with Eldritch Chaos Orbs rerolling the dominant side; the alteration route with Eldritch Exalted Orbs when the missing mods are all on one side; Orbs of Conflict in the steps when the dominance is the wrong way round
- Veiled mods (the `unveiled` mod domain): Veiled Chaos Orb then unveil, or Aisling on an item that has the rest, for one wanted unveiled mod; unveiling picks the mod from Jun's 3 options
- Recombinators (advanced, approximate; `public/data/manual/recombinator.json`): up to 2 prefixes and 2 suffixes split over two magic items, then a Recombinator that has to keep every pooled mod
- The league mechanic, from `public/data/manual/league.json` (tag reforges and keep-side reforges can be listed there). For 3.29 the file lists no crafts yet, because the rules couldn't be checked, and the page says so.
- Performance: a plan takes under about 2.5 seconds (`node test/perf.mjs` times every sample with all of its mods wanted). Whatever time is left after the first pass refines the simulated estimates.
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
- Eldritch Chaos Orbs reroll only the dominant side (Searing Exarch: prefixes, Eater of Worlds: suffixes), with the same mod-count rule as the side locks. Eldritch Exalted Orbs add only to the dominant side.
- `VEILED_PREFIX_CHANCE`, `UNVEIL_CHOICES`: a Veiled Chaos Orb's veiled mod is a prefix or a suffix with equal chance, and unveiling offers 3 mods, drawn by weight with no repeated mod group. No mod from the wanted unveiled mod's group may be on the item. Aisling is modelled on a full item, so the veiled mod takes the side of the removed mod.
- Recombinator: how many pooled mods per side the result keeps comes from a community-measured table. Exclusive mods and extra random mods aren't modelled. The input magic items must have only the wanted mods.
- On a fractured base, an Alteration keeps the fractured mod, and the plan augments whenever the open side comes out empty. So stage 1 always ends with the fractured mod plus one mod on the other side. Fractured mods can't be annulled.
- An Orb of Annulment removes one explicit mod chosen uniformly at random.
- Each new mod is picked with chance proportional to its spawn weight, among the mods that are still allowed (no mod from a group already on the item, and a free prefix or suffix slot).

`test/reference.mjs` checks that the simulator gives the exact answers that follow from these assumptions on a small made-up pool (Chaos, Alteration, Alteration + Augmentation, essence). It checks the maths, not the assumptions themselves.

### Not covered yet

Harvest crafts other than reforges, Eldritch Annulment (not planned), and beastcrafting.

## Prices

`.github/workflows/prices.yml` runs `tools/fetch_prices.py` every hour (and on demand). It fetches currency, essence, fossil and resonator prices from poe.ninja for the current challenge league, sending a descriptive User-Agent, and commits `public/data/prices.json`. Users' browsers never call poe.ninja; the page only reads that static file. If it's missing, the page ranks by chance.

With prices, every method shows its expected cost per finished item in Chaos and Divine Orbs, and the list is ranked by that cost (a toggle switches back to ranking by chance). Items with no price (Harvest lifeforce, Aisling, anything poe.ninja doesn't list) are shown as "unpriced", and those plans rank after fully priced ones.

```bash
python3 tools/fetch_prices.py public/data/prices.json                 # live (needs network access to poe.ninja)
python3 tools/fetch_prices.py /tmp/p.json --fixtures test/fixtures    # offline, from saved responses
```

## Tests

```bash
node test/run.mjs                 # parser on the sample items
node test/plan.mjs ring 0,3,5     # planner for chosen mods of a sample
node test/unit.mjs                # unit tests
node test/reference.mjs           # simulator against odds worked out by hand
NODE_PATH=$(npm root -g) node test/browser.cjs boots   # full UI run (needs Playwright and a server on :8765)
NODE_PATH=$(npm root -g) node test/browser.cjs builder # the manual item builder
NODE_PATH=$(npm root -g) node test/browser.cjs '#b=Metadata/Items/Rings/Ring12&i=85&w=IncreasedLife5'   # a share link
NODE_PATH=$(npm root -g) node test/a11y.cjs            # phone layout, control names, contrast, keyboard-only use
```

Fan-made tool. Not affiliated with or endorsed by Grinding Gear Games.
