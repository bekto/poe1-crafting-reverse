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
    ilvl: null, influences: [], flags: new Set(), implicitLines: [], enchantLines: [],
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
  if (!baseName && baseText) baseName = db.baseNamesSorted.find((n) => baseText.includes(n)) || null;
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
          lines: [],
        };
        continue;
      }
      if (PROPERTY_RE.test(rawLine) || WEAPON_TYPE_LINE.test(rawLine)) { currentBlock = null; continue; }
      const { text: t0, marker } = stripMarker(rawLine);
      const t = item.advanced ? cleanAdvancedLine(t0) : t0;
      if (currentBlock && !currentBlock.skip) {
        if (currentBlock.lines.length === 0) item.explicit.push({ block: currentBlock });
        currentBlock.lines.push(t);
        continue;
      }
      if (currentBlock && currentBlock.skip) {
        if (currentBlock.implicit || marker === "implicit") item.implicitLines.push(t);
        continue;
      }
      if (marker === "implicit") item.implicitLines.push(t);
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
  }
  item.errors = errors;
  return item;
}

/** Identifies explicit mods on a parsed item. Returns {mods:[...], unknown:[...]} */
export function identifyMods(db, item) {
  const base = item.base;
  const pool = basePool(db, base, item.influences, null, {
    allowEssenceOnly: true,
    extraMods: db.fossilAdded,
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
    for (const a of sol.assigned) result.mods.push(describe(a.mod, a.lines.map((i) => plainLines[i].text), plainLines[a.lines[0]]));
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

function assignLines(lines, pool, benchMods) {
  // candidate options per line
  const options = lines.map(() => []);
  const consider = (mod, crafted) => {
    // every template line must match some item line with the same crafted flag
    const perTpl = mod.tpl.map((tl) => {
      const hits = [];
      lines.forEach((l, i) => {
        if (!!l.crafted !== crafted) return;
        const r = matchLine(tl, l.text);
        if (r) hits.push({ i, inRange: r.inRange });
      });
      return hits;
    });
    if (perTpl.some((h) => h.length === 0)) return;
    // enumerate distinct line combos (small)
    const combos = [];
    const rec = (k, acc, inR) => {
      if (k === perTpl.length) { combos.push({ lines: [...acc], inRange: inR }); return; }
      for (const h of perTpl[k]) if (!acc.includes(h.i)) { acc.push(h.i); rec(k + 1, acc, inR + (h.inRange ? 1 : 0)); acc.pop(); }
    };
    rec(0, [], 0);
    for (const c of combos) {
      const opt = { mod, lines: c.lines, inRange: c.inRange };
      options[Math.min(...c.lines)].push(opt);
    }
  };
  for (const m of pool) consider(m, false);
  for (const m of benchMods) consider(m, true);

  let best = { score: -Infinity, assigned: [], unassigned: lines.map((_, i) => i) };
  const covered = new Array(lines.length).fill(false);
  const groups = new Set();
  const counts = { p: 0, s: 0 };
  const chosen = [];
  let steps = 0;
  const rec = (i, score) => {
    if (++steps > 200000) return;
    while (i < lines.length && covered[i]) i++;
    if (i >= lines.length) {
      const unassigned = lines.map((_, k) => k).filter((k) => !chosen.some((c) => c.lines.includes(k)));
      const s = score - unassigned.length * 100;
      if (s > best.score) best = { score: s, assigned: [...chosen], unassigned };
      return;
    }
    const opts = options[i]
      .filter((o) => o.lines.every((k) => !covered[k]))
      .sort((a, b) => b.inRange / b.lines.length - a.inRange / a.lines.length);
    for (const o of opts) {
      if (o.mod.gr.some((g) => groups.has(g))) continue;
      if (counts[o.mod.g] >= 3) continue;
      o.lines.forEach((k) => (covered[k] = true));
      o.mod.gr.forEach((g) => groups.add(g));
      counts[o.mod.g]++;
      chosen.push(o);
      // in-range lines are worth a lot, each extra mod costs a little (prefer simple mods over hybrids when equal)
      rec(i + 1, score + o.inRange * 10 + (o.inRange === o.lines.length ? 5 : -20) + 1);
      chosen.pop();
      counts[o.mod.g]--;
      o.mod.gr.forEach((g) => groups.delete(g));
      o.lines.forEach((k) => (covered[k] = false));
    }
    // allow leaving this line unidentified
    covered[i] = true;
    rec(i + 1, score);
    covered[i] = false;
  };
  rec(0, 0);
  return best;
}
