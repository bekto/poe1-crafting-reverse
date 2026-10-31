// Turns a planned method into step-by-step instructions.
import { satisfies } from "./pool.js";

export function pickBench(t) {
  // cheapest bench option that is still good enough = the lowest tier that satisfies
  return [...t.bench].sort((a, b) => a.mod.l - b.mod.l)[0];
}

export function fmtCost(cost) {
  return Object.entries(cost || {}).map(([k, v]) => `${v}× ${currencyName(k)}`).join(", ");
}

export function currencyName(id) {
  const map = {
    CurrencyRerollRare: "Chaos Orb", CurrencyAddModToRare: "Exalted Orb", CurrencyRerollMagic: "Orb of Alteration",
    CurrencyUpgradeToRare: "Orb of Alchemy", CurrencyRerollSocketColours: "Chromatic Orb", CurrencyRerollSocketLinks: "Orb of Fusing",
    CurrencyRerollSocketNumbers: "Jeweller's Orb", CurrencyModValues: "Divine Orb", CurrencyConvertToNormal: "Orb of Scouring",
    CurrencyUpgradeMagicToRare: "Regal Orb", CurrencyAddModToMagic: "Orb of Augmentation", CurrencyUpgradeToMagic: "Orb of Transmutation",
    CurrencyRemoveMod: "Orb of Annulment", CurrencyRerollImplicit: "Blessed Orb", CurrencyIdentification: "Scroll of Wisdom",
    CurrencyArmourQuality: "Armourer's Scrap", CurrencyWeaponQuality: "Blacksmith's Whetstone", CurrencyPassiveRefund: "Orb of Regret",
    CurrencyVaal: "Vaal Orb", CurrencyGemQuality: "Gemcutter's Prism", CurrencyFlaskQuality: "Glassblower's Bauble",
    CurrencyDuplicate: "Mirror of Kalandra", CurrencyPortal: "Portal Scroll", CurrencyUpgradeRandomly: "Orb of Chance",
  };
  const key = id.split("/").pop();
  return map[key] || key.replace(/^Currency/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function pct(p) {
  if (p >= 0.1) return (p * 100).toFixed(1) + "%";
  if (p >= 0.001) return (p * 100).toFixed(2) + "%";
  return (p * 100).toPrecision(2) + "%";
}

export function fmtN(n) {
  if (n === null || n === undefined || !isFinite(n)) return "∞";
  if (n < 10) return n.toFixed(1);
  if (n < 1e4) return Math.round(n).toLocaleString();
  if (n < 1e6) return (n / 1e3).toFixed(1) + "k";
  return (n / 1e6).toFixed(1) + "M";
}

function fmtLifeforce(cost) {
  return Object.entries(cost).map(([k, v]) => `${v} ${k}`).join(", ");
}

const one = (x) => x.replace(/\n/g, " / ");
const sideName = (g) => (g === "p" ? "prefix" : "suffix");

function oddsText(m) {
  if (m.p > 0) return `${pct(m.p)} per try — about ${fmtN(m.expected)} tries on average${m.n90 ? `, ${fmtN(m.n90)} for a 90% chance` : ""}.`;
  if (m.exact) return "This method can't make this item.";
  return `Less than ${pct(m.upperBound)} per try in ${m.trials.toLocaleString()} simulated tries — not a realistic method for this item.`;
}

/** Steps for one reroll method (chaos / essence / fossil), without the "get a base" step. */
function rerollSteps(ctx, m, odds = oddsText(m)) {
  if (m.kind === "chaos") return [{ title: "Make it rare (Orb of Alchemy), then spam Chaos Orbs", detail: `Stop when the item has ${targetList(ctx)}. ${odds}` }];
  if (m.kind === "essence") {
    return [{ title: `Spam ${m.name}`, detail: `Every essence guarantees "${one(m.essenceMod.x)}" and rerolls the rest. Stop when it also has ${targetList(ctx, m.essenceMod)}. ${odds}${m.corrupt ? " This essence only comes from corrupting another essence with a Remnant of Corruption." : ""} Use an Orb of Scouring first if the item isn't normal or rare.` }];
  }
  if (m.kind === "harvest") {
    return [{ title: `Horticrafting Station: "${m.text}"`, detail: `Repeat until the item has ${targetList(ctx)}. ${odds} Harvest odds are approximate: the game doesn't publish how much more common the ${m.harvest.name} mods get (assumed ×${ctx.db.manual.harvest.moreCommonMultiplier}). Lifeforce cost: ${m.harvest.cost ? fmtLifeforce(m.harvest.cost) : "see the Horticrafting Station"}.` }];
  }
  if (m.kind === "fossil") {
    return [{ title: `Fossil craft: ${m.name} in a ${resonatorName(m.fossils.length)}`, detail: `Effects: ${m.fossils.flatMap((f) => f.desc).join("; ")}. Keep rerolling until the item has ${targetList(ctx)}. ${odds}` }];
  }
  return [];
}

function resonatorName(n) {
  return ["", "Primitive Chaotic Resonator", "Potent Chaotic Resonator", "Powerful Chaotic Resonator", "Prime Chaotic Resonator"][n];
}

export function buildSteps(ctx, m) {
  const steps = [];
  const infl = ctx.influences.length ? ` with ${ctx.influences.join(" + ")} influence` : "";
  const minIlvl = Math.max(ctx.base.lvl || 1, ...ctx.targets.map((t) => t.minIlvl || 1));
  const fixedTxt = ctx.fixedEntries.length ? ` that already has the fractured mod${ctx.fixedEntries.length > 1 ? "s" : ""} ${ctx.fixedEntries.map((e) => `"${one(e.mod.x)}"`).join(", ")}` : "";
  steps.push({
    title: `Get a ${ctx.base.name}${infl}`,
    detail: `Item level ${ctx.ilvl} (the plan was worked out at this level; at least ${minIlvl} is needed for the tiers you asked for)${fixedTxt}.`,
  });
  if (["chaos", "essence", "fossil"].includes(m.kind)) steps.push(...rerollSteps(ctx, m));
  else if (m.kind === "altregal") {
    const s1 = m.stage1Targets.map((t) => `"${one(t.wantedMod.x)}"`).join(" and ");
    steps.push({ title: "Orb of Transmutation, then spam Orbs of Alteration", detail: `Goal: a magic item with ${s1}. Use an Orb of Augmentation when only one of them shows up and there's a free slot. ${pct(m.p1)} per alteration (about ${fmtN(1 / m.p1)} alterations, ${m.augPerAlt.toFixed(2)} augmentations per alteration).` });
    if (m.block) {
      steps.push({ title: "Regal Orb", detail: "Adds one more random mod and makes the item rare." });
      steps.push({ title: `Bench craft "${m.block.mod.x}", then Exalted Orbs`, detail: `Costs ${fmtCost(m.block.cost)}. It takes a ${sideName(m.block.side)} while it's on, and the exalts can't roll ${m.block.tag} mods, so more of them land on the mods you want. If there's no free ${sideName(m.block.side)} after the regal, exalt without it.` });
      steps.push({ title: "Remove the crafted mod at the bench", detail: `From a good magic item, ${pct(m.p2)} chance that the regal + exalts finish the rest (${m.avgExalts.toFixed(1)} exalts per attempt on average). Overall about ${fmtN(m.expectedAlts)} alterations, ${fmtN(m.expectedRegals)} regals and ${fmtN(m.expectedExalts)} exalts.` });
    } else {
      steps.push({ title: "Regal Orb, then Exalted Orbs for the missing mods", detail: `From a good magic item, ${pct(m.p2)} chance that the regal + exalt slams finish the rest (${m.avgExalts.toFixed(1)} exalts per attempt on average). If a slam misses, start over. Overall about ${fmtN(m.expectedAlts)} alterations, ${fmtN(m.expectedRegals)} regals and ${fmtN(m.expectedExalts)} exalts.` });
    }
  } else if (m.kind === "lock") {
    const L = sideName(m.lockSide);
    const s1 = rerollSteps(m.stage1Ctx, m.stage1, `${pct(m.stage1.p)} per try (about ${fmtN(1 / m.stage1.p)} tries).`);
    s1[0].title = `Stage 1 — ${s1[0].title}`;
    s1[0].detail += m.meta ? ` The other side doesn't matter yet, but leave a free ${sideName(m.meta.mod.g)} for the lock craft.` : " The other side doesn't matter yet.";
    steps.push(...s1);
    const assume = `Assumes the ${L}es fill the item apart from slots kept for bench crafts (${m.keptL} kept).`;
    if (m.meta) {
      steps.push({
        title: `Stage 2 — bench craft "${m.meta.mod.x}", then a Chaos Orb; repeat`,
        detail: `The craft costs ${fmtCost(m.meta.cost)}. The Chaos Orb keeps every ${L} and rerolls the rest (removing the craft too, so craft it again before each Chaos Orb). Stop when the item has ${targetList(m.stage2Ctx)}. ${pct(m.p2)} per try (about ${fmtN(1 / m.p2)} tries). ${assume}`,
      });
    } else {
      steps.push({
        title: `Stage 2 — Horticrafting Station: "${m.harvestKeep.text}"; repeat`,
        detail: `Keeps every ${L} and rerolls the rest. Stop when the item has ${targetList(m.stage2Ctx)}. ${pct(m.p2)} per try (about ${fmtN(1 / m.p2)} tries). ${assume} Harvest odds are approximate. Lifeforce cost: ${m.harvestKeep.cost ? fmtLifeforce(m.harvestKeep.cost) : "see the Horticrafting Station"}.`,
      });
    }
  }
  const crafts = ctx.crafts;
  if (crafts.length > 1 && ctx.db.meta?.multimod) {
    const mm = ctx.db.meta.multimod;
    steps.push({ title: `If more than one of the bench crafts is missing: bench craft "${mm.mod.x}"`, detail: `Costs ${fmtCost(mm.cost)} and takes a ${sideName(mm.mod.g)}; the odds above already keep a slot for it.` });
  }
  for (const c of crafts) {
    const o = c.option;
    steps.push({ title: `Bench craft "${one(o.mod.x)}"${crafts.length > 1 ? " (unless it rolled)" : ""}`, detail: `Crafting bench, costs ${fmtCost(o.cost) || "a little currency"}. Needs a free ${sideName(o.mod.g)}, which the odds above already require.` });
  }
  return steps;
}

function targetList(ctx, except) {
  const list = ctx.hard.filter((t) => !(except && satisfies(except, t))).map((t) => `"${one(t.mod.x)}"${t.mod !== t.wantedMod ? " or better" : ""}`);
  const crafts = ctx.crafts;
  if (crafts.length === 1) list.push(`a free ${sideName(crafts[0].side)} for the bench craft`);
  else if (crafts.length > 1) list.push(`free slots for the bench crafts ("${crafts.map((c) => one(c.option.mod.x)).join('", "')}") and multimod`);
  if (ctx.reserve) {
    const r = [];
    if (ctx.reserve.p) r.push(`${ctx.reserve.p} free prefix`);
    if (ctx.reserve.s) r.push(`${ctx.reserve.s} free suffix`);
    if (r.length) list.push(r.join(" and "));
  }
  return list.length ? list.join(", ") : "the mods you want";
}
