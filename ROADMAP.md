# Roadmap

Work top to bottom. Each item is done when its acceptance check passes, the tests are green, and it's committed.

## Phase 1: make what exists trustworthy
- [x] **Unit tests.** Create `test/unit.mjs` with no framework (node:assert). Cover the parser (Ctrl+C, Ctrl+Alt+C, magic, normal, influenced, fractured and synthesised items), tier tables, `satisfies`, and bench option lookup. *Check:* at least 25 assertions, all passing.
  - Notes: 22 tests / 95 assertions. Found and fixed: influence aura mods never matched (RePoE repeats the effect line), "Potato Ring" matched the Kalandra "Ring" base, jewel bases/mods (domain `misc`) and Royale bases were missing/extra in the data build.
- [x] **More sample items.** Add 10 or more realistic items to `public/js/samples.js`: a weapon, a body armour, a jewel, a shield, an influenced item, a fractured item, and a hybrid-mod item such as life plus armour. *Check:* every sample identifies all of its mods.
  - Notes: 10 new samples (foil, bow, wand, plate with hybrid, shield, belt, jewel, Hunter boots, fractured helmet, synthesised amulet); the menu is built from `LABELS`; `test/run.mjs` now fails on any unidentified line.
- [x] **Summed mod values.** In Ctrl+C text, a hybrid mod and a pure mod with the same stat show as one summed line. Detect this and split it into both mods. *Check:* a unit test with a hybrid life + armour mod combined with a life mod.
  - Notes: `assignLines` lets a line be explained by up to two mods whose ranges add up; only for lines no single mod explains, so normal items search as before. UI marks such mods "summed line"; new `summedplate` sample.
- [x] **Check the odds against known values.** Add `test/reference.mjs` with simple cases you can work out by hand: one specific mod from a chaos roll, an alteration hitting one mod, an essence plus one mod. Compare the simulation with the exact answer (tolerance 10%). Document the mod-count and alteration assumptions.
  - Notes: synthetic 6+6 equal-weight pool; chaos 53/144, alt 1/8, alt+aug 1/36, essence + suffix 31/99, all within 1-3%. Assumptions and their sources are in the README.
- [x] **Exact probabilities for small cases.** For one to two wanted mods, compute odds exactly, with no Monte Carlo noise. Use Monte Carlo only for larger cases.
  - Notes: `engine/exact.js`: exponential-clock integral for rerolls (chaos/essence/fossil, with bench and forced mods), memoised DP over weight classes for the alteration route. Matches brute force to ~1e-8 (`test/reference.mjs`); falls back to simulation for 3+ mods or groups spanning both sides.

## Phase 2: more crafting methods
- [x] **Multimod and metacrafting.** Add "Can have up to 3 Crafted Modifiers" (it uses a suffix), "Prefixes/Suffixes Cannot Be Changed" plus Scour or Chaos, and "Cannot Roll Attack/Caster Mods" with Exalts. Put bench costs in steps from `bench` data.
  - Notes: up to 2 bench crafts + multimod (exact and simulated), side lock + Chaos as a two-stage method, attack/caster block for the exalt stage; engine split into sim.js / craft.js / steps.js; meta crafts found by mod group in `db.meta`. 33 reference checks.
- [x] **Harvest reforges.** Add "Reforge with a guaranteed X modifier" for each tag and "Reforge keeping prefixes/suffixes". This data isn't in RePoE, so write `public/data/manual/harvest.json` with sources. Mark it as approximate in the UI.
  - Notes: 12 tag reforges (exact via a mixture over the guaranteed first mod, brute-force checked) and keep-prefixes/suffixes as a stage-2 option; `loadDb` loads `data/manual/*.json`. The wiki wasn't reachable, so costs are null and the multiplier is an assumption (DECISIONS).
- [x] **Annulment-aware alteration route.** When an exalt misses, compare annulling with starting over, and report the cheaper choice.
  - Notes: `engine/annul.js` simulates "annul a miss up to K times (K = 1..3), then start over" from the exact stage-1 distribution; starting over stays exact. With `opts.prices` the planner picks the cheaper option (prices arrive in Phase 3). The K = 0 case matches the exact route.
- [x] **Awakener's Orb and Conqueror's Exalts.** Plan for items with two influences, or mods that need an influence.
  - Notes: influenced Exalted Orb as stage 2 after rolling the rest on an uninfluenced base; Awakener plan (one influenced exalt per base, then awaken; rest from the awakened roll, exact when small). New two-influence sample. Influence of a mod is read from its spawn tags.
- [x] **Eldritch currency.** Eldritch implicits (Exarch/Eater), Eldritch Chaos, Exalted and Annulment orbs (prefix/suffix by dominance), and Orbs of Conflict. Requires parsing eldritch implicits.
  - Notes: build_data exports eldritch implicits (rank from the id); the parser reads them from Ctrl+C and Ctrl+Alt+C and works out dominance. New methods: Eldritch Chaos two-stage, Eldritch Exalt alteration route (brute-force checked); Conflict and Ember/Ichor in the steps. Eldritch Annulment isn't planned (see DECISIONS).
- [x] **Veiled mods.** Aisling slams and Veiled Chaos Orbs, using the `unveiled` mod domain.
  - Notes: unveiled mods in the data and the parser; Veiled Chaos Orb (exact rest-of-roll with a placeholder veiled slot and the target's group kept empty) and Aisling (two stages). Unveil odds exact as "the target is among Jun's 3 options". Impossible derived plans are now dropped.
- [x] **Recombinators.** Mark this as advanced and approximate if the mechanics aren't fully known.
  - Notes: `manual/recombinator.json` (community keep-count table, labelled approximate); the best split of up to 2+2 wanted mods over two magic inputs, with exact alteration odds for the inputs. Labelled "Advanced · approximate" in the UI.
- [x] **Fractured bases in the alteration route** (currently skipped).
  - Notes: with one fractured mod, stage 1 alters only the open side (exact, brute-force checked; simulator and annul variant updated). Two fractured mods still skip the route (nothing left to alter on a magic item).
- [x] **League mechanic.** Add the current league's crafting mechanic (3.29 Allflame now, 3.30 after Nov 13) once its rules are documented. Write `public/data/manual/league.json`.
  - Notes: `league.json` and a planner hook (tagReforge / keepSide crafts reuse the reforge engine, unit-tested with an injected craft). No 3.29 crafts are listed, because the rules couldn't be verified from here; the page says "not modelled yet". Fill it in for 3.30.

## Phase 3: cost and usability
- [x] **Prices.** A GitHub Action fetches poe.ninja hourly into `public/data/prices.json`. Show expected cost in Chaos and Divine Orbs per method, and rank by expected cost (keep "rank by chance" as a toggle).
  - Notes: `tools/fetch_prices.py` + `.github/workflows/prices.yml` (hourly, descriptive UA), tested on saved responses in `test/fixtures/`; `engine/cost.js` gives each method's expected currency use; the UI shows chaos/divine and a rank toggle. poe.ninja isn't reachable from this environment, so no live prices.json is committed (the Action creates it).
- [ ] **Manual item builder.** Pick a base, an item level and mods from searchable lists, for when you have no item text.
- [ ] **Shareable links.** Encode the base, item level and targets in `location.hash` (a plain `#` name format that the host allows; see the README).
- [ ] **Mobile layout pass and accessibility check** (keyboard navigation, labels, contrast).
- [ ] **Performance.** Keep plans under 5 seconds on a mid-range laptop. Consider a Rust/WebAssembly engine only if needed.

## Phase 4: release
- [ ] **3.30 data.** After November 13, once RePoE updates, rebuild `poe1.json`, run all tests and fix anything that broke.
- [ ] **GitHub Pages deploy workflow** and a short user guide in the README.
