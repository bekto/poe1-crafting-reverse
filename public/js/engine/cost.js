// Expected currency use per finished item for every kind of method, and its price.
import { currencyName } from "./steps.js";

const add = (u, name, n) => { if (n > 0 && isFinite(n)) u[name] = (u[name] || 0) + n; };
const addCost = (u, cost, times = 1) => { for (const [id, n] of Object.entries(cost || {})) add(u, currencyName(id), n * times); };
const addList = (u, list, times) => { for (const [name, n] of list || []) add(u, name, (n ?? 1) * times); };

/**
 * {currency name: expected amount} for one finished item. Items without a known amount (Harvest lifeforce,
 * Aisling) are counted by use, so they show up as "unpriced".
 */
export function usageOf(m, ctx) {
  const u = {};
  if (!(m.p > 0)) return null;
  const db = ctx.db;
  switch (m.kind) {
    case "chaos": case "essence": case "fossil": case "harvest":
      addList(u, m.currency, 1 / m.p);
      break;
    case "altregal": {
      const base = m.annul?.choice === "annul" ? m.annul.currency : m.restartCurrency;
      for (const [name, n] of Object.entries(base || {})) add(u, name === "Exalted Orb" && m.block?.eldritch ? db.manual.eldritch.orbs.exalt : name, n);
      if (m.block?.cost) addCost(u, m.block.cost, 1 / m.p2); // the meta craft, once per regal attempt
      break;
    }
    case "lock": {
      addList(u, m.stage1.currency, 1 / m.p1);
      if (m.meta) { addCost(u, m.meta.cost, 1 / m.p2); add(u, "Chaos Orb", 1 / m.p2); }
      else if (m.eldritch) add(u, db.manual.eldritch.orbs.chaos, 1 / m.p2);
      else add(u, "Harvest lifeforce", 1 / m.p2);
      break;
    }
    case "influenceExalt":
      if (m.stage1) addList(u, m.stage1.currency, 1 / (m.p1 * m.p2));
      add(u, m.orb, 1 / m.p2);
      break;
    case "awakener":
      add(u, m.orbs[0], m.attempts / m.pA);
      add(u, m.orbs[1], m.attempts / m.pB);
      add(u, "Awakener's Orb", m.attempts);
      break;
    case "veiledChaos":
      add(u, "Veiled Chaos Orb", 1 / m.p);
      break;
    case "aisling":
      addList(u, m.stage1.currency, 1 / (m.p1 * m.p2));
      add(u, "Aisling (Betrayal safehouse)", 1 / m.p2);
      break;
    case "recomb":
      add(u, "Orb of Alteration", m.attempts * (1 / m.pA + 1 / m.pB));
      add(u, recombinatorName(ctx.base), m.attempts);
      break;
    default:
      return null;
  }
  // bench crafts at the end, once
  for (const c of ctx.crafts) addCost(u, c.option?.cost);
  if (ctx.crafts.length > 1 && db.meta?.multimod) addCost(u, db.meta.multimod.cost);
  return u;
}

export function recombinatorName(base) {
  if (base.tags.includes("weapon")) return "Weapon Recombinator";
  if (base.tags.includes("armour")) return "Armour Recombinator";
  return "Jewellery Recombinator";
}

/** {chaos, divine, unpriced: [names]} for a usage map and a price table ({name: chaos}, plus divine). */
export function priceUsage(usage, prices) {
  if (!usage || !prices) return null;
  let chaos = 0;
  const unpriced = [];
  for (const [name, n] of Object.entries(usage)) {
    const pr = name === "Chaos Orb" ? 1 : prices.prices?.[name];
    if (pr >= 0) chaos += n * pr;
    else unpriced.push(name);
  }
  return { chaos, divine: prices.divine ? chaos / prices.divine : null, unpriced };
}
