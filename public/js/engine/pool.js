// Mod pools, weights and tiers for a given base item.

/** Tags an item carries: base tags plus influence tags (e.g. ring_shaper). */
export function itemTags(db, base, influences = []) {
  const tags = new Set(base.tags);
  const infl = db.classes[base.cls]?.influence || {};
  for (const i of influences) if (infl[i]) tags.add(infl[i]);
  return tags;
}

/** PoE rule: the first spawn-weight entry whose tag the item has decides the weight. */
export function firstWeight(list, tags) {
  for (const [tag, w] of list) if (tags.has(tag)) return w;
  return null;
}

export function spawnWeight(mod, tags) {
  const w = firstWeight(mod.sw, tags) ?? 0;
  if (w <= 0) return 0;
  const g = firstWeight(mod.gw, tags);
  return g === null ? w : (w * g) / 100;
}

export function maxAffixes(base, rarity = "rare") {
  const jewel = base.cls === "Jewel";
  if (rarity === "magic") return { p: 1, s: 1 };
  return jewel ? { p: 2, s: 2 } : { p: 3, s: 3 };
}

/**
 * All mods that can roll on this base by normal means (chaos/alch/exalt), ignoring item level
 * when ilvl is null. Each entry: {mod, w}.
 */
export function basePool(db, base, influences, ilvl = null, opts = {}) {
  const tags = itemTags(db, base, influences);
  const dom = base.dom || "i";
  const out = [];
  for (const mod of db.mods) {
    if (mod.d !== dom || (mod.g !== "p" && mod.g !== "s")) continue;
    if (mod.e && !opts.allowEssenceOnly) continue;
    if (db.fossilAdded.has(mod.id) && !(opts.extraMods && opts.extraMods.has(mod.id))) continue;
    if (ilvl !== null && mod.l > ilvl) continue;
    const w = spawnWeight(mod, tags);
    if (w > 0) out.push({ mod, w });
  }
  return out;
}

/**
 * Tier tables: for every mod type on this base, mods sorted best first (T1 = highest
 * required level). Returns Map(modId -> {tier, of, family}) and Map(familyKey -> [mods]).
 */
export function tierTables(db, base, influences) {
  const pool = basePool(db, base, influences, null);
  const fam = new Map();
  for (const { mod } of pool) {
    const key = mod.g + ":" + (mod.ty || mod.gr.join(","));
    if (!fam.has(key)) fam.set(key, []);
    fam.get(key).push(mod);
  }
  const tierOf = new Map();
  for (const [key, list] of fam) {
    list.sort((a, b) => b.l - a.l || (b.st[0]?.[1] ?? 0) - (a.st[0]?.[1] ?? 0));
    list.forEach((m, i) => tierOf.set(m.id, { tier: i + 1, of: list.length, family: key }));
  }
  return { tierOf, families: fam };
}

/** Does mod `m` meet target `t` (same stats, every stat at least as good as the target tier)? */
export function satisfies(m, target) {
  if (m.stKey !== target.stKey) return false;
  for (const [id, min] of target.minStats) {
    const s = m.st.find((x) => x[0] === id);
    if (!s) return false;
    // compare on the "better" end; negative-valued stats (reductions) compare reversed
    if (min >= 0 ? s[1] < min - 1e-9 : s[1] > min + 1e-9) return false;
  }
  return true;
}

/** Builds a crafting target from a mod: "this mod type at this tier or better". */
export function makeTarget(mod, extra = {}) {
  return {
    mod,
    side: mod.g,
    stKey: mod.stKey,
    groups: mod.gr,
    minStats: mod.st.map((s) => [s[0], s[1]]),
    ...extra,
  };
}

/** Bench options for this item class that satisfy the target. */
export function benchOptionsFor(db, base, target) {
  const list = db.benchByClass.get(base.cls) || [];
  return list.filter((o) => o.mod && o.mod.g === target.side && satisfies(o.mod, target));
}
