import fs from "node:fs";
import { indexData } from "../public/js/engine/data.js";
import { parseItemText, identifyMods } from "../public/js/engine/parse.js";
import { ITEMS } from "./items.js";
import { db } from "./db.mjs";
const bad = [];
for (const [k, t] of Object.entries(ITEMS)) {
  const it = parseItemText(db, t);
  console.log("==", k, it.errors, it.base?.name, it.base?.id, it.ilvl, it.rarity, it.influences);
  if (it.errors.length) { bad.push(k); continue; }
  const r = identifyMods(db, it);
  for (const m of r.mods) console.log(`  ${m.side} T${m.tier}/${m.tierCount} ${m.mod.id} [${m.mod.n}] ${m.crafted ? "(crafted)" : ""} :: ${m.lines.join(" / ")}`);
  console.log("  unknown:", r.unknown);
  if (r.unknown.length) bad.push(k);
}
if (bad.length) { console.log("\nFAIL: unidentified lines in", bad.join(", ")); process.exitCode = 1; }
else console.log(`\nall ${Object.keys(ITEMS).length} samples fully identified`);
