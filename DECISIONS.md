# Decisions

Choices made while working through the roadmap without asking. Newest last.

- **Jewels in the data.** RePoE puts jewel bases and jewel mods in the `misc` domain. `build_data.py` now keeps `misc` bases of class Jewel and their `misc` mods; bases carry `dom` and the pool only uses mods of the same domain. Cluster and abyss jewels stay out (different crafting rules).
- **Royale bases** (`...Royale...` ids) are dropped like Royale mods; they duplicated real base names such as Opal Ring.
- **Fuzzy base matching only for magic items.** Rare and normal items print the exact base name; only magic names wrap the base in affix names. Matching is on whole words, longest base name first.
- **Aura mods.** RePoE's text for mods like "Nearby Enemies have -9% to Fire Resistance" has a second line repeating the effect, which the game doesn't show. `compileTemplate` drops a line that is the tail of the previous line.
- **No git remote** is configured in this checkout, so work is committed on branch `claude/roadmap` but can't be pushed.
- **Summed Ctrl+C lines** are only split when no single mod can explain the value. When one mod fits (for example +180 life on a body armour), the parser picks the single mod even though a hybrid + smaller life mod could also produce it; Ctrl+Alt+C resolves that ambiguity and the UI suggests it.
