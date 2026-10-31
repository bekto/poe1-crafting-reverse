// Checks the simulator against odds worked out by hand: node test/reference.mjs
//
// The cases use a small made-up item: one ring base whose pool has 6 prefixes and 6 suffixes, all with
// weight 1000 and each in its own mod group, plus one essence-only prefix. With equal weights the answers
// follow from counting, using the assumptions in craft.js (rare rolls get 4/5/6 mods with chance
// 8/12, 3/12, 1/12; an alteration gives 2 mods half the time).
import assert from "node:assert/strict";
import { indexData } from "../public/js/engine/data.js";
import { planCraft, buildContext } from "../public/js/engine/craft.js";
import { exactReroll, exactAltRegal } from "../public/js/engine/exact.js";
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
export function richDb() {
  const W = { P1: [1000, 500], P2: [800, 200], P3: [300, 300], P4: [1500, 100], S1: [600, 600], S2: [1000, 250], S3: [400, 50], S4: [2000, 700] };
  const mods = [];
  for (const [g, ws] of Object.entries(W)) {
    ws.forEach((w, k) => mods.push({
      id: `${g}t${k + 1}`, n: g, g: g[0].toLowerCase(), d: "i", l: 1, gr: [g], ty: g, t: [],
      sw: [["default", w]], gw: [], st: [[`stat_${g}`, k + 1, k + 1]], x: `+${k + 1} to Stat ${g}`, e: 0,
    }));
  }
  mods.push({ id: "P4ess", n: "P4", g: "p", d: "i", l: 1, gr: ["P4"], ty: "P4", t: [], sw: [["default", 0]], gw: [], st: [["stat_P4", 3, 3]], x: "+3 to Stat P4", e: 1 });
  mods.push({ id: "S2craft", n: "S2", g: "s", d: "c", l: 1, gr: ["S2"], ty: "S2", t: [], sw: [], gw: [], st: [["stat_S2", 1, 1]], x: "+1 to Stat S2", e: 0 });
  return indexData({
    version: "test",
    classes: { Ring: { name: "Rings", influence: {} } },
    bases: [{ id: "TestRing", name: "Test Ring", cls: "Ring", tags: ["ring", "default"], implicits: [], lvl: 1, dom: "i" }],
    mods, implicits: [],
    essences: [{ id: "TestEssence", name: "Deafening Essence of Testing", level: 7, corrupt: false, ilvl: null, mods: { Ring: "P4ess" } }],
    fossils: [],
    bench: { S2craft: { classes: ["Ring"], cost: {}, tier: 1 } },
  });
}

/**
 * Brute force: walks every possible sequence of rolled mods with the same rules as the simulator
 * (forced mods first, then mods by weight without repeating a group, until the item has n mods).
 */
export function bruteReroll(ctx, entries, forced, counts, caps = { p: 3, s: 3 }) {
  const ok = (taken) => {
    for (const t of ctx.hard) if (!taken.some((m) => satisfies(m, t))) return false;
    const b = ctx.benchTarget;
    if (!b || taken.some((m) => satisfies(m, b))) return true;
    return taken.filter((m) => m.g === b.side).length < caps[b.side] && !taken.some((m) => m.gr.some((g) => b.groups.includes(g)));
  };
  const rec = (taken, n) => {
    if (taken.length >= n) return ok(taken) ? 1 : 0;
    const groups = new Set(taken.flatMap((m) => m.gr));
    const open = (side) => taken.filter((m) => m.g === side).length < caps[side];
    const avail = entries.filter((e) => e.w > 0 && open(e.mod.g) && !e.mod.gr.some((g) => groups.has(g)));
    const tot = avail.reduce((a, e) => a + e.w, 0);
    if (!tot) return ok(taken) ? 1 : 0;
    return avail.reduce((a, e) => a + (e.w / tot) * rec([...taken, e.mod], n), 0);
  };
  return counts.reduce((a, [n, p]) => a + p * rec([...forced], n), 0);
}

/** Brute force for the alteration route, with the same rules as altRegalMethod in craft.js. */
export function bruteAltRegal(ctx, s1, twoModChance = 0.5) {
  const entries = ctx.pool.filter((e) => e.w > 0);
  const rare = { p: 3, s: 3 };
  const draws = (taken, caps) => {
    const groups = new Set(taken.flatMap((m) => m.gr));
    const avail = entries.filter((e) => taken.filter((m) => m.g === e.mod.g).length < caps[e.mod.g] && !e.mod.gr.some((g) => groups.has(g)));
    const tot = avail.reduce((a, e) => a + e.w, 0);
    return avail.map((e) => [e.mod, e.w / tot]);
  };
  const has = (taken, t) => taken.some((m) => satisfies(m, t));
  const s1ok = (taken) => s1.every((x) => has(taken, ctx.hard[x.i]));
  const b = ctx.benchTarget;
  const success = (taken) => ctx.hard.every((t) => has(taken, t)) &&
    (!b || has(taken, b) || (taken.filter((m) => m.g === b.side).length < rare[b.side] && !taken.some((m) => m.gr.some((g) => b.groups.includes(g)))));
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
  const stage2 = (taken, q, used) => {
    if (success(taken)) { p2 += q; exalts += q * used; return; }
    const need = { p: 0, s: 0 };
    ctx.hard.forEach((t) => { if (!has(taken, t)) need[t.side]++; });
    if (b && !has(taken, b) && !taken.some((m) => m.gr.some((g) => b.groups.includes(g)))) need[b.side]++;
    const free = (sd) => rare[sd] - taken.filter((m) => m.g === sd).length;
    if (need.p > free("p") || need.s > free("s") || taken.length >= 6) { exalts += q * used; return; }
    const ds = draws(taken, rare);
    if (!ds.length) { exalts += q * used; return; }
    for (const [m, r] of ds) stage2([...taken, m], q * r, used + 1);
  };
  for (const [t, q] of good) for (const [m, r] of draws(t, rare)) stage2([...t, m], (q / p1) * r, 0);
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
export const RICH_ALT_CASES = [["P1t2"], ["P1t1", "S3t2"], ["P2t2", "P3t1"], ["P1t2", "S2t1"], ["P2t2", "P3t1", "S2t1"], ["S1t2", "S3t2", "S2t1"]];

export function richContext(db, ids) {
  return buildContext(db, db.bases[0], 84, [], ids.map((id) => ({ mod: db.modById.get(id), minMod: db.modById.get(id) })));
}
export function stageOneTargets(ctx) {
  const pick = (side) => ctx.hard.map((t, i) => ({ t, i })).filter((x) => x.t.side === side).sort((a, b) => a.t.naturalWeight - b.t.naturalWeight)[0];
  return [pick("p"), pick("s")].filter(Boolean);
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
