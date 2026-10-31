// Crafting mechanics that aren't in the game data. Each one is listed under "Assumptions" in the README.

// Number of explicit mods a fresh rare roll gets (chaos / alchemy / essence / fossil).
// Community-measured values (also used by Craft of Exile): 4 mods 8/12, 5 mods 3/12, 6 mods 1/12.
export const RARE_COUNTS = [[4, 8 / 12], [5, 3 / 12], [6, 1 / 12]];
// Jewels: 3 or 4 mods (an estimate).
export const JEWEL_COUNTS = [[3, 8 / 12], [4, 4 / 12]];
// Share of alterations (and transmutations) that roll 2 mods instead of 1 (an estimate).
export const MAGIC_TWO_MOD_CHANCE = 0.5;

export function rareModCounts(base) {
  return base.cls === "Jewel" ? JEWEL_COUNTS : RARE_COUNTS;
}

// A Chaos Orb on an item with "Prefixes (or Suffixes) Cannot Be Changed" keeps that side and rolls new mods
// on the other side only. Assumed: the mod count is rolled as usual (RARE_COUNTS) and the kept mods count
// towards it, with at least this many new mods.
export const LOCKED_REROLL_MIN_NEW = 1;

// Awakener's Orb: the result keeps one influenced mod from each item and rolls the rest like a Chaos Orb, with the
// mod count rolled as usual (RARE_COUNTS) and the two kept mods counting towards it.

// Veiled Chaos Orb and Aisling: the veiled mod is a prefix or a suffix with equal chance (an estimate), and Jun
// offers this many unveiled mods to choose from, drawn by weight without repeating a mod group.
export const VEILED_PREFIX_CHANCE = 0.5;
export const UNVEIL_CHOICES = 3;
