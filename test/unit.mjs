// Unit tests, no framework: node test/unit.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { indexData, compileTemplate, matchLine } from "../public/js/engine/data.js";
import { parseItemText, identifyMods } from "../public/js/engine/parse.js";
import { tierTables, satisfies, makeTarget, benchOptionsFor, basePool, spawnWeight, itemTags, firstWeight } from "../public/js/engine/pool.js";

import { db } from "./db.mjs";

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

test("Path of Building export: base, implicit, crafted and influence lines", () => {
  const { item, ident, ids } = parse(`Rarity: RARE
Storm Loop
Two-Stone Ring
Unique ID: 1234abcd
Item Level: 85
LevelReq: 64
Implicits: 1
+14% to Fire and Lightning Resistances
+74 to maximum Life
{range:0.5}+44% to Cold Resistance
{crafted}+25 to maximum Energy Shield
Shaper Item`);
  deq(item.errors, []);
  ok(item.pob);
  eq(item.base.name, "Two-Stone Ring");
  eq(item.ilvl, 85);
  deq(item.influences, ["shaper"]);
  deq(item.implicitLines, ["+14% to Fire and Lightning Resistances"]);
  deq(ident.unknown, []);
  ok(ids.includes("IncreasedLife5") && ids.includes("ColdResist7"));
  ok(ident.mods.some((m) => m.crafted && /Energy Shield/.test(m.mod.x)), "{crafted} becomes a crafted mod");
});

test("corrupted, mirrored and unidentified items get a warning; cluster jewels a clear message", () => {
  const corrupted = parse(RING_CTRL_C + "\n--------\nCorrupted").item;
  ok(corrupted.warnings.some((w) => /corrupted/.test(w)));
  eq(parse(RING_CTRL_C).item.warnings.length, 0);
  const unid = parse("Item Class: Rings\nRarity: Rare\nTwo-Stone Ring\n--------\nItem Level: 85\n--------\nUnidentified").item;
  ok(unid.warnings.some((w) => /unidentified/.test(w)));
  const cluster = parse("Item Class: Jewels\nRarity: Rare\nFoo\nLarge Cluster Jewel\n--------\nItem Level: 84").item;
  ok(/Cluster Jewels have their own crafting rules/.test(cluster.errors[0]), cluster.errors[0]);
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

test("every sample item parses and identifies all of its mods", async () => {
  const { ITEMS, LABELS } = await import("../public/js/samples.js");
  ok(Object.keys(ITEMS).length >= 13);
  for (const [k, text] of Object.entries(ITEMS)) {
    const { item, ident } = parse(text);
    deq(item.errors, [], k);
    deq(ident.unknown, [], k);
    ok(ident.mods.length > 0, k);
    ok(LABELS[k], `${k} has a menu label`);
  }
  ok(parse(ITEMS.hunterboots).item.influences.includes("hunter"));
  ok(parse(ITEMS.fractured).ident.mods.some((m) => m.fractured));
  ok(parse(ITEMS.plate).ident.mods.some((m) => m.mod.st.length === 2), "plate has a hybrid mod");
  eq(parse(ITEMS.jewel).item.base.cls, "Jewel");
});

// ------------------------------------------------------------------ summed Ctrl+C lines
const PLATE_SUMMED = `Item Class: Body Armours
Rarity: Rare
Golem Shell
Astral Plate
--------
Item Level: 86
--------
+10% to all Elemental Resistances (implicit)
--------
+120 to Armour
+215 to maximum Life
85% increased Armour
+44% to Fire Resistance
+47% to Cold Resistance`;

test("summed line: hybrid armour + life plus a pure life mod is split into both", () => {
  const { ident, ids } = parse(PLATE_SUMMED);
  deq(ident.unknown, []);
  ok(ids.includes("LocalBaseArmourAndLife4"), "hybrid found: " + ids);
  ok(ids.includes("IncreasedLife12"), "pure life found (215 - 34..38 = 177..181)");
  eq(ident.mods.filter((m) => m.side === "p").length, 3);
  const summed = ident.mods.filter((m) => m.summed).map((m) => m.mod.id).sort();
  deq(summed, ["IncreasedLife12", "LocalBaseArmourAndLife4"]);
  ok(ident.searchSteps < 20000, `search stays small (${ident.searchSteps} steps)`);
});

test("summed line: a value that one mod explains is not split", () => {
  const { ids, ident } = parse(PLATE_SUMMED.replace("+215 to maximum Life", "+180 to maximum Life"));
  ok(ids.includes("IncreasedLife12"));
  ok(!ids.includes("LocalBaseArmourAndLife4"));
  ok(!ident.mods.some((m) => m.summed));
});

test("summed line: weapon hybrid physical + accuracy with pure physical", () => {
  const { ids, ident } = parse(`Item Class: Thrusting One Hand Swords
Rarity: Rare
Viper Needle
Jewelled Foil
--------
Item Level: 84
--------
+25% to Global Critical Strike Multiplier (implicit)
--------
230% increased Physical Damage
+160 to Accuracy Rating
26% increased Attack Speed`);
  deq(ident.unknown, []);
  ok(ids.includes("LocalIncreasedPhysicalDamagePercentAndAccuracyRating7"), ids.join());
  ok(ids.includes("LocalIncreasedPhysicalDamagePercent7"), ids.join());
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

// ------------------------------------------------------------------ exact odds
test("exact engine matches brute force on an uneven pool (reroll and alteration route)", async () => {
  const R = await import("./reference.mjs");
  const { exactReroll, exactAltRegal } = await import("../public/js/engine/exact.js");
  const { RARE_COUNTS } = await import("../public/js/engine/assumptions.js");
  const rich = R.richDb();
  for (const [ids, forced] of R.RICH_CASES.slice(0, 6)) {
    const ctx = R.richContext(rich, ids);
    const f = forced.map((id) => rich.modById.get(id));
    near(exactReroll(ctx, ctx.pool, f).p, R.bruteReroll(ctx, ctx.pool, f, RARE_COUNTS), 1e-7, ids.join("+"));
  }
  const ctx = R.richContext(rich, ["P2t2", "P3t1", "S2t1"]);
  const s1 = R.stageOneTargets(ctx);
  const ex = exactAltRegal(ctx, s1), bf = R.bruteAltRegal(ctx, s1);
  near(ex.p1, bf.p1, 1e-12);
  near(ex.p2, bf.p2, 1e-9);
  near(ex.avgExalts, bf.avgExalts, 1e-9);
});

test("planner uses exact odds where the engine can represent the pool, simulation otherwise", async () => {
  const { planCraft } = await import("../public/js/engine/craft.js");
  const { ITEMS } = await import("../public/js/samples.js");
  const { item, ident } = parse(ITEMS.ring);
  const want = (idx) => ident.mods.filter((_, i) => idx.includes(i)).map((m) => ({ mod: m.mod, minMod: m.mod }));
  const two = planCraft(db, item.base, item.ilvl, [], want([0, 3]), [], { refineMs: 0 });
  ok(two.methods.filter((m) => !m.approximate).every((m) => m.exact), "every method exact with 2 targets (except data marked approximate)");
  const chaos = two.methods.find((m) => m.kind === "chaos");
  ok(chaos.p > 0 && chaos.p < 0.05);
  const again = planCraft(db, item.base, item.ilvl, [], want([0, 3]), [], { refineMs: 0 });
  eq(again.methods.find((m) => m.kind === "chaos").p, chaos.p, "no noise between runs");
  const three = planCraft(db, item.base, item.ilvl, [], want([0, 3, 5]), [], { refineMs: 0, trials: 2000 });
  ok(three.methods.filter((m) => !m.approximate).every((m) => m.exact), "3 targets are exact too");
  // a jewel mod group with both prefix and suffix mods: the exact engine can't represent it, so it simulates
  const jw = parse(ITEMS.jewel);
  const jp = planCraft(db, jw.item.base, jw.item.ilvl, [], jw.ident.mods.map((m) => ({ mod: m.mod, minMod: m.mod })), [], { refineMs: 0, trials: 2000 });
  ok(jp.methods.some((m) => m.kind === "chaos" && !m.exact), "jewel falls back to simulation");
});

test("exact odds of an impossible target are exactly zero", async () => {
  const { planCraft } = await import("../public/js/engine/craft.js");
  const ring = db.basesByName.get("Two-Stone Ring")[0];
  // the top life tier can't roll below its required level
  const { tierOf, families } = tierTables(db, ring, []);
  const life = families.get(tierOf.get("IncreasedLife5").family)[0];
  const plan = planCraft(db, ring, life.l - 1, [], [{ mod: life, minMod: life }], [], { refineMs: 0 });
  const chaos = plan.methods.find((m) => m.kind === "chaos");
  eq(chaos.exact, true);
  eq(chaos.p, 0);
  ok(/can't make/.test(chaos.steps.map((x) => x.detail).join(" ")));
});

// ------------------------------------------------------------------ metacrafting
test("meta crafts are found in the bench data with their costs", () => {
  for (const k of ["multimod", "lockPrefixes", "lockSuffixes", "noAttack", "noCaster"]) {
    ok(db.meta[k], k);
    ok(Object.keys(db.meta[k].cost).length > 0, `${k} has a cost`);
  }
  eq(db.meta.multimod.mod.g, "s", "multimod is a suffix");
  eq(db.meta.lockPrefixes.mod.g, "s", "the prefix lock is itself a suffix");
});

test("craftReserve: one slot per missing craft, plus multimod for two", async () => {
  const { craftReserve } = await import("../public/js/engine/pool.js");
  const crafts = [{ side: "p" }, { side: "s" }];
  deq(craftReserve(crafts, 0), { p: 0, s: 0 });
  deq(craftReserve(crafts, 1), { p: 1, s: 0 });
  deq(craftReserve(crafts, 3), { p: 1, s: 2 }, "two crafts + multimod suffix");
  deq(craftReserve([], 0, "s", { p: 0, s: 1 }), { p: 0, s: 1 }, "extra reserve");
});

test("planner offers multimod, lock and block variants on real items", async () => {
  const { planCraft } = await import("../public/js/engine/craft.js");
  const { ITEMS } = await import("../public/js/samples.js");
  const { item, ident } = parse(ITEMS.ring);
  const want = (idx) => ident.mods.filter((_, i) => idx.includes(i)).map((m) => ({ mod: m.mod, minMod: m.mod }));
  // low-tier life, cold res and the crafted ES are all bench-able on rings
  const { tierOf, families } = tierTables(db, item.base, []);
  const lowest = (m) => { const f = families.get(tierOf.get(m.mod.id)?.family); return f ? f[f.length - 1] : m.mod; };
  const low = ident.mods.filter((_, i) => [0, 3, 2].includes(i)).map((m) => ({ mod: m.mod, minMod: lowest(m) }));
  const plan = planCraft(db, item.base, item.ilvl, [], low, [], { refineMs: 0, trials: 4000 });
  ok(plan.extraBenchable.length >= 1);
  const mm = plan.methods.filter((m) => m.multimod);
  ok(mm.length > 0, "multimod variants");
  ok(mm.every((m) => m.crafts.length === 2), "two crafts each");
  ok(mm.some((m) => m.steps.some((s) => /Can have up to 3 Crafted Modifiers/.test(s.title))), "multimod step");
  const lock = planCraft(db, item.base, item.ilvl, [], want([0, 3]), [], { refineMs: 0 }).methods.filter((m) => m.kind === "lock");
  ok(lock.length > 0, "lock method for a prefix + a suffix");
  ok(lock.every((m) => m.p > 0 && m.p <= Math.min(m.p1, m.p2)), "total tries = stage 1 + stage 2");
  ok(lock.some((m) => m.steps.some((s) => /Cannot Be Changed/.test(s.title))));
});

// ------------------------------------------------------------------ annulment
test("alteration route compares annulling a miss with starting over, using prices when given", async () => {
  const { planCraft, costOf } = await import("../public/js/engine/craft.js");
  const { ITEMS } = await import("../public/js/samples.js");
  eq(costOf({ "Exalted Orb": 2, "Chaos Orb": 3 }, { "Exalted Orb": 10 }), 23);
  eq(costOf({ "Exalted Orb": 2 }, {}), null, "missing price");
  const { item, ident } = parse(ITEMS.ring);
  const want = ident.mods.filter((_, i) => [3, 5].includes(i)).map((m) => ({ mod: m.mod, minMod: m.mod }));
  const plan = (prices) => planCraft(db, item.base, item.ilvl, [], want, [], { refineMs: 0, prices }).methods.find((m) => m.kind === "altregal" && !m.block);
  const none = plan(null);
  ok(none.annul && none.annul.options.length === 3, "three annul limits simulated");
  eq(none.annul.choice, null, "no choice without prices");
  ok(none.steps.some((s) => /annul, or start over/.test(s.title)));
  const cheapAnnul = plan({ "Orb of Alteration": 0.1, "Orb of Augmentation": 0.05, "Regal Orb": 0.5, "Exalted Orb": 15, "Orb of Annulment": 0.01 });
  eq(cheapAnnul.annul.choice, "annul", "nearly free annulments win");
  const dearAnnul = plan({ "Orb of Alteration": 0.1, "Orb of Augmentation": 0.05, "Regal Orb": 0.5, "Exalted Orb": 15, "Orb of Annulment": 500 });
  eq(dearAnnul.annul.choice, "restart", "very expensive annulments lose");
});

// ------------------------------------------------------------------ influence
test("influenced Exalted Orb and Awakener's Orb plans", async () => {
  const { planCraft, modInfluence } = await import("../public/js/engine/craft.js");
  const { ITEMS } = await import("../public/js/samples.js");
  const helm = parse(ITEMS.awakened);
  const byText = (re) => helm.ident.mods.find((m) => re.test(m.mod.x));
  eq(modInfluence(db, helm.item.base, byText(/Nearby Enemies/).mod), "crusader");
  eq(modInfluence(db, helm.item.base, byText(/Fire Damage to Spells/).mod), "hunter");
  eq(modInfluence(db, helm.item.base, byText(/maximum Life/).mod), null);
  const w = (list) => list.map((m) => ({ mod: m.mod, minMod: m.mod }));
  const plan = planCraft(db, helm.item.base, helm.item.ilvl, helm.item.influences, w([byText(/Nearby/), byText(/Spells/), byText(/Fire Res/)]), [], { refineMs: 0 });
  const aw = plan.methods.find((m) => m.kind === "awakener");
  ok(aw, "awakener plan");
  ok(aw.pA > 0 && aw.pB > 0 && aw.pRest > 0 && aw.pRest < 1, "the fire resistance has to come from the awakened roll");
  ok(aw.steps.some((s) => /Awakener's Orb/.test(s.title)) && aw.steps.some((s) => /Crusader's Exalted Orb/.test(s.title)));
  const boots = parse(ITEMS.hunterboots);
  const bw = boots.ident.mods.filter((m) => /Chaos Gems|Fire Resistance/.test(m.mod.x));
  const bp = planCraft(db, boots.item.base, boots.item.ilvl, boots.item.influences, w(bw), [], { refineMs: 0 });
  const ie = bp.methods.find((m) => m.kind === "influenceExalt");
  ok(ie && ie.p > 0 && ie.p <= ie.p2, "Hunter's Exalted Orb after rolling the rest");
  ok(ie.steps[0].title.includes("Sorcerer Boots") && !/hunter influence/.test(ie.steps[0].title), "stage 1 starts from a base without influence");
});

// ------------------------------------------------------------------ eldritch
test("eldritch implicits: rank and dominance from Ctrl+C and Ctrl+Alt+C", async () => {
  const { ITEMS } = await import("../public/js/samples.js");
  const { item } = parse(ITEMS.eldritchboots);
  eq(item.eldritch.exarch.rank, 4);
  eq(item.eldritch.eater.rank, 2);
  eq(item.eldritch.dominant, "exarch");
  deq(item.base.implicits, ["FireAndLightningResistImplicitBoots1"], "base variant still found from the base implicit");
  const adv = parse(`Item Class: Boots
Rarity: Rare
Ghoul Spur
Two-Toned Boots
--------
Item Level: 86
--------
{ Implicit Modifier — Elemental, Fire, Lightning, Resistance }
+12(8-12)% to Fire and Lightning Resistances (implicit)
{ Searing Exarch Implicit Modifier (Lesser) — Speed }
5% increased Movement Speed (implicit)
{ Eater of Worlds Implicit Modifier (Greater) — Life }
8% increased Life Regeneration rate (implicit)
--------
{ Prefix Modifier "Rotund" (Tier: 4) — Life }
+92(85-99) to maximum Life
--------
Searing Exarch Item
Eater of Worlds Item`).item;
  eq(adv.eldritch.exarch.rank, 1);
  eq(adv.eldritch.eater.rank, 2);
  eq(adv.eldritch.dominant, "eater");
  const plain = parse(ITEMS.boots).item;
  eq(plain.eldritch.dominant, null, "no eldritch implicits");
});

test("eldritch methods: Eldritch Chaos two-stage and Eldritch Exalted Orbs", async () => {
  const { planCraft } = await import("../public/js/engine/craft.js");
  const { ITEMS } = await import("../public/js/samples.js");
  const { item, ident } = parse(ITEMS.eldritchboots);
  const want = ident.mods.filter((_, i) => [0, 1, 2].includes(i)).map((m) => ({ mod: m.mod, minMod: m.mod }));
  const plan = planCraft(db, item.base, item.ilvl, [], want, [], { refineMs: 0, trials: 4000, eldritch: { dominant: item.eldritch.dominant } });
  const ec = plan.methods.filter((m) => m.kind === "lock" && m.eldritch);
  eq(ec.length, 2, "one per dominance");
  ok(ec.every((m) => m.steps.some((s) => /Eldritch Chaos Orb/.test(s.title)) && m.steps.some((s) => /dominant/.test(s.title))));
  const ee = plan.methods.find((m) => m.kind === "altregal" && m.block?.eldritch);
  ok(ee, "eldritch exalt variant: both missing mods are prefixes");
  eq(ee.block.onlySide, "p");
  ok(ee.p2 >= plan.methods.find((m) => m.kind === "altregal" && !m.block).p2 - 0.02, "one-side exalts don't do worse");
  const ring = parse(ITEMS.ring);
  const rp = planCraft(db, ring.item.base, ring.item.ilvl, [], ring.ident.mods.slice(0, 2).map((m) => ({ mod: m.mod, minMod: m.mod })), [], { refineMs: 0, trials: 2000 });
  ok(!rp.methods.some((m) => m.eldritch || m.block?.eldritch), "rings can't have eldritch implicits");
});

// ------------------------------------------------------------------ veiled
test("choiceChance: one good group among n equal ones, k picks", async () => {
  const { choiceChance } = await import("../public/js/engine/exact.js");
  const mk = (i, good) => ({ mod: { id: `m${i}`, gr: [`g${i}`], st: [[good ? "x" : `y${i}`, 1, 1]], stKey: good ? "x" : `y${i}` }, w: 100 });
  const entries = [mk(0, true), ...Array.from({ length: 9 }, (_, i) => mk(i + 1, false))];
  const t = { stKey: "x", minStats: [["x", 1]] };
  near(choiceChance(entries, t, 3), 3 / 10, 1e-12);
  near(choiceChance(entries, t, 1), 1 / 10, 1e-12);
  near(choiceChance(entries.slice(0, 2), t, 3), 1, 1e-12, "fewer options than picks");
});

test("unveiled mods are identified and get Veiled Chaos / Aisling plans", async () => {
  const { planCraft } = await import("../public/js/engine/craft.js");
  const { ITEMS } = await import("../public/js/samples.js");
  const { item, ident } = parse(ITEMS.veiledamulet);
  const u = ident.mods.find((m) => m.unveiled);
  ok(u && /Minimum Power Charges/.test(u.mod.x), "unveiled mod found");
  const want = [ident.mods[0], u].map((m) => ({ mod: m.mod, minMod: m.mod }));
  const plan = planCraft(db, item.base, item.ilvl, [], want, [], { refineMs: 0 });
  ok(plan.impossibleNaturally.some((m) => m.d === "u"), "flagged as not rollable");
  const vc = plan.methods.find((m) => m.kind === "veiledChaos"), ai = plan.methods.find((m) => m.kind === "aisling");
  ok(vc && vc.p > 0 && vc.p <= vc.pU && vc.exact, "Veiled Chaos Orb plan");
  ok(ai && ai.p > 0 && ai.p2 <= ai.pU, "Aisling plan");
  ok(plan.methods.filter((m) => m.kind === "chaos").every((m) => m.p === 0), "a Chaos Orb can't give it");
  ok(!plan.methods.some((m) => m.kind === "lock" && m.p === 0), "impossible two-stage plans are dropped");
});

// ------------------------------------------------------------------ fractured alteration route
test("alteration route on a fractured base keeps the fractured mod", async () => {
  const { planCraft } = await import("../public/js/engine/craft.js");
  const { ITEMS } = await import("../public/js/samples.js");
  const { item, ident } = parse(ITEMS.fractured);
  const fixed = ident.mods.filter((m) => m.fractured).map((m) => m.mod);
  eq(fixed.length, 1);
  const want = ident.mods.filter((m, i) => !m.fractured && [1, 3].includes(i)).map((m) => ({ mod: m.mod, minMod: m.mod }));
  const plan = planCraft(db, item.base, item.ilvl, [], want, fixed, { refineMs: 0 });
  const ar = plan.methods.find((m) => m.kind === "altregal" && !m.block);
  ok(ar && ar.exact && ar.p1 > 0 && ar.p2 > 0, "offered, exact");
  eq(ar.stage1Targets.length, 1, "only the open side is altered");
  ok(ar.stage1Targets[0].side !== fixed[0].g);
  ok(ar.steps.some((s) => /fractured mod stays/.test(s.detail)));
});

// ------------------------------------------------------------------ league mechanic
test("league.json hook: listed tag reforges become plans; none are listed for 3.29", async () => {
  const { planCraft } = await import("../public/js/engine/craft.js");
  const { ITEMS } = await import("../public/js/samples.js");
  const lg = db.manual.league;
  ok(lg && Array.isArray(lg.crafts));
  eq(lg.crafts.length, 0, "3.29 rules not verified, so nothing is invented");
  const { item, ident } = parse(ITEMS.ring);
  const want = ident.mods.filter((_, i) => [0, 3].includes(i)).map((m) => ({ mod: m.mod, minMod: m.mod }));
  const saved = lg.crafts;
  lg.crafts = [{ type: "tagReforge", name: "Test reforge", text: "Test", tag: "life", moreCommonMultiplier: 5, source: "unit test" }];
  try {
    const plan = planCraft(db, item.base, item.ilvl, [], want, [], { refineMs: 0 });
    const m = plan.methods.find((x) => x.league);
    ok(m && m.p > 0 && m.approximate, "league craft planned");
    ok(m.steps.some((s) => /league\.json/.test(s.detail)));
  } finally { lg.crafts = saved; }
});

// ------------------------------------------------------------------ recombinator
test("recombinator plan: two magic items, all pooled mods kept", async () => {
  const { planCraft } = await import("../public/js/engine/craft.js");
  const { ITEMS } = await import("../public/js/samples.js");
  const { item, ident } = parse(ITEMS.ring);
  const want = ident.mods.filter((_, i) => [0, 3].includes(i)).map((m) => ({ mod: m.mod, minMod: m.mod }));
  const plan = planCraft(db, item.base, item.ilvl, [], want, [], { refineMs: 0 });
  const r = plan.methods.find((m) => m.kind === "recomb");
  ok(r && r.approximate && r.advanced);
  const k = db.manual.recombinator.keepCounts["1"].find(([n]) => n === 1)[1];
  near(r.pc, k * k, 1e-12, "one prefix + one suffix, each kept from a pool of one");
  ok(r.steps.some((s) => /Recombinator/.test(s.title)));
  const one = planCraft(db, item.base, item.ilvl, [], want.slice(0, 1), [], { refineMs: 0 });
  ok(!one.methods.some((m) => m.kind === "recomb"), "no recombinator for a single mod");
});

// ------------------------------------------------------------------ Harvest
test("Harvest data is loaded from data/manual and its plans are marked approximate", async () => {
  const h = db.manual.harvest;
  ok(h && h.reforgeTag.length >= 10, "tag reforges listed");
  ok(h.reforgeKeep.some((k) => k.keep === "p") && h.reforgeKeep.some((k) => k.keep === "s"));
  ok(h.reforgeTag.every((r) => db.mods.some((m) => m.t.includes(r.tag))), "every Harvest tag exists on some mod");
  const { planCraft } = await import("../public/js/engine/craft.js");
  const { ITEMS } = await import("../public/js/samples.js");
  const { item, ident } = parse(ITEMS.ring);
  const want = ident.mods.filter((_, i) => [0, 3].includes(i)).map((m) => ({ mod: m.mod, minMod: m.mod }));
  const plan = planCraft(db, item.base, item.ilvl, [], want, [], { refineMs: 0 });
  const hv = plan.methods.filter((m) => m.kind === "harvest");
  ok(hv.some((m) => /Life/.test(m.name)) && hv.some((m) => /Cold/.test(m.name)), "tags of the wanted mods");
  ok(!hv.some((m) => /Physical/.test(m.name)), "no unrelated tags");
  ok(hv.every((m) => m.approximate && m.p > 0));
  ok(hv.every((m) => m.steps.some((s) => /Horticrafting Station/.test(s.title))), "Harvest plans have their step");
  ok(plan.methods.some((m) => m.kind === "lock" && m.harvestKeep && m.approximate), "Harvest keep-side reforge");
});

test("every planned method has at least one step after getting the base", async () => {
  const { planCraft } = await import("../public/js/engine/craft.js");
  const { ITEMS } = await import("../public/js/samples.js");
  for (const [key, idx] of [["ring", [0, 3]], ["boots", [0, 1, 2]], ["awakened", [1, 2, 3]], ["veiledamulet", [0, 3]], ["eldritchboots", [0, 1, 2]], ["fractured", [1, 3]]]) {
    const { item, ident } = parse(ITEMS[key]);
    const fixed = ident.mods.filter((m) => m.fractured).map((m) => m.mod);
    const want = ident.mods.filter((m, i) => !m.fractured && idx.includes(i)).map((m) => ({ mod: m.mod, minMod: m.mod }));
    const plan = planCraft(db, item.base, item.ilvl, item.influences, want, fixed, { refineMs: 0, trials: 3000, eldritch: item.eldritch });
    for (const m of plan.methods) ok(m.steps.length >= 2 && m.steps.every((s) => s.title && s.detail), `${key}: ${m.kind} ${m.name}`);
  }
});

// ------------------------------------------------------------------ manual builder helpers
test("builder lists: unique base labels, mod families best tier first, influence and unveiled families", async () => {
  const { modFamilies, baseChoices } = await import("../public/js/engine/pool.js");
  const bc = baseChoices(db);
  eq(bc.length, db.bases.length);
  eq(new Set(bc.map((x) => x.label)).size, bc.length, "labels are unique");
  ok(bc.filter((x) => x.label.startsWith("Two-Stone Ring (")).length >= 3, "variants told apart by implicit");
  const ring = db.basesByName.get("Two-Stone Ring")[0];
  const plain = modFamilies(db, ring, []), shaper = modFamilies(db, ring, ["shaper"]);
  ok(shaper.length > plain.length, "influence adds families");
  eq(new Set(plain.map((f) => f.label)).size, plain.length);
  const life = plain.find((f) => /^Prefix · \+\(\d+-\d+\) to maximum Life$/.test(f.label));
  ok(life && life.mods.every((m, i, a) => i === 0 || a[i - 1].l >= m.l), "best tier first");
  ok(plain.some((f) => /\(unveiled\)$/.test(f.label) && f.mods[0].d === "u"));
  ok(plain.findIndex((f) => f.side === "s") > plain.findLastIndex((f) => f.side === "p"), "prefixes then suffixes");
});

// ------------------------------------------------------------------ share links
test("share links: plain hash round-trip and clear errors", async () => {
  const { encodeShare, decodeShare } = await import("../public/js/engine/share.js");
  const state = { baseId: "Metadata/Items/Rings/Ring12", ilvl: 85, influences: ["shaper"], wanted: [{ modId: "IncreasedLife5", minModId: "IncreasedLife3" }, { modId: "ColdResist7", minModId: "ColdResist7" }], fixedIds: ["Strength1"] };
  const h = encodeShare(state);
  ok(/^#[A-Za-z0-9_/.,~=&-]+$/.test(h), "only plain characters: " + h);
  deq(decodeShare(db, h).state, state);
  ok(!db.mods.some((m) => !/^[A-Za-z0-9_/.-]+$/.test(m.id)) && !db.bases.some((b) => !/^[A-Za-z0-9_/.-]+$/.test(b.id)), "every id can go in a link");
  eq(decodeShare(db, ""), null);
  eq(decodeShare(db, "#something-else"), null, "other hashes are ignored");
  ok(/Unknown base/.test(decodeShare(db, "#b=Nope&w=IncreasedLife5").error));
  ok(/Unknown mod/.test(decodeShare(db, "#b=Metadata/Items/Rings/Ring12&w=NoSuchMod").error));
  eq(decodeShare(db, "#b=Metadata/Items/Rings/Ring12&i=999&w=IncreasedLife5").state.ilvl, 100, "item level clamped");
});

// ------------------------------------------------------------------ prices
test("prices: fetch script on saved poe.ninja responses, and cost per method", async () => {
  const { execFileSync } = await import("node:child_process");
  const os = await import("node:os");
  const out = `${os.tmpdir()}/prices_unit_${process.pid}.json`;
  execFileSync("python3", ["tools/fetch_prices.py", out, "--fixtures", "test/fixtures"], { cwd: new URL("..", import.meta.url).pathname });
  const prices = JSON.parse(fs.readFileSync(out, "utf8"));
  eq(prices.league, "Keepers", "first softcore challenge league from the index");
  eq(prices.divine, 180);
  eq(prices.prices["Chaos Orb"], 1);
  ok(!("Broken Thing" in prices.prices), "lines without a price are skipped");
  const { usageOf, priceUsage } = await import("../public/js/engine/cost.js");
  const fakeCtx = { db, crafts: [], base: db.bases[0] };
  deq(usageOf({ kind: "chaos", p: 0.25, currency: [["Chaos Orb", 1]] }, fakeCtx), { "Chaos Orb": 4 });
  const pr = priceUsage({ "Chaos Orb": 4, "Exalted Orb": 2, "Mystery Orb": 1 }, prices);
  eq(pr.chaos, 4 + 2 * 12.5);
  near(pr.divine, 29 / 180, 1e-12);
  deq(pr.unpriced, ["Mystery Orb"]);
  const { planCraft } = await import("../public/js/engine/craft.js");
  const { ITEMS } = await import("../public/js/samples.js");
  const { item, ident } = parse(ITEMS.ring);
  const want = ident.mods.filter((_, i) => [0, 3].includes(i)).map((m) => ({ mod: m.mod, minMod: m.mod }));
  const plan = planCraft(db, item.base, item.ilvl, [], want, [], { refineMs: 0, prices });
  const chaos = plan.methods.find((m) => m.kind === "chaos");
  near(chaos.cost.chaos, 1 / chaos.p, 1e-9, "Chaos spam costs 1/p chaos");
  const alt = plan.methods.find((m) => m.kind === "altregal" && !m.block);
  ok(alt.cost.chaos > 0 && alt.cost.unpriced.length === 0, "alteration route fully priced by the fixture");
  ok(plan.methods.filter((m) => m.kind === "harvest").every((m) => m.cost.unpriced.includes("Harvest lifeforce")));
});

// ------------------------------------------------------------------ runner
export async function runAll() {
  for (const t of tests) {
    const t0 = Date.now();
    try { await t.fn(); const ms = Date.now() - t0; console.log("  ok  ", t.name + (ms > 500 ? ` (${(ms / 1000).toFixed(1)} s)` : "")); }
    catch (e) { failed++; console.log("  FAIL", t.name, "\n       ", e.message.split("\n").join("\n        ")); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} tests passed, ${assertions} assertions`);
  if (failed) process.exitCode = 1;
}
export { ok, eq, deq, near, parse, db };

if (import.meta.url === `file://${process.argv[1]}`) runAll();
