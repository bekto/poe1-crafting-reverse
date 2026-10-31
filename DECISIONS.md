# Decisions

Choices made while working through the roadmap without asking. Newest last.

- **Jewels in the data.** RePoE puts jewel bases and jewel mods in the `misc` domain. `build_data.py` now keeps `misc` bases of class Jewel and their `misc` mods; bases carry `dom` and the pool only uses mods of the same domain. Cluster and abyss jewels stay out (different crafting rules).
- **Royale bases** (`...Royale...` ids) are dropped like Royale mods; they duplicated real base names such as Opal Ring.
- **Fuzzy base matching only for magic items.** Rare and normal items print the exact base name; only magic names wrap the base in affix names. Matching is on whole words, longest base name first.
- **Aura mods.** RePoE's text for mods like "Nearby Enemies have -9% to Fire Resistance" has a second line repeating the effect, which the game doesn't show. `compileTemplate` drops a line that is the tail of the previous line.
- **No git remote** is configured in this checkout, so work is committed on branch `claude/roadmap` but can't be pushed.
- **Summed Ctrl+C lines** are only split when no single mod can explain the value. When one mod fits (for example +180 life on a body armour), the parser picks the single mod even though a hybrid + smaller life mod could also produce it; Ctrl+Alt+C resolves that ambiguity and the UI suggests it.
- **"Exact" means numerically exact.** Reroll odds come from a one-dimensional integral on a log-time grid (step 0.04, about 1e-7 relative error against brute force). That is far below any other uncertainty, and the result is the same every run.
- **Exact-method fallbacks.** The exact engine needs every mod to belong to one group, every group to sit on one side, and every target to be met by mods of a single group. Otherwise it returns null and the planner simulates. This happens today only for one jewel group that has both prefix and suffix mods.
- **Shared constants.** The mod-count and alteration assumptions moved to `engine/assumptions.js` so the simulator and the exact engine use the same values.
