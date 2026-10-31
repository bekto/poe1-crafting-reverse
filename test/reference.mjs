// Checks the simulator against odds worked out by hand: node test/reference.mjs
//
// The cases use a small made-up item: one ring base whose pool has 6 prefixes and 6 suffixes, all with
// weight 1000 and each in its own mod group, plus one essence-only prefix. With equal weights the answers
// follow from counting, using the assumptions in craft.js (rare rolls get 4/5/6 mods with chance
// 8/12, 3/12, 1/12; an alteration gives 2 mods half the time).
import assert from "node:assert/strict";
import { indexData } from "../public/js/engine/data.js";
import { planCraft, buildContext, stageOneTargets } from "../public/js/engine/craft.js";
export { stageOneTargets };
import { exactReroll, exactAltRegal, exactRerollFirstFrom } from "../public/js/engine/exact.js";
import { RARE_COUNTS } from "../public/js/engine/assumptions.js";
import { satisfies } from "../public/js/engine/pool.js";

const TOLERANCE = 0.10; // relative

export function syntheticDb({ prefixes = 6, suffixes = 6, weights = {} } = {}) {
  const mod = (id, g, extra = {}) => ({
    id, n: id, g, d: "i", l: 1, gr: [id], ty: id, t: [],
    sw: [["default", weights[id] ?? 1000]], gw: [], st: [[`stat_${id}`, 1, 1]], x: `+1 to Stat ${id}`, e: 0, ...extra,
  });
  const mods = [];
  for (let i = 1; i <= prefixes; i++) mods.push(mod(`P${i}`, "p"));
  for (let i = 1; i <= suffixes; i++) mods.push(mod(`S${i}`, "s"));
  mods.push(mod("E1", "p", { e: 1 }));
  return indexData({
    version: "test",
    classes: { Ring: { name: "Rings", influence: {} } },
    bases: [{ id: "TestRing", name: "Test Ring", cls: "Ring", tags: ["ring", "default"], implicits: [], lvl: 1, dom: "i" }],
    mods,
    implicits: [],
    essences: [{ id: "TestEssence", name: "Deafening Essence of Testing", level: 7, corrupt: false, ilvl: null, mods: { Ring: "E1" } }],
    fossils: [],
    bench: {},
  });
}

/**
 * A less symmetric made-up pool for checking the exact engine: 4 prefix and 4 suffix groups with 2 tiers each
 * and uneven weights, a bench craft in suffix group S2, and an essence mod in prefix group P4.
 */
const ATTACK_GROUPS = ["P2", "S3", "S4"]; // mods tagged "attack" in the uneven pool

export function richDb() {
  const W = { P1: [1000, 500], P2: [800, 200], P3: [300, 300], P4: [1500, 100], S1: [600, 600], S2: [1000, 250], S3: [400, 50], S4: [2000, 700] };
  const mods = [];
  for (const [g, ws] of Object.entries(W)) {
    ws.forEach((w, k) => mods.push({
      id: `${g}t${k + 1}`, n: g, g: g[0].toLowerCase(), d: "i", l: 1, gr: [g], ty: g,
      sw: [["default", w]], gw: [], st: [[`stat_${g}`, k + 1, k + 1]], x: `+${k + 1} to Stat ${g}`, e: 0, t: ATTACK_GROUPS.includes(g) ? ["attack"] : [],
    }));
  }
  mods.push({ id: "P4ess", n: "P4", g: "p", d: "i", l: 1, gr: ["P4"], ty: "P4", t: [], sw: [["default", 0]], gw: [], st: [["stat_P4", 3, 3]], x: "+3 to Stat P4", e: 1 });
  const crafted = (id, g, gr, x, st = []) => ({ id, n: id, g, d: "c", l: 1, gr: [gr], ty: gr, t: [], sw: [], gw: [], st, x, e: 0 });
  mods.push(crafted("S2craft", "s", "S2", "+1 to Stat S2", [["stat_S2", 1, 1]]));
  mods.push(crafted("P1craft", "p", "P1", "+1 to Stat P1", [["stat_P1", 1, 1]]));
  mods.push(crafted("Multimod", "s", "ItemGenerationCanHaveMultipleCraftedMods", "Can have up to 3 Crafted Modifiers"));
  mods.push(crafted("NoAttack", "s", "ItemGenerationCannotRollAttackAffixes", "Cannot roll Attack Modifiers"));
  return indexData({
    version: "test",
    classes: { Ring: { name: "Rings", influence: {} } },
    bases: [{ id: "TestRing", name: "Test Ring", cls: "Ring", tags: ["ring", "default"], implicits: [], lvl: 1, dom: "i" }],
    mods, implicits: [],
    essences: [{ id: "TestEssence", name: "Deafening Essence of Testing", level: 7, corrupt: false, ilvl: null, mods: { Ring: "P4ess" } }],
    fossils: [],
    bench: Object.fromEntries(["S2craft", "P1craft", "Multimod", "NoAttack"].map((id) => [id, { classes: ["Ring"], cost: {}, tier: 1 }])),
  });
}

// Bench craft rule, written out separately from the engine: every craft that didn't roll needs its group free
// and a free slot on its side; two or more missing crafts also need a suffix for multimod.
function craftsOk(ctx, taken, caps, ignoreBlocked = false) {
  const crafts = ctx.crafts || [];
  const groupTaken = (c) => taken.some((m) => m.gr.some((g) => c.groups.includes(g)));
  let missing = crafts.filter((c) => !taken.some((m) => satisfies(m, c)));
  if (ignoreBlocked) missing = missing.filter((c) => !groupTaken(c));
  else if (missing.some(groupTaken)) return { ok: false, need: { p: 9, s: 9 } };
  const need = { p: ctx.reserve?.p || 0, s: ctx.reserve?.s || 0 };
  for (const c of missing) need[c.side]++;
  if (missing.length >= 2) need.s++;
  const used = (sd) => taken.filter((m) => m.g === sd).length;
  return { ok: used("p") + need.p <= caps.p && used("s") + need.s <= caps.s, need };
}

/**
 * Brute force: walks every possible sequence of rolled mods with the same rules as the simulator
 * (forced mods first, then mods by weight without repeating a group, until the item has n mods).
 */
export function bruteReroll(ctx, entries, forced, counts, caps = { p: 3, s: 3 }, firstTag = null) {
  const ok = (taken) => ctx.hard.every((t) => taken.some((m) => satisfies(m, t))) && craftsOk(ctx, taken, caps).ok;
  const rec = (taken, n) => {
    if (taken.length >= n) return ok(taken) ? 1 : 0;
    const groups = new Set(taken.flatMap((m) => m.gr));
    const open = (side) => taken.filter((m) => m.g === side).length < caps[side];
    const isFirst = firstTag && taken.length === forced.length;
    const avail = entries.filter((e) => e.w > 0 && open(e.mod.g) && !e.mod.gr.some((g) => groups.has(g)) && !(isFirst && !e.mod.t.includes(firstTag)));
    const tot = avail.reduce((a, e) => a + e.w, 0);
    if (!tot) return ok(taken) ? 1 : 0;
    return avail.reduce((a, e) => a + (e.w / tot) * rec([...taken, e.mod], n), 0);
  };
  return counts.reduce((a, [n, p]) => a + p * rec([...forced], n), 0);
}

/** Brute force for the alteration route, with the same rules as altRegalMethod in craft.js. */
export function bruteAltRegal(ctx, s1, block = null, twoModChance = 0.5) {
  const entries = ctx.pool.filter((e) => e.w > 0);
  const rare = { p: 3, s: 3 };
  const draws = (taken, caps, blockTag = null) => {
    const groups = new Set(taken.flatMap((m) => m.gr));
    const avail = entries.filter((e) => taken.filter((m) => m.g === e.mod.g).length < caps[e.mod.g] && !e.mod.gr.some((g) => groups.has(g)) && !(blockTag && e.mod.t.includes(blockTag)));
    const tot = avail.reduce((a, e) => a + e.w, 0);
    return avail.map((e) => [e.mod, e.w / tot]);
  };
  const has = (taken, t) => taken.some((m) => satisfies(m, t));
  const s1ok = (taken) => s1.every((x) => has(taken, ctx.hard[x.i]));
  const success = (taken) => ctx.hard.every((t) => has(taken, t)) && craftsOk(ctx, taken, rare).ok;
  // stage 1: list of [magic item, probability]
  const magic = [];
  let augs = 0;
  for (const [m1, q1] of draws([], { p: 1, s: 1 })) {
    for (const [m2, q2] of draws([m1], { p: 1, s: 1 })) magic.push([[m1, m2], twoModChance * q1 * q2]);
    const partial = s1.some((x) => satisfies(m1, ctx.hard[x.i])) && !s1ok([m1]);
    const sides = new Set(s1.map((x) => ctx.hard[x.i].side));
    const needOther = partial && [...sides].some((sd) => sd !== m1.g);
    if (needOther) {
      augs += (1 - twoModChance) * q1;
      for (const [m2, q2] of draws([m1], { p: 1, s: 1 })) magic.push([[m1, m2], (1 - twoModChance) * q1 * q2]);
    } else magic.push([[m1], (1 - twoModChance) * q1]);
  }
  const good = magic.filter(([t]) => s1ok(t));
  const p1 = good.reduce((a, [, q]) => a + q, 0);
  let p2 = 0, exalts = 0;
  const stage2 = (taken, q, used, meta) => {
    if (success(taken)) { p2 += q; exalts += q * used; return; }
    const capsNow = { ...rare };
    if (meta) capsNow[block.side]--;
    const need = { p: 0, s: 0 };
    ctx.hard.forEach((t) => { if (!has(taken, t)) need[t.side]++; });
    const cn = craftsOk(ctx, taken, rare, true).need;
    const free = (sd, caps) => caps[sd] - taken.filter((m) => m.g === sd).length;
    if (need.p > free("p", capsNow) || need.s > free("s", capsNow) || need.p + cn.p > free("p", rare) || need.s + cn.s > free("s", rare) ||
      free("p", capsNow) + free("s", capsNow) <= 0) { exalts += q * used; return; }
    const ds = draws(taken, capsNow, meta ? block.tag : null);
    if (!ds.length) { exalts += q * used; return; }
    for (const [m, r] of ds) stage2([...taken, m], q * r, used + 1, meta);
  };
  for (const [t, q] of good) {
    for (const [m, r] of draws(t, rare)) {
      const after = [...t, m];
      const meta = !!block && after.filter((x) => x.g === block.side).length < rare[block.side];
      stage2(after, (q / p1) * r, 0, meta);
    }
  }
  return { p1, p2, augPerAlt: augs, avgExalts: exalts };
}

const RARE_N = [[4, 8 / 12], [5, 3 / 12], [6, 1 / 12]];
const expectN = (f) => RARE_N.reduce((a, [n, p]) => a + p * f(n), 0);

export const CASES = [
  {
    name: "chaos: one specific prefix",
    // the affix caps are the same on both sides, so on average half of the n mods are prefixes,
    // and each of the 6 prefixes is equally likely: P = E[n] / 2 / 6
    exact: expectN((n) => n) / 12, // = 53/144
    wanted: ["P1"],
    method: (plan) => plan.methods.find((m) => m.kind === "chaos"),
  },
  {
    name: "alteration: one specific prefix",
    // 1 mod (half the time): 1/12. 2 mods: always one prefix and one suffix, so 1/6
    exact: 0.5 * (1 / 12) + 0.5 * (1 / 6), // = 1/8
    wanted: ["P1"],
    method: (plan) => plan.methods.find((m) => m.kind === "altregal"),
    value: (m) => m.p1,
  },
  {
    name: "alteration + augmentation: one prefix and one suffix",
    // 2 mods: 1/6 * 1/6. 1 mod that is a target (2/12), then the augment adds the other side: 1/6
    exact: 0.5 * (1 / 36) + 0.5 * (2 / 12) * (1 / 6), // = 1/36
    wanted: ["P1", "S1"],
    method: (plan) => plan.methods.find((m) => m.kind === "altregal"),
    value: (m) => m.p1,
  },
  {
    name: "essence (forced prefix) plus one specific suffix",
    // the essence takes a prefix, leaving 2 prefix and 3 suffix slots for the other n-1 mods.
    // Counting the draw orders gives E[suffixes] = 35/22 for 3 more mods, 50/22 for 4 and 3 for 5.
    exact: ((8 / 12) * (35 / 22) + (3 / 12) * (50 / 22) + (1 / 12) * 3) / 6, // = 31/99
    wanted: ["E1", "S1"],
    method: (plan) => plan.methods.find((m) => m.kind === "essence"),
  },
];

export function runCase(db, c, opts = {}) {
  const base = db.bases[0];
  const wanted = c.wanted.map((id) => ({ mod: db.modById.get(id), minMod: db.modById.get(id) }));
  const plan = planCraft(db, base, 84, [], wanted, [], { trials: 200000, refineMs: 0, ...opts });
  const m = c.method(plan);
  assert.ok(m, `${c.name}: method not offered`);
  return (c.value || ((x) => x.p))(m);
}

const EXACT_TOLERANCE = 1e-6; // relative; the exact engine integrates numerically

// cases for the exact engine on the uneven pool, checked against brute force
export const RICH_CASES = [
  [["P1t2"], []], [["P1t1", "S3t2"], []], [["P2t2", "P3t1"], []], [["S4t2", "S1t1"], []],
  [["P1t2", "S2t1"], []], [["P3t2", "S2t1"], []], [["S3t2", "S2t1"], []],
  [["P4t1", "S1t2"], ["P4ess"]], [["P4t1", "S2t1"], ["P4ess"]], [["P4t1", "P2t2", "S2t1"], ["P4ess"]],
];
// with multimod: two bench crafts (P1 and S2 groups)
export const RICH_MULTIMOD_CASES = [["P1t1", "S2t1", "P3t2"], ["P1t1", "S2t1", "S1t2"], ["P1t1", "S2t1", "P3t2", "S4t2"]];
export const RICH_ALT_CASES = [["P1t2"], ["P1t1", "S3t2"], ["P2t2", "P3t1"], ["P1t2", "S2t1"], ["P2t2", "P3t1", "S2t1"], ["S1t2", "S3t2", "S2t1"]];

export function richContext(db, ids, opts = {}) {
  return buildContext(db, db.bases[0], 84, [], ids.map((id) => ({ mod: db.modById.get(id), minMod: db.modById.get(id) })), [], opts);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let failed = 0, total = 0;
  const report = (pass, text) => { total++; if (!pass) failed++; console.log(`  ${pass ? "ok  " : "FAIL"} ${text}`); };
  const relErr = (a, b) => (b === 0 ? Math.abs(a) : Math.abs(a - b) / b);

  console.log("Simulation (Monte Carlo) against hand-worked odds, tolerance 10%:");
  const db = syntheticDb();
  for (const c of CASES) {
    const got = runCase(db, c, { exact: false });
    const err = relErr(got, c.exact);
    report(err <= TOLERANCE, `${c.name}: simulated ${got.toFixed(5)}, exact ${c.exact.toFixed(5)} (${(err * 100).toFixed(1)}% off)`);
  }
  console.log("\nExact engine against hand-worked odds:");
  for (const c of CASES) {
    const got = runCase(db, c);
    report(relErr(got, c.exact) <= EXACT_TOLERANCE, `${c.name}: ${got.toPrecision(10)} vs ${c.exact.toPrecision(10)}`);
  }
  console.log("\nExact engine against brute-force enumeration (uneven weights, tiers, bench craft, essence):");
  const rich = richDb();
  for (const [ids, forced] of RICH_CASES) {
    const ctx = richContext(rich, ids);
    const f = forced.map((id) => rich.modById.get(id));
    const ex = exactReroll(ctx, ctx.pool, f).p, bf = bruteReroll(ctx, ctx.pool, f, RARE_COUNTS);
    report(relErr(ex, bf) <= EXACT_TOLERANCE, `reroll ${ids.join(" + ")}${forced.length ? " with " + forced : ""}: ${ex.toPrecision(8)} vs ${bf.toPrecision(8)}`);
  }
  for (const ids of RICH_MULTIMOD_CASES) {
    const ctx = richContext(rich, ids, { maxCrafts: 2 });
    const ex = exactReroll(ctx, ctx.pool, []).p, bf = bruteReroll(ctx, ctx.pool, [], RARE_COUNTS);
    report(ctx.crafts.length === 2 && relErr(ex, bf) <= EXACT_TOLERANCE, `reroll with multimod ${ids.join(" + ")}: ${ex.toPrecision(8)} vs ${bf.toPrecision(8)}`);
    const s1 = stageOneTargets(ctx);
    const ea = exactAltRegal(ctx, s1), ba = bruteAltRegal(ctx, s1);
    report(["p1", "p2", "avgExalts"].every((k) => relErr(ea[k], ba[k]) <= EXACT_TOLERANCE), `alteration route with multimod ${ids.join(" + ")}: p2 ${ea.p2.toPrecision(6)} vs ${ba.p2.toPrecision(6)}`);
  }
  // Harvest-style reforge: the first mod has the "attack" tag, and attack mods are 10x more common
  for (const ids of [["P2t2", "S1t2"], ["S3t2", "P1t1"], ["P3t2", "S2t1"]]) {
    const ctx = richContext(rich, ids);
    const entries = ctx.pool.map((e) => ({ mod: e.mod, w: e.mod.t.includes("attack") ? e.w * 10 : e.w }));
    const first = entries.filter((e) => e.mod.t.includes("attack"));
    const ex = exactRerollFirstFrom(ctx, entries, first, []).p, bf = bruteReroll(ctx, entries, [], RARE_COUNTS, { p: 3, s: 3 }, "attack");
    report(relErr(ex, bf) <= EXACT_TOLERANCE, `reroll including an attack mod ${ids.join(" + ")}: ${ex.toPrecision(8)} vs ${bf.toPrecision(8)}`);
  }
  for (const ids of [["P1t2", "P3t2"], ["S1t2", "P3t2", "S2t1"], ["P1t2", "S1t1"]]) {
    const ctx = richContext(rich, ids);
    const s1 = stageOneTargets(ctx);
    const block = { tag: "attack", side: "s" };
    const ea = exactAltRegal(ctx, s1, block), ba = bruteAltRegal(ctx, s1, block);
    report(["p1", "p2", "avgExalts"].every((k) => relErr(ea[k], ba[k]) <= EXACT_TOLERANCE), `alteration route with "Cannot roll Attack Modifiers" ${ids.join(" + ")}: p2 ${ea.p2.toPrecision(6)} vs ${ba.p2.toPrecision(6)}`);
  }
  for (const ids of RICH_ALT_CASES) {
    const ctx = richContext(rich, ids);
    const s1 = stageOneTargets(ctx);
    const ex = exactAltRegal(ctx, s1), bf = bruteAltRegal(ctx, s1);
    const pass = ["p1", "p2", "augPerAlt", "avgExalts"].every((k) => relErr(ex[k], bf[k]) <= EXACT_TOLERANCE);
    report(pass, `alteration route ${ids.join(" + ")}: p1 ${ex.p1.toPrecision(6)}, p2 ${ex.p2.toPrecision(6)} (brute ${bf.p1.toPrecision(6)}, ${bf.p2.toPrecision(6)})`);
  }
  console.log(`\n${total - failed}/${total} reference checks passed`);
  if (failed) process.exitCode = 1;
}
