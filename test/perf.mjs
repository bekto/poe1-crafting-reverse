// Planner timing for every sample with all of its mods wanted (what the page does by default):
//   node test/perf.mjs            fails if a plan takes longer than PLAN_BUDGET_MS
import { db } from "./db.mjs";
import { parseItemText, identifyMods } from "../public/js/engine/parse.js";
import { planCraft } from "../public/js/engine/craft.js";
import { ITEMS } from "../public/js/samples.js";

// the roadmap asks for under 5 s on a mid-range laptop; keep headroom for slower machines
const PLAN_BUDGET_MS = 3500;
let worst = 0, failed = 0;
for (const [key, text] of Object.entries(ITEMS)) {
  const item = parseItemText(db, text);
  const mods = identifyMods(db, item).mods;
  const wanted = mods.filter((m) => !m.fractured).map((m) => ({ mod: m.mod, minMod: m.mod }));
  const fixed = mods.filter((m) => m.fractured).map((m) => m.mod);
  const t0 = Date.now();
  const plan = planCraft(db, item.base, item.ilvl, item.influences, wanted, fixed, { eldritch: item.eldritch });
  const ms = Date.now() - t0;
  worst = Math.max(worst, ms);
  const slow = ms > PLAN_BUDGET_MS;
  if (slow) failed++;
  console.log(`  ${slow ? "SLOW" : "ok  "} ${key.padEnd(14)} ${String(ms).padStart(5)} ms  ${wanted.length} mods, ${plan.methods.length} plans`);
}
console.log(`\nslowest ${worst} ms (budget ${PLAN_BUDGET_MS} ms)`);
if (failed) process.exitCode = 1;
