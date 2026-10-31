// Unit tests, no framework: node test/unit.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { indexData, compileTemplate, matchLine } from "../public/js/engine/data.js";
import { parseItemText, identifyMods } from "../public/js/engine/parse.js";
import { tierTables, satisfies, makeTarget, benchOptionsFor, basePool, spawnWeight, itemTags, firstWeight } from "../public/js/engine/pool.js";

const db = indexData(JSON.parse(fs.readFileSync(new URL("../public/data/poe1.json", import.meta.url))));

let assertions = 0, failed = 0;
const tests = [];
// counting wrappers around node:assert
const ok = (v, msg) => { assertions++; assert.ok(v, msg); };
const eq = (a, b, msg) => { assertions++; assert.equal(a, b, msg); };
const deq = (a, b, msg) => { assertions++; assert.deepEqual(a, b, msg); };
const near = (a, b, tol, msg) => { assertions++; assert.ok(Math.abs(a - b) <= tol, `${msg || ""} expected ${b} ± ${tol}, got ${a}`); };
export function test(name, fn) { tests.push({ name, fn }); }

const parse = (text) => {
  const item = parseItemText(db, text);
  const ident = item.errors.length ? null : identifyMods(db, item);
  return { item, ident, ids: ident ? ident.mods.map((m) => m.mod.id) : [] };
};
const modsWith = (ident, re) => ident.mods.filter((m) => re.test(m.mod.x));

// ------------------------------------------------------------------ templates
test("compileTemplate turns ranges into regexes", () => {
  const [t] = compileTemplate("+(70-84) to maximum Life");
  ok(t.re.test("+74 to maximum Life"));
  deq(t.ranges, [[70, 84]]);
  const r = matchLine(t, "+74 to maximum Life");
  deq(r.values, [74]);
  eq(r.inRange, true);
  eq(matchLine(t, "+90 to maximum Life").inRange, false, "out of range still matches the text");
  eq(matchLine(t, "+74 to maximum Mana"), null);
});

test("compileTemplate handles multi-line and negative ranges", () => {
  const tpl = compileTemplate("Adds (5-7) to (11-13) Physical Damage\n(-10--5)% reduced Thing");
  eq(tpl.length, 2);
  ok(matchLine(tpl[0], "Adds 6 to 12 Physical Damage").inRange);
  ok(matchLine(tpl[1], "-7% reduced Thing").inRange);
});

// ------------------------------------------------------------------ parser
const RING_CTRL_C = `Item Class: Rings
Rarity: Rare
Storm Loop
Two-Stone Ring
--------
Requirements:
Level: 64
--------
Item Level: 85
--------
+14% to Fire and Lightning Resistances (implicit)
--------
+74 to maximum Life
Adds 8 to 16 Physical Damage to Attacks
+44% to Cold Resistance
+41% to Lightning Resistance
+47 to Intelligence
+25 to maximum Energy Shield (crafted)`;

test("Ctrl+C rare: base, item level, rarity and all mods", () => {
  const { item, ident, ids } = parse(RING_CTRL_C);
  deq(item.errors, []);
  eq(item.rarity, "rare");
  eq(item.name, "Storm Loop");
  eq(item.base.name, "Two-Stone Ring");
  eq(item.ilvl, 85);
  eq(item.advanced, false);
  eq(ident.unknown.length, 0);
  eq(ident.mods.length, 6);
  ok(ids.includes("IncreasedLife5"));
  ok(ids.includes("ColdResist7"));
  const crafted = ident.mods.filter((m) => m.crafted);
  eq(crafted.length, 1, "one crafted mod");
  eq(crafted[0].mod.d, "c");
  deq(item.implicitLines, ["+14% to Fire and Lightning Resistances"]);
});

test("Two-Stone Ring variant is chosen by its implicit", () => {
  const { item } = parse(RING_CTRL_C);
  const variants = db.basesByName.get("Two-Stone Ring");
  ok(variants.length >= 3, "there are several Two-Stone Ring bases");
  const im = db.implicits.find((x) => x.id === item.base.implicits[0]);
  ok(/Fire and Lightning/.test(im.x), "picked the fire/lightning variant");
});

test("prefixes are listed before suffixes", () => {
  const { ident } = parse(RING_CTRL_C);
  const sides = ident.mods.map((m) => m.side).join("");
  ok(/^p*s*$/.test(sides), sides);
});

const BOOTS_ADV = `Item Class: Boots
Rarity: Rare
Gale Stride
Two-Toned Boots
--------
Evasion Rating: 120
Energy Shield: 25
--------
Requirements:
Level: 70
--------
Item Level: 86
--------
+12% to Fire and Lightning Resistances (implicit)
--------
{ Prefix Modifier "Rotund" (Tier: 2) — Life }
+95(85-99) to maximum Life
{ Prefix Modifier "Cheetah's" (Tier: 1) — Speed }
30% increased Movement Speed
{ Suffix Modifier "of Haast" (Tier: 1) — Elemental, Cold, Resistance }
+46(46-48)% to Cold Resistance
{ Master Crafted Suffix Modifier "of Craft" (Rank: 3) — Elemental, Fire, Chaos, Resistance }
+14(13-15)% to Fire and Chaos Resistances (crafted)`;

test("Ctrl+Alt+C rare: header blocks give side, name and crafted flag", () => {
  const { item, ident } = parse(BOOTS_ADV);
  eq(item.advanced, true);
  eq(item.ilvl, 86);
  eq(ident.unknown.length, 0);
  eq(ident.mods.length, 4);
  const life = ident.mods.find((m) => m.mod.n === "Rotund");
  ok(life, "Rotund found");
  eq(life.side, "p");
  deq(life.lines, ["+95 to maximum Life"], "advanced ranges are stripped");
  const craft = ident.mods.find((m) => m.crafted);
  eq(craft.side, "s");
  eq(craft.mod.d, "c");
});

test("magic item: base comes from the affixed name", () => {
  const { item, ident } = parse(`Item Class: Amulets
Rarity: Magic
Hale Onyx Amulet of the Whelpling
--------
Item Level: 40
--------
+12 to all Attributes (implicit)
--------
+20 to maximum Life
+10% to Fire Resistance`);
  deq(item.errors, []);
  eq(item.rarity, "magic");
  eq(item.base.name, "Onyx Amulet");
  eq(ident.mods.length, 2);
  deq(ident.mods.map((m) => m.mod.n), ["Healthy", "of the Whelpling"]);
});

test("normal item: no explicit mods, implicit picks the base variant", () => {
  const { item, ident } = parse(`Item Class: Rings
Rarity: Normal
Two-Stone Ring
--------
Requirements:
Level: 20
--------
Item Level: 80
--------
+14% to Cold and Lightning Resistances (implicit)`);
  deq(item.errors, []);
  eq(item.rarity, "normal");
  eq(ident.mods.length, 0);
  const im = db.implicits.find((x) => x.id === item.base.implicits[0]);
  ok(/Cold and Lightning/.test(im.x), im.x);
});

test("influenced item: influence lines are read and enable influence mods", () => {
  const { item, ident } = parse(`Item Class: Helmets
Rarity: Rare
Doom Crown
Royal Burgonet
--------
Armour: 500
--------
Item Level: 86
--------
+90 to maximum Life
+40% to Fire Resistance
Nearby Enemies have -9% to Lightning Resistance
--------
Crusader Item
Hunter Item`);
  deq(item.errors, []);
  deq(item.influences, ["crusader", "hunter"]);
  eq(ident.unknown.length, 0, ident.unknown.join(";"));
  const infl = modsWith(ident, /Nearby Enemies have/);
  eq(infl.length, 1, "influence mod identified");
  // without the influence the same mod can't be found
  const noInfl = parseItemText(db, BOOTS_ADV);
  ok(!basePool(db, noInfl.base, []).some((e) => e.mod.id === infl[0].mod.id));
});

test("fractured item: the fractured mod is flagged", () => {
  const { item, ident } = parse(`Item Class: Rings
Rarity: Rare
Grim Coil
Two-Stone Ring
--------
Item Level: 84
--------
+15% to Cold and Lightning Resistances (implicit)
--------
+72 to maximum Life (fractured)
+42% to Fire Resistance
+30 to Strength
--------
Fractured Item`);
  deq(item.errors, []);
  ok(item.flags.has("fractured"));
  const fr = ident.mods.filter((m) => m.fractured);
  eq(fr.length, 1);
  ok(/maximum Life/.test(fr[0].mod.x));
  eq(ident.unknown.length, 0);
});

test("synthesised item: prefix is stripped from the base and the flag is set", () => {
  const { item, ident } = parse(`Item Class: Amulets
Rarity: Magic
Synthesised Onyx Amulet of the Whelpling
--------
Item Level: 75
--------
10% increased maximum Life (implicit)
--------
+10% to Fire Resistance
--------
Synthesised Item`);
  deq(item.errors, []);
  ok(item.flags.has("synthesised"));
  eq(item.base.name, "Onyx Amulet");
  eq(ident.mods.length, 1);
  deq(item.implicitLines, ["10% increased maximum Life"]);
});

test("parser errors: empty, not an item, unique, unknown base", () => {
  deq(parseItemText(db, "  ").errors, ["Paste an item first."]);
  ok(parseItemText(db, "hello world").errors[0].includes("Rarity"));
  ok(parseItemText(db, "Item Class: Rings\nRarity: Unique\nX\nTwo-Stone Ring\n--------\nItem Level: 80").errors.some((e) => /Unique/.test(e)));
  ok(parseItemText(db, "Item Class: Rings\nRarity: Rare\nX\nPotato Ring\n--------\nItem Level: 80").errors.some((e) => /base type/.test(e)));
});

test("unknown lines are reported, not silently dropped", () => {
  const { ident } = parse(RING_CTRL_C + "\nThis line is not a mod");
  deq(ident.unknown, ["This line is not a mod"]);
});

test("jewels: base is found and jewel-only mods are identified", () => {
  const { item, ident } = parse(`Item Class: Jewels
Rarity: Rare
Dread Spark
Cobalt Jewel
--------
Item Level: 84
--------
7% increased maximum Life
+12% to Cold Resistance
15% increased Spell Damage
--------
Place into an allocated Jewel Socket on the Passive Skill Tree. Right click to remove from the Socket.`);
  deq(item.errors, []);
  eq(item.base.cls, "Jewel");
  eq(ident.unknown.length, 0, ident.unknown.join(";"));
  eq(ident.mods.length, 3);
  ok(ident.mods.every((m) => m.mod.d === "m"), "jewel mods come from the misc domain");
});

// ------------------------------------------------------------------ pools, tiers
const ring = db.basesByName.get("Two-Stone Ring")[0];
const plate = db.basesByName.get("Astral Plate")[0];

test("firstWeight uses the first matching tag", () => {
  eq(firstWeight([["weapon", 0], ["default", 1000]], new Set(["ring", "default"])), 1000);
  eq(firstWeight([["ring", 0], ["default", 1000]], new Set(["ring", "default"])), 0);
  eq(firstWeight([["weapon", 5]], new Set(["ring"])), null);
});

test("spawn weights: life rolls on rings, local armour does not", () => {
  const tags = itemTags(db, ring, []);
  ok(spawnWeight(db.modById.get("IncreasedLife5"), tags) > 0);
  eq(spawnWeight(db.modById.get("LocalIncreasedPhysicalDamageReductionRating1"), tags), 0);
  ok(spawnWeight(db.modById.get("LocalBaseArmourAndLife1"), itemTags(db, plate, [])) > 0);
});

test("basePool respects item level", () => {
  const low = basePool(db, ring, [], 10);
  ok(low.every((e) => e.mod.l <= 10));
  ok(basePool(db, ring, [], 86).length > low.length);
});

test("tier tables: T1 is the highest level tier of a family", () => {
  const { tierOf, families } = tierTables(db, ring, []);
  const t = tierOf.get("IncreasedLife5");
  ok(t && t.of >= 7, "life has many tiers on rings");
  const fam = families.get(t.family);
  eq(fam[0].l >= fam[fam.length - 1].l, true);
  eq(tierOf.get(fam[0].id).tier, 1);
  eq(tierOf.get(fam[fam.length - 1].id).tier, t.of);
  ok(tierOf.get("IncreasedLife6").tier < t.tier, "IncreasedLife6 is a better tier than IncreasedLife5");
});

// ------------------------------------------------------------------ satisfies
test("satisfies: same tier or better, never worse or different stats", () => {
  const t = makeTarget(db.modById.get("IncreasedLife5"));
  ok(satisfies(db.modById.get("IncreasedLife5"), t));
  ok(satisfies(db.modById.get("IncreasedLife7"), t), "better tier satisfies");
  ok(!satisfies(db.modById.get("IncreasedLife3"), t), "worse tier does not");
  ok(!satisfies(db.modById.get("IncreasedMana5"), t), "different stat does not");
  ok(!satisfies(db.modById.get("LocalBaseArmourAndLife4"), t), "hybrid with extra stat does not");
});

test("satisfies: hybrids compare every stat", () => {
  const t = makeTarget(db.modById.get("LocalBaseArmourAndLife2"));
  ok(satisfies(db.modById.get("LocalBaseArmourAndLife3"), t));
  ok(!satisfies(db.modById.get("LocalBaseArmourAndLife1"), t));
});

// ------------------------------------------------------------------ bench
test("bench options: life craft exists on rings and matches low targets only", () => {
  const low = benchOptionsFor(db, ring, makeTarget(db.modById.get("IncreasedLife1")));
  ok(low.length > 0, "a bench life craft satisfies T-low life");
  ok(low.every((o) => o.mod.g === "p" && o.mod.d === "c"));
  ok(low.every((o) => o.cost && Object.keys(o.cost).length > 0), "bench options carry a cost");
  const high = benchOptionsFor(db, ring, makeTarget(db.modById.get("IncreasedLife7")));
  eq(high.length, 0, "no bench craft reaches top-tier life");
});

test("bench options are per item class", () => {
  const ringOpts = db.benchByClass.get("Ring");
  const bootOpts = db.benchByClass.get("Boots");
  ok(ringOpts.length > 0 && bootOpts.length > 0);
  const ms = /^\(\d+-\d+\)% increased Movement Speed$/;
  ok(bootOpts.some((o) => ms.test(o.mod.x)), "boots can craft movement speed");
  ok(!ringOpts.some((o) => ms.test(o.mod.x)), "rings can't");
});

// ------------------------------------------------------------------ runner
export async function runAll() {
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  ", t.name); }
    catch (e) { failed++; console.log("  FAIL", t.name, "\n       ", e.message.split("\n").join("\n        ")); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} tests passed, ${assertions} assertions`);
  if (failed) process.exitCode = 1;
}
export { ok, eq, deq, near, parse, db };

if (import.meta.url === `file://${process.argv[1]}`) runAll();
