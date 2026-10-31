// Checks the simulator against odds worked out by hand: node test/reference.mjs
//
// The cases use a small made-up item: one ring base whose pool has 6 prefixes and 6 suffixes, all with
// weight 1000 and each in its own mod group, plus one essence-only prefix. With equal weights the answers
// follow from counting, using the assumptions in craft.js (rare rolls get 4/5/6 mods with chance
// 8/12, 3/12, 1/12; an alteration gives 2 mods half the time).
import assert from "node:assert/strict";
import { indexData } from "../public/js/engine/data.js";
import { planCraft } from "../public/js/engine/craft.js";

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

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = syntheticDb();
  let failed = 0;
  for (const c of CASES) {
    const got = runCase(db, c);
    const err = Math.abs(got - c.exact) / c.exact;
    const pass = err <= TOLERANCE;
    if (!pass) failed++;
    console.log(`  ${pass ? "ok  " : "FAIL"} ${c.name}: simulated ${got.toFixed(5)}, exact ${c.exact.toFixed(5)} (${(err * 100).toFixed(1)}% off)`);
  }
  console.log(`\n${CASES.length - failed}/${CASES.length} reference cases within ${TOLERANCE * 100}%`);
  if (failed) process.exitCode = 1;
}
