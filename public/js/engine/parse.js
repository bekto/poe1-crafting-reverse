// Parses Path of Exile 1 item text (Ctrl+C or Ctrl+Alt+C) and identifies every explicit mod.
import { matchLine } from "./data.js";
import { basePool, tierTables } from "./pool.js";

const INFLUENCE_LINES = {
  "Shaper Item": "shaper", "Elder Item": "elder", "Crusader Item": "crusader",
  "Hunter Item": "hunter", "Redeemer Item": "redeemer", "Warlord Item": "warlord",
};
const FLAG_LINES = {
  Corrupted: "corrupted", Mirrored: "mirrored", "Fractured Item": "fractured",
  "Synthesised Item": "synthesised", "Split": "split", Unidentified: "unidentified",
  "Searing Exarch Item": "exarch", "Eater of Worlds Item": "eater",
};
const PROPERTY_RE = /^(Requirements|Level|Str|Dex|Int|Sockets|Item Level|Quality|Armour|Evasion Rating|Energy Shield|Ward|Physical Damage|Elemental Damage|Chaos Damage|Critical Strike Chance|Attacks per Second|Weapon Range|Chance to Block|Limited to|Radius|Stack Size|Note|Requires|Talisman Tier)\b/;
// usage hints the game prints under some items; never mods
const DESCRIPTION_RE = /^(Place into an allocated Jewel Socket|Right click to|Shift click to|Can be used in|Travel to this|Place an item|Can only be)/;
const WEAPON_TYPE_LINE = /^(Bow|Claw|Dagger|Rune Dagger|One Handed (Axe|Mace|Sword)|Two Handed (Axe|Mace|Sword)|Sceptre|Staff|Warstaff|Wand|Thrusting One Handed Sword|Fishing Rod)$/;

function cleanAdvancedLine(line) {
  return line
    .replace(/ — .*$/, "")
    .replace(/(-?\d+(?:\.\d+)?)\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)/g, "$1")
    .replace(/(-?\d+(?:\.\d+)?)\((-?\d+(?:\.\d+)?)\)/g, "$1")
    .trim();
}

function stripMarker(line) {
  const m = /^(.*?)\s*\((implicit|enchant|crafted|fractured|scourge|crucible)\)$/.exec(line);
  return m ? { text: m[1].trim(), marker: m[2] } : { text: line.trim(), marker: null };
}

export function parseItemText(db, rawText) {
  const text = rawText.replace(/\r/g, "").trim();
  const errors = [];
  if (!text) return { errors: ["Paste an item first."] };
  const sections = text.split(/\n-{4,}\n/).map((s) => s.split("\n").map((l) => l.trim()).filter(Boolean));
  const head = sections[0] || [];
  const item = {
    clsDisplay: null, cls: null, rarity: null, name: null, baseLine: null, base: null,
    ilvl: null, influences: [], flags: new Set(), implicitLines: [], implicitKinds: [], enchantLines: [],
    explicit: [], // {text, crafted, fractured, block?}
    advanced: false, unknownLines: [],
  };
  for (const l of head) {
    let m;
    if ((m = /^Item Class:\s*(.+)$/.exec(l))) item.clsDisplay = m[1];
    else if ((m = /^Rarity:\s*(.+)$/.exec(l))) item.rarity = m[1].toLowerCase();
    else if (!item.name) item.name = l;
    else item.baseLine = l;
  }
  if (!item.rarity) errors.push("This doesn't look like Path of Exile item text (no 'Rarity:' line).");
  if (item.rarity === "unique") errors.push("Unique items can't be crafted. Paste a rare or magic item.");
  if (item.clsDisplay) item.cls = db.classByDisplayName.get(item.clsDisplay) || null;
  if (item.clsDisplay && !item.cls) errors.push(`Item class "${item.clsDisplay}" isn't supported yet.`);

  // find the base
  let baseText = item.rarity === "rare" ? item.baseLine : item.name;
  if (item.rarity === "normal" || !item.baseLine) baseText = item.name;
  baseText = (baseText || "").replace(/^Superior\s+/, "").replace(/^Synthesised\s+/, "");
  let baseName = db.basesByName.has(baseText) ? baseText : null;
  // magic names wrap the base in an affix name ("Hale Onyx Amulet of the Whelpling"): look for it as whole words
  if (!baseName && baseText && item.rarity === "magic") {
    const padded = ` ${baseText} `;
    baseName = db.baseNamesSorted.find((n) => padded.includes(` ${n} `)) || null;
  }
  if (!baseName && errors.length === 0) errors.push(`Couldn't recognise the base type "${baseText}".`);

  // body sections
  let currentBlock = null;
  for (const sec of sections.slice(1)) {
    for (const rawLine of sec) {
      let m;
      if ((m = /^Item Level:\s*(\d+)/.exec(rawLine))) { item.ilvl = +m[1]; continue; }
      if (INFLUENCE_LINES[rawLine]) { item.influences.push(INFLUENCE_LINES[rawLine]); continue; }
      if (FLAG_LINES[rawLine]) { item.flags.add(FLAG_LINES[rawLine]); continue; }
      if (rawLine.startsWith("{")) {
        item.advanced = true;
        const h = /^\{\s*(.*?)(Prefix|Suffix|Implicit|Unique|Enchant)[^"}]*?Modifier(?:\s+"([^"]+)")?(?:\s*\((?:Tier|Rank):\s*(\d+)\))?/.exec(rawLine);
        if (!h) { currentBlock = { skip: true }; continue; }
        const pre = h[1] || "";
        const kind = h[2];
        currentBlock = {
          skip: kind !== "Prefix" && kind !== "Suffix",
          implicit: kind === "Implicit",
          side: kind === "Prefix" ? "p" : kind === "Suffix" ? "s" : null,
          name: h[3] || null,
          tier: h[4] ? +h[4] : null,
          crafted: /Master Crafted|Crafted/.test(pre),
          fractured: /Fractured/.test(pre),
          eldritch: /Searing Exarch/.test(pre) ? "exarch" : /Eater of Worlds/.test(pre) ? "eater" : null,
          lines: [],
        };
        continue;
      }
      if (PROPERTY_RE.test(rawLine) || WEAPON_TYPE_LINE.test(rawLine) || DESCRIPTION_RE.test(rawLine)) { currentBlock = null; continue; }
      const { text: t0, marker } = stripMarker(rawLine);
      const t = item.advanced ? cleanAdvancedLine(t0) : t0;
      if (currentBlock && !currentBlock.skip) {
        if (currentBlock.lines.length === 0) item.explicit.push({ block: currentBlock });
        currentBlock.lines.push(t);
        continue;
      }
      if (currentBlock && currentBlock.skip) {
        if (currentBlock.implicit || marker === "implicit") { item.implicitLines.push(t); item.implicitKinds.push(currentBlock.eldritch); }
        continue;
      }
      if (marker === "implicit") { item.implicitLines.push(t); item.implicitKinds.push(null); }
      else if (marker === "enchant" || marker === "scourge" || marker === "crucible") item.enchantLines.push(t);
      else item.explicit.push({ text: t, crafted: marker === "crafted", fractured: marker === "fractured" });
    }
  }
  if (item.ilvl === null && errors.length === 0) errors.push("No 'Item Level' line found. Copy the item from the game with Ctrl+C.");

  // choose base variant (some bases share a name but differ by implicit, e.g. Two-Stone Ring)
  if (baseName) {
    const variants = db.basesByName.get(baseName);
    let best = variants[0];
    if (variants.length > 1 && item.implicitLines.length) {
      for (const v of variants) {
        const ok = v.implicits.some((iid) => {
          const im = db.implicits.find((x) => x.id === iid);
          return im && im.tpl.some((tl) => item.implicitLines.some((l) => matchLine(tl, l)));
        });
        if (ok) { best = v; break; }
      }
    }
    item.base = best;
    item.eldritch = identifyEldritch(db, item);
  }
  item.errors = errors;
  return item;
}

/**
 * Finds the Searing Exarch and Eater of Worlds implicits among the implicit lines.
 * Returns {exarch: {mod, rank, line}|null, eater: ..., dominant: "exarch"|"eater"|null}.
 */
export function identifyEldritch(db, item) {
  const out = { exarch: null, eater: null, dominant: null };
  const tags = new Set(item.base.tags);
  const cands = db.eldritch.filter((m) => m.sw.some(([t]) => tags.has(t)));
  if (!cands.length) return out;
  const want = { exarch: item.flags.has("exarch"), eater: item.flags.has("eater") };
  item.implicitLines.forEach((line, i) => {
    const hinted = item.implicitKinds[i];
    for (const kind of hinted ? [hinted] : ["exarch", "eater"]) {
      if (out[kind]) continue;
      if (!hinted && !want[kind] && (want.exarch || want.eater)) continue;
      const m = cands.find((c) => c.kind === kind && c.tpl.length === 1 && matchLine(c.tpl[0], line)?.inRange);
      if (m) { out[kind] = { mod: m, rank: m.r, line }; break; }
    }
  });
  if (out.exarch && out.eater && out.exarch.rank !== out.eater.rank) out.dominant = out.exarch.rank > out.eater.rank ? "exarch" : "eater";
  else if (out.exarch && !out.eater) out.dominant = "exarch";
  else if (out.eater && !out.exarch) out.dominant = "eater";
  return out;
}

/** Identifies explicit mods on a parsed item. Returns {mods:[...], unknown:[...]} */
export function identifyMods(db, item) {
  const base = item.base;
  const pool = basePool(db, base, item.influences, null, {
    allowEssenceOnly: true,
    extraMods: db.fossilAdded,
    unveiled: true,
  }).map((x) => x.mod);
  const benchMods = (db.benchByClass.get(base.cls) || []).map((o) => o.mod).filter(Boolean);
  const { tierOf } = tierTables(db, base, item.influences);
  const result = { mods: [], unknown: [] };

  const describe = (mod, lines, flags) => ({
    mod,
    lines,
    side: mod.g,
    crafted: mod.d === "c" || !!flags.crafted,
    fractured: !!flags.fractured,
    tier: tierOf.get(mod.id)?.tier ?? null,
    tierCount: tierOf.get(mod.id)?.of ?? null,
    essenceOnly: !!mod.e,
    unveiled: mod.d === "u",
  });

  // --- advanced (Ctrl+Alt+C) blocks: header gives side and mod name
  const plainLines = [];
  for (const e of item.explicit) {
    if (!e.block) { plainLines.push(e); continue; }
    const b = e.block;
    const sideMods = (b.crafted ? benchMods : pool).filter((m) => m.g === b.side);
    let best = null, bestScore = 0;
    // prefer mods with the exact name from the header, fall back to text-only matching
    for (const cands of [sideMods.filter((m) => b.name && m.n === b.name), sideMods]) {
      for (const m of cands) {
        const s = scoreMultiLine(m, b.lines);
        if (s > bestScore) { bestScore = s; best = m; }
      }
      if (best) break;
    }
    if (best && bestScore > 0) result.mods.push(describe(best, b.lines, b));
    else result.unknown.push(...b.lines);
  }

  // --- plain (Ctrl+C) lines: search for the best assignment of lines to mods
  if (plainLines.length) {
    const sol = assignLines(plainLines, pool, benchMods);
    result.searchSteps = sol.steps;
    for (const a of sol.assigned) {
      const d = describe(a.mod, a.lines.map((i) => plainLines[i].text), plainLines[a.lines[0]]);
      if (a.summed) d.summed = true; // shares a summed Ctrl+C line with another mod
      result.mods.push(d);
    }
    for (const i of sol.unassigned) result.unknown.push(plainLines[i].text);
  }
  // prefixes first, then suffixes
  result.mods.sort((a, b) => (a.side === b.side ? 0 : a.side === "p" ? -1 : 1));
  return result;
}

/** Score how well all template lines of a mod match a list of item lines (2 per in-range line, 1 per out-of-range). */
function scoreMultiLine(mod, lines) {
  if (mod.tpl.length !== lines.length) return 0;
  let score = 0;
  const used = new Set();
  for (const tl of mod.tpl) {
    let got = 0, gotIdx = -1;
    lines.forEach((l, i) => {
      if (used.has(i)) return;
      const r = matchLine(tl, l);
      if (r) { const s = r.inRange ? 2 : 1; if (s > got) { got = s; gotIdx = i; } }
    });
    if (!got) return 0;
    used.add(gotIdx);
    score += got;
  }
  return score;
}

// Score weights for assignLines. A line explained by two mods is only chosen when one mod can't explain it.
const SCORE_LINE_IN_RANGE = 10;
const SCORE_UNASSIGNED = -100;
const SCORE_SHARED_LINE = -8;
const SCORE_MOD = 1; // a small bonus per mod: prefer two simple mods over one hybrid when both fit
const SCORE_MOD_IN_RANGE = 5;
const SCORE_MOD_OUT_OF_RANGE = -20;
const MAX_LINE_CONTRIBUTORS = 2;

/**
 * Finds the best assignment of Ctrl+C lines to mods. In Ctrl+C text the game sums identical stat lines,
 * so "+(34-38) to maximum Life" from a hybrid and "+(175-189) to maximum Life" from a pure life mod show as
 * one line; a line may therefore be explained by up to two mods whose ranges add up to its value.
 */
function assignLines(lines, pool, benchMods) {
  const values = lines.map(() => null);
  const optsByLine = lines.map(() => []);
  const consider = (mod, crafted) => {
    // every template line must match some item line (same text, any value) with the same crafted flag
    const perTpl = mod.tpl.map((tl) => {
      const hits = [];
      lines.forEach((l, i) => {
        if (!!l.crafted !== crafted) return;
        const r = matchLine(tl, l.text);
        if (r) { hits.push(i); values[i] = r.values; }
      });
      return hits;
    });
    if (perTpl.some((h) => h.length === 0)) return;
    const rec = (k, acc) => {
      if (k === perTpl.length) {
        const opt = { mod, lines: [...acc] };
        // a single mod that explains all its lines on its own is tried first
        opt.alone = opt.lines.every((li, t) => rangeOk(values[li], [mod.tpl[t].ranges]));
        for (const li of opt.lines) optsByLine[li].push(opt);
        return;
      }
      for (const i of perTpl[k]) if (!acc.includes(i)) { acc.push(i); rec(k + 1, acc); acc.pop(); }
    };
    rec(0, []);
  };
  for (const m of pool) consider(m, false);
  for (const m of benchMods) consider(m, true);
  for (const opts of optsByLine) opts.sort((a, b) => b.alone - a.alone || a.lines.length - b.lines.length);
  // a line can only be a summed line if no single mod explains it
  const needy = optsByLine.map((opts) => !opts.some((o) => o.alone));

  const contrib = lines.map(() => []); // per line: template ranges of the mods explaining it
  const accepted = new Array(lines.length).fill(false);
  const stateOf = (i) => (contrib[i].length ? lineState(values[i], contrib[i]) : "empty");
  const groups = new Set();
  const counts = { p: 0, s: 0 };
  const chosen = [];
  let best = { score: -Infinity, assigned: [], unassigned: lines.map((_, i) => i) };
  let steps = 0;

  const evaluate = () => {
    let score = 0;
    const ok = lines.map((_, i) => stateOf(i) === "ok");
    lines.forEach((_, i) => {
      if (!contrib[i].length) score += SCORE_UNASSIGNED;
      else {
        if (ok[i]) score += SCORE_LINE_IN_RANGE;
        if (contrib[i].length > 1) score += SCORE_SHARED_LINE;
      }
    });
    for (const o of chosen) score += SCORE_MOD + (o.lines.every((k) => ok[k]) ? SCORE_MOD_IN_RANGE : SCORE_MOD_OUT_OF_RANGE);
    if (score > best.score) {
      best = {
        score,
        assigned: chosen.map((o) => ({ mod: o.mod, lines: o.lines, summed: o.lines.some((k) => contrib[k].length > 1) })),
        unassigned: lines.map((_, k) => k).filter((k) => !contrib[k].length),
      };
    }
  };
  const legal = (o) =>
    !o.mod.gr.some((g) => groups.has(g)) && counts[o.mod.g] < 3 && !chosen.includes(o) &&
    !o.lines.some((k) => contrib[k].length >= MAX_LINE_CONTRIBUTORS);
  const place = (o) => {
    o.lines.forEach((k, t) => contrib[k].push(o.mod.tpl[t].ranges));
    o.mod.gr.forEach((g) => groups.add(g));
    counts[o.mod.g]++;
    chosen.push(o);
  };
  const unplace = (o) => {
    chosen.pop();
    counts[o.mod.g]--;
    o.mod.gr.forEach((g) => groups.delete(g));
    o.lines.forEach((k) => contrib[k].pop());
  };
  const rec = () => {
    if (++steps > 200000) return;
    let i = 0;
    while (i < lines.length && (accepted[i] || ["ok", "bad"].includes(stateOf(i)))) i++;
    if (i >= lines.length) { evaluate(); return; }
    // only try mods that leave every line in range or fixable by one more mod; if none does
    // (an old item with legacy ranges), fall back to every mod that matches the text
    let tried = 0;
    for (const strict of [true, false]) {
      if (!strict && (tried || contrib[i].length)) break;
      for (const o of optsByLine[i]) {
        if (!legal(o)) continue;
        place(o);
        if (!strict || o.lines.every((k) => { const st = stateOf(k); return st === "ok" || (st === "more" && needy[k]); })) { tried++; rec(); }
        unplace(o);
      }
    }
    // or leave this line as it is (unidentified, or out of range)
    accepted[i] = true;
    rec();
    accepted[i] = false;
  };
  rec();
  best.steps = steps;
  return best;
}

/**
 * "ok" when every number of the line is within the summed ranges of the mods explaining it, "more" when
 * one more mod of the same stat could make it fit (the value is past the far end), otherwise "bad".
 */
function lineState(vals, rangeLists) {
  if (!vals) return "bad";
  let state = "ok";
  for (let n = 0; n < vals.length; n++) {
    let lo = 0, hi = 0;
    for (const ranges of rangeLists) {
      const r = ranges[n];
      if (!r) return "bad";
      lo += Math.min(r[0], r[1]);
      hi += Math.max(r[0], r[1]);
    }
    const v = vals[n];
    if (v >= lo - 1e-9 && v <= hi + 1e-9) continue;
    const grows = hi > 0 ? v > hi : v < lo; // adding a mod pushes the sum further from zero
    if (!grows || rangeLists.length >= MAX_LINE_CONTRIBUTORS) return "bad";
    state = "more";
  }
  return state;
}

/** Is every number of a line within the summed ranges of the templates that explain it? */
function rangeOk(vals, rangeLists) {
  if (!vals) return false;
  return vals.every((v, n) => {
    let lo = 0, hi = 0;
    for (const ranges of rangeLists) {
      const r = ranges[n];
      if (!r) return false;
      lo += Math.min(r[0], r[1]);
      hi += Math.max(r[0], r[1]);
    }
    return v >= lo - 1e-9 && v <= hi + 1e-9;
  });
}
