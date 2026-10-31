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
  if (m.kind === "awakener") return awakenerSteps(ctx, m);
  const fixedTxt = ctx.fixedEntries.length ? ` that already has the fractured mod${ctx.fixedEntries.length > 1 ? "s" : ""} ${ctx.fixedEntries.map((e) => `"${one(e.mod.x)}"`).join(", ")}` : "";
  steps.push({
    title: `Get a ${ctx.base.name}${infl}`,
    detail: `Item level ${ctx.ilvl} (the plan was worked out at this level; at least ${minIlvl} is needed for the tiers you asked for)${fixedTxt}.${ctx.influences.length > 1 ? " A base with two influences comes from an Awakener's Orb (see that plan)." : ""}`,
  });
  if (["chaos", "essence", "fossil"].includes(m.kind)) steps.push(...rerollSteps(ctx, m));
  else if (m.kind === "altregal") {
    const s1 = m.stage1Targets.map((t) => `"${one(t.wantedMod.x)}"`).join(" and ");
    const frac = ctx.fixedEntries.length ? " The fractured mod stays through every alteration, so only the other side changes; use an Orb of Augmentation whenever that side comes out empty." : " Use an Orb of Augmentation when only one of them shows up and there's a free slot.";
    steps.push({ title: "Orb of Transmutation, then spam Orbs of Alteration", detail: `Goal: a magic item with ${s1}.${frac} ${pct(m.p1)} per alteration (about ${fmtN(1 / m.p1)} alterations, ${m.augPerAlt.toFixed(2)} augmentations per alteration).` });
    if (m.block?.eldritch) {
      const el = ctx.db.manual.eldritch, kind = m.block.eldritch;
      steps.splice(1, 0, eldritchSetupStep(ctx, kind));
      steps.push({ title: `Regal Orb, then ${el.orbs.exalt}s`, detail: `With the ${eldritchKindName(kind)} implicit dominant, each ${el.orbs.exalt} adds a ${sideName(m.block.onlySide)}, where the missing mods are. From a good magic item, ${pct(m.p2)} chance to finish (${m.avgExalts.toFixed(1)} eldritch exalts per attempt). Overall about ${fmtN(m.expectedAlts)} alterations, ${fmtN(m.expectedRegals)} regals and ${fmtN(m.expectedExalts)} eldritch exalts.` });
    } else if (m.block) {
      steps.push({ title: "Regal Orb", detail: "Adds one more random mod and makes the item rare." });
      steps.push({ title: `Bench craft "${m.block.mod.x}", then Exalted Orbs`, detail: `Costs ${fmtCost(m.block.cost)}. It takes a ${sideName(m.block.side)} while it's on, and the exalts can't roll ${m.block.tag} mods, so more of them land on the mods you want. If there's no free ${sideName(m.block.side)} after the regal, exalt without it.` });
      steps.push({ title: "Remove the crafted mod at the bench", detail: `From a good magic item, ${pct(m.p2)} chance that the regal + exalts finish the rest (${m.avgExalts.toFixed(1)} exalts per attempt on average). Overall about ${fmtN(m.expectedAlts)} alterations, ${fmtN(m.expectedRegals)} regals and ${fmtN(m.expectedExalts)} exalts.` });
    } else {
      steps.push({ title: "Regal Orb, then Exalted Orbs for the missing mods", detail: `From a good magic item, ${pct(m.p2)} chance that the regal + exalt slams finish the rest (${m.avgExalts.toFixed(1)} exalts per attempt on average). If a slam misses and you start over: about ${fmtN(m.expectedAlts)} alterations, ${fmtN(m.expectedRegals)} regals and ${fmtN(m.expectedExalts)} exalts in total.` });
      if (m.annul) steps.push(annulStep(m));
    }
  } else if (m.kind === "lock") {
    const L = sideName(m.lockSide);
    const s1 = rerollSteps(m.stage1Ctx, m.stage1, `${pct(m.stage1.p)} per try (about ${fmtN(1 / m.stage1.p)} tries).`);
    s1[0].title = `Stage 1 — ${s1[0].title}`;
    s1[0].detail += m.meta ? ` The other side doesn't matter yet, but leave a free ${sideName(m.meta.mod.g)} for the lock craft.` : " The other side doesn't matter yet.";
    steps.push(...s1);
    const assume = `Assumes the ${L}es fill the item apart from slots kept for bench crafts (${m.keptL} kept).`;
    if (m.eldritch) {
      const el = ctx.db.manual.eldritch;
      steps.splice(1, 0, eldritchSetupStep(ctx, m.eldritch));
      steps.push({
        title: `Stage 2 — ${el.orbs.chaos}; repeat`,
        detail: `With the ${eldritchKindName(m.eldritch)} implicit dominant it rerolls only the ${sideName(el.dominance[m.eldritch])}es and keeps every ${L}. Stop when the item has ${targetList(m.stage2Ctx)}. ${pct(m.p2)} per try (about ${fmtN(1 / m.p2)} tries). ${assume}`,
      });
    } else if (m.meta) {
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
  else if (m.kind === "influenceExalt") {
    const t = `"${one(m.target.mod.x)}"${m.target.mod !== m.target.wantedMod ? " or better" : ""}`;
    if (m.stage1) {
      const s1 = rerollSteps(ctx, m.stage1, `${pct(m.p1)} per try (about ${fmtN(1 / m.p1)} tries).`);
      s1[0].title = `Stage 1 — ${s1[0].title}`;
      s1[0].detail += ` Use a base without influence, and keep a ${sideName(m.target.side)} free.`;
      steps.push(...s1);
    }
    steps.push({
      title: `${m.stage1 ? "Stage 2 — " : ""}${m.orb}`,
      detail: `Adds ${m.influence} influence and one random ${m.influence} mod; ${pct(m.p2)} that it's ${t}. On a miss, start again from stage 1. Overall about ${fmtN(1 / m.p)} stage-1 tries and ${fmtN(1 / m.p2)} ${m.orb}s. Assumes the item has room on both sides, so the odds are on the safe side.`,
    });
  }
  else if (m.kind === "recomb") {
    const list = (x) => x.map((t) => `"${one(t.mod.x)}"`).join(" and ");
    steps.push({ title: `Magic item 1: Alterations until it has only ${list(m.A)}`, detail: `${pct(m.pA)} per alteration (about ${fmtN(1 / m.pA)}). It must have no other mods, or they dilute the pool.` });
    steps.push({ title: `Magic item 2: Alterations until it has only ${list(m.B)}`, detail: `${pct(m.pB)} per alteration (about ${fmtN(1 / m.pB)}).` });
    steps.push({ title: "Recombinator", detail: `Combines the two. The result keeps a random number of the pooled prefixes and of the pooled suffixes; ${pct(m.pc)} that it keeps all of them (community-measured table, approximate). About ${fmtN(m.attempts)} recombinations, ${fmtN(m.expected)} actions in all. Advanced: exclusive mods and extra random mods aren't modelled.` });
  }
  else if (m.kind === "veiledChaos") {
    const t = `"${one(m.target.mod.x)}"`;
    steps.push({ title: "Spam Veiled Chaos Orbs", detail: `Each one rerolls the item with a veiled mod. Keep it when the veiled mod is a ${sideName(m.target.side)} (assumed ${pct(m.sideChance)}) and the rest has ${targetList(ctx)} (${pct(m.pRest)}). Don't let a mod from the same group as ${t} roll: it would block the unveil.` });
    steps.push({ title: `Unveil at Jun and pick ${t}`, detail: `Jun offers 3 mods to choose from; ${pct(m.pU)} that ${t} is one of them. Overall ${pct(m.p)} per Veiled Chaos Orb, about ${fmtN(1 / m.p)} orbs.` });
  } else if (m.kind === "aisling") {
    const t = `"${one(m.target.mod.x)}"`;
    const s1 = rerollSteps(ctx, m.stage1, `${pct(m.p1)} per try (about ${fmtN(1 / m.p1)} tries).`);
    s1[0].title = `Stage 1 — ${s1[0].title}`;
    steps.push(...s1);
    steps.push({ title: "Stage 2 — Aisling (Research, Betrayal safehouse)", detail: `Removes a random mod and adds a veiled one. Assuming the item is full, the veiled mod lands on the side the removed mod came from, so it works when the removed mod is one of the ${m.junkZ} unwanted ${sideName(m.target.side)}es. Then unveil at Jun: ${pct(m.pU)} that ${t} is one of the 3 options. ${pct(m.p2)} per Aisling; on a miss, start again from stage 1.` });
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

function awakenerSteps(ctx, m) {
  const [A, B] = m.targets;
  const [X, Y] = m.influences;
  const t = (x) => `"${one(x.mod.x)}"${x.mod !== x.wantedMod ? " or better" : ""}`;
  const steps = [
    { title: `Get two ${ctx.base.name} bases, item level ${ctx.ilvl}, without influence`, detail: "Rare, with free slots. Each gets one influenced mod in the next steps." },
    { title: `${m.orbs[0]} on the first`, detail: `Adds ${X} influence and one ${X} mod; ${pct(m.pA)} that it's ${t(A)} (about ${fmtN(1 / m.pA)} orbs, on new bases after a miss).` },
    { title: `${m.orbs[1]} on the second`, detail: `Adds ${Y} influence and one ${Y} mod; ${pct(m.pB)} that it's ${t(B)} (about ${fmtN(1 / m.pB)} orbs).` },
    {
      title: "Awakener's Orb: sacrifice one onto the other",
      detail: `The result has both influences, keeps one influenced mod from each item (the only ones they have), and rolls new mods for the rest. ${m.pRest > 0 ? `${pct(m.pRest)} that it also has ${targetList(ctx)}, so about ${fmtN(m.attempts)} awakenings.` : "The rest of the wanted mods can't come from this roll."} You can also finish the rest with exalts or the bench instead of awakening again.`,
    },
  ];
  for (const c of ctx.crafts) steps.push({ title: `Bench craft "${one(c.option.mod.x)}"`, detail: `Costs ${fmtCost(c.option.cost)}. Needs a free ${sideName(c.option.mod.g)}.` });
  return steps;
}

const eldritchKindName = (kind) => (kind === "exarch" ? "Searing Exarch" : "Eater of Worlds");

function eldritchSetupStep(ctx, kind) {
  const el = ctx.db.manual.eldritch;
  const other = kind === "exarch" ? "eater" : "exarch";
  const cur = ctx.eldritch;
  let now = "";
  if (cur && cur.dominant === kind) now = ` Your item already has the ${eldritchKindName(kind)} implicit dominant.`;
  else if (cur && cur.dominant) now = ` Your item has the ${eldritchKindName(other)} implicit dominant: use ${el.orbs.conflict}s (each one upgrades one eldritch implicit and downgrades the other, at random) until it flips.`;
  return {
    title: `Make the ${eldritchKindName(kind)} implicit dominant`,
    detail: `Use ${el.implicitSource[kind]}s (and ${el.implicitSource[other]}s if needed) so the ${eldritchKindName(kind)} implicit has a higher tier than the ${eldritchKindName(other)} one; eldritch currency then works on ${sideName(el.dominance[kind])}es.${now}`,
  };
}

function annulStep(m) {
  const a = m.annul, c = a.currency;
  const times = a.maxAnnuls === 1 ? "once" : `up to ${a.maxAnnuls} times`;
  const counts = `about ${fmtN(c["Orb of Alteration"])} alterations, ${fmtN(c["Regal Orb"])} regals, ${fmtN(c["Exalted Orb"])} exalts and ${fmtN(c["Orb of Annulment"])} annulments in total`;
  let verdict;
  if (a.choice === "annul") verdict = `Annulling is cheaper at current prices: ${fmtN(a.cost)} vs ${fmtN(a.restartCost)} Chaos Orbs for starting over.`;
  else if (a.choice === "restart") verdict = `Starting over is cheaper at current prices: ${fmtN(a.restartCost)} vs ${fmtN(a.cost)} Chaos Orbs with annulments.`;
  else verdict = "Which is cheaper depends on prices; compare the totals.";
  return {
    title: "When an exalt misses: annul, or start over?",
    detail: `Instead of starting over, use an Orb of Annulment (it removes a random mod, sometimes a wanted one) ${times} per item and keep exalting: ${counts} (simulated, ${a.runs.toLocaleString()} runs per option). ${verdict}`,
  };
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
