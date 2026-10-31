import fs from "node:fs";
import { indexData } from "../public/js/engine/data.js";
import { parseItemText, identifyMods } from "../public/js/engine/parse.js";
import { planCraft } from "../public/js/engine/craft.js";
import { ITEMS } from "./items.js";
import { db } from "./db.mjs";
const key = process.argv[2] || "ring";
const pickIdx = process.argv[3] ? process.argv[3].split(",").map(Number) : null;
const it = parseItemText(db, ITEMS[key]);
const id = identifyMods(db, it);
let mods = id.mods;
if (pickIdx) mods = mods.filter((_, i) => pickIdx.includes(i));
console.log("targets:", mods.map((m) => m.mod.id));
const t0 = Date.now();
const plan = planCraft(db, it.base, it.ilvl, it.influences, mods.map((m) => ({ mod: m.mod, minMod: m.mod })), mods.filter(m=>m.fractured).map(m=>m.mod));
console.log("time", Date.now() - t0, "ms; bench:", plan.benchTarget?.option.mod.id, "minIlvl", plan.minIlvl);
for (const m of plan.methods.slice(0, 8)) {
  console.log(`- ${m.kind} ${m.name}: p=${m.p.toExponential(3)} hits=${m.hits}/${m.trials}`);
}
console.log(JSON.stringify(plan.methods[0].steps, null, 1));
