import fs from "node:fs";
import { indexData } from "../public/js/engine/data.js";
import { parseItemText, identifyMods } from "../public/js/engine/parse.js";
import { ITEMS } from "./items.js";
const db = indexData(JSON.parse(fs.readFileSync(new URL("../public/data/poe1.json", import.meta.url))));
for (const [k, t] of Object.entries(ITEMS)) {
  const it = parseItemText(db, t);
  console.log("==", k, it.errors, it.base?.name, it.base?.id, it.ilvl, it.rarity, it.influences);
  if (it.errors.length) continue;
  const r = identifyMods(db, it);
  for (const m of r.mods) console.log(`  ${m.side} T${m.tier}/${m.tierCount} ${m.mod.id} [${m.mod.n}] ${m.crafted ? "(crafted)" : ""} :: ${m.lines.join(" / ")}`);
  console.log("  unknown:", r.unknown);
}
