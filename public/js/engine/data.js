// Loads and indexes the compact game data produced by tools/build_data.py.

// mod groups of the crafting bench's meta crafts
export const META_GROUPS = {
  multimod: "ItemGenerationCanHaveMultipleCraftedMods",
  lockPrefixes: "ItemGenerationCannotChangePrefixes",
  lockSuffixes: "ItemGenerationCannotChangeSuffixes",
  noAttack: "ItemGenerationCannotRollAttackAffixes",
  noCaster: "ItemGenerationCannotRollCasterAffixes",
};

export const INFLUENCES = ["shaper", "elder", "crusader", "hunter", "redeemer", "warlord"];

// hand-written data under public/data/manual/ (mechanics RePoE doesn't export)
export const MANUAL_FILES = ["harvest", "eldritch"];

/** Loads poe1.json and the manual files. readJson(path relative to public/data/) returns a promise of JSON. */
export async function loadDb(readJson) {
  const [raw, ...manual] = await Promise.all(["poe1.json", ...MANUAL_FILES.map((f) => `manual/${f}.json`)].map(readJson));
  return indexData(raw, Object.fromEntries(MANUAL_FILES.map((f, i) => [f, manual[i]])));
}

export function indexData(raw, manual = {}) {
  const db = {
    version: raw.version,
    classes: raw.classes,
    bases: raw.bases,
    mods: raw.mods,
    implicits: raw.implicits,
    essences: raw.essences,
    fossils: raw.fossils,
    bench: raw.bench,
    modById: new Map(),
    basesByName: new Map(),
    classByDisplayName: new Map(),
    fossilAdded: new Set(),
    benchByClass: new Map(),
    manual,
  };
  for (const m of raw.mods) {
    m.tpl = compileTemplate(m.x);
    m.stKey = m.st.map((s) => s[0]).sort().join("|");
    db.modById.set(m.id, m);
  }
  for (const im of raw.implicits) im.tpl = compileTemplate(im.x);
  db.eldritch = (raw.eldritch || []).map((m) => ({ ...m, kind: m.k === "x" ? "exarch" : "eater", tpl: compileTemplate(m.x) }));
  for (const b of raw.bases) {
    if (!db.basesByName.has(b.name)) db.basesByName.set(b.name, []);
    db.basesByName.get(b.name).push(b);
  }
  for (const [id, c] of Object.entries(raw.classes)) db.classByDisplayName.set(c.name, id);
  for (const f of raw.fossils) for (const id of [...f.added, ...f.forced]) db.fossilAdded.add(id);
  for (const [modId, info] of Object.entries(raw.bench)) {
    for (const cls of info.classes) {
      if (!db.benchByClass.has(cls)) db.benchByClass.set(cls, []);
      db.benchByClass.get(cls).push({ mod: db.modById.get(modId), cost: info.cost, tier: info.tier });
    }
  }
  // bench meta crafts, found by mod group so a renamed mod id doesn't break them
  db.meta = {};
  for (const [key, group] of Object.entries(META_GROUPS)) {
    const id = Object.keys(raw.bench).find((mid) => db.modById.get(mid)?.gr.includes(group));
    if (id) db.meta[key] = { mod: db.modById.get(id), cost: raw.bench[id].cost };
  }
  // longest names first so "Two-Stone Ring" wins over "Ring" style substrings
  db.baseNamesSorted = [...db.basesByName.keys()].sort((a, b) => b.length - a.length);
  return db;
}

const NUM = "(-?\\d+(?:\\.\\d+)?)";
const RANGE_RE = /\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)/g;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Turns a mod text such as "Adds (5-7) to (11-13) Physical Damage" into one regex per
 * line plus the allowed [min,max] range of every number in that line.
 */
export function compileTemplate(text) {
  if (!text) return [];
  const lines = text.split("\n");
  // RePoE text for aura mods repeats the effect on a second line ("Nearby Enemies have -9% to X\n-9% to X"),
  // but the game shows only the first line
  const shown = lines.filter((l, i) => i === 0 || !lines[i - 1].endsWith(" " + l));
  return shown.map((line) => {
    const ranges = [];
    let re = "";
    let last = 0;
    // tokenise ranges "(a-b)" and plain numbers
    const tokenRe = /\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)|(-?\d+(?:\.\d+)?)/g;
    let m;
    while ((m = tokenRe.exec(line))) {
      re += escapeRe(line.slice(last, m.index));
      if (m[1] !== undefined) ranges.push([parseFloat(m[1]), parseFloat(m[2])]);
      else ranges.push([parseFloat(m[3]), parseFloat(m[3])]);
      re += NUM;
      last = m.index + m[0].length;
    }
    re += escapeRe(line.slice(last));
    return { re: new RegExp("^" + re + "$"), ranges, line };
  });
}

/** Returns {ok, values, inRange} for a single item line against one template line. */
export function matchLine(tplLine, text) {
  const m = tplLine.re.exec(text);
  if (!m) return null;
  const values = m.slice(1).map(parseFloat);
  let inRange = true;
  values.forEach((v, i) => {
    const [a, b] = tplLine.ranges[i];
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (v < lo - 1e-9 || v > hi + 1e-9) inRange = false;
  });
  return { values, inRange };
}

export { RANGE_RE };
