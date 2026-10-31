# Roadmap

Work top to bottom. Each item is done when its acceptance check passes, the tests are green, and it's committed.

## Phase 1: make what exists trustworthy
- [x] **Unit tests.** Create `test/unit.mjs` with no framework (node:assert). Cover the parser (Ctrl+C, Ctrl+Alt+C, magic, normal, influenced, fractured and synthesised items), tier tables, `satisfies`, and bench option lookup. *Check:* at least 25 assertions, all passing.
  - Notes: 22 tests / 95 assertions. Found and fixed: influence aura mods never matched (RePoE repeats the effect line), "Potato Ring" matched the Kalandra "Ring" base, jewel bases/mods (domain `misc`) and Royale bases were missing/extra in the data build.
- [ ] **More sample items.** Add 10 or more realistic items to `public/js/samples.js`: a weapon, a body armour, a jewel, a shield, an influenced item, a fractured item, and a hybrid-mod item such as life plus armour. *Check:* every sample identifies all of its mods.
- [ ] **Summed mod values.** In Ctrl+C text, a hybrid mod and a pure mod with the same stat show as one summed line. Detect this and split it into both mods. *Check:* a unit test with a hybrid life + armour mod combined with a life mod.
- [ ] **Check the odds against known values.** Add `test/reference.mjs` with simple cases you can work out by hand: one specific mod from a chaos roll, an alteration hitting one mod, an essence plus one mod. Compare the simulation with the exact answer (tolerance 10%). Document the mod-count and alteration assumptions.
- [ ] **Exact probabilities for small cases.** For one to two wanted mods, compute odds exactly, with no Monte Carlo noise. Use Monte Carlo only for larger cases.

## Phase 2: more crafting methods
- [ ] **Multimod and metacrafting.** Add "Can have up to 3 Crafted Modifiers" (it uses a suffix), "Prefixes/Suffixes Cannot Be Changed" plus Scour or Chaos, and "Cannot Roll Attack/Caster Mods" with Exalts. Put bench costs in steps from `bench` data.
- [ ] **Harvest reforges.** Add "Reforge with a guaranteed X modifier" for each tag and "Reforge keeping prefixes/suffixes". This data isn't in RePoE, so write `public/data/manual/harvest.json` with sources. Mark it as approximate in the UI.
- [ ] **Annulment-aware alteration route.** When an exalt misses, compare annulling with starting over, and report the cheaper choice.
- [ ] **Awakener's Orb and Conqueror's Exalts.** Plan for items with two influences, or mods that need an influence.
- [ ] **Eldritch currency.** Eldritch implicits (Exarch/Eater), Eldritch Chaos, Exalted and Annulment orbs (prefix/suffix by dominance), and Orbs of Conflict. Requires parsing eldritch implicits.
- [ ] **Veiled mods.** Aisling slams and Veiled Chaos Orbs, using the `unveiled` mod domain.
- [ ] **Recombinators.** Mark this as advanced and approximate if the mechanics aren't fully known.
- [ ] **Fractured bases in the alteration route** (currently skipped).
- [ ] **League mechanic.** Add the current league's crafting mechanic (3.29 Allflame now, 3.30 after Nov 13) once its rules are documented. Write `public/data/manual/league.json`.

## Phase 3: cost and usability
- [ ] **Prices.** A GitHub Action fetches poe.ninja hourly into `public/data/prices.json`. Show expected cost in Chaos and Divine Orbs per method, and rank by expected cost (keep "rank by chance" as a toggle).
- [ ] **Manual item builder.** Pick a base, an item level and mods from searchable lists, for when you have no item text.
- [ ] **Shareable links.** Encode the base, item level and targets in `location.hash` (a plain `#` name format that the host allows; see the README).
- [ ] **Mobile layout pass and accessibility check** (keyboard navigation, labels, contrast).
- [ ] **Performance.** Keep plans under 5 seconds on a mid-range laptop. Consider a Rust/WebAssembly engine only if needed.

## Phase 4: release
- [ ] **3.30 data.** After November 13, once RePoE updates, rebuild `poe1.json`, run all tests and fix anything that broke.
- [ ] **GitHub Pages deploy workflow** and a short user guide in the README.
