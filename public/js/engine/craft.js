// Reverse-crafting planner for PoE 1: builds the targets, tries every covered method, and ranks them.
import { basePool, itemTags, spawnWeight, maxAffixes, satisfies, makeTarget, benchOptionsFor, craftReserve, unveiledPool } from "./pool.js";
import { MAGIC_TWO_MOD_CHANCE, rareModCounts, LOCKED_REROLL_MIN_NEW, VEILED_PREFIX_CHANCE, UNVEIL_CHOICES } from "./assumptions.js";
import { exactReroll, exactAltRegal, exactRerollFirstFrom, choiceChance } from "./exact.js";
import {
  mulberry32, CompiledPool, State, addRandom, success, blockedCrafts, fixedInfo, simulateReroll,
  stats, exactStats, targetMask, BLOCK_BITS,
} from "./sim.js";
import { buildSteps, pickBench } from "./steps.js";
import { simulateAnnulRoute, ANNUL_LIMITS } from "./annul.js";
import { stageOne } from "./stage1.js";
import { usageOf, priceUsage } from "./cost.js";

export { currencyName } from "./steps.js";

// how many of the best variants with multimod to keep next to the single-craft plans
const MULTIMOD_VARIANTS_KEPT = 4;
// Harvest tag reforges worked out per plan (the most promising by weight share)
const HARVEST_TAGS_KEPT = 4;
// time for one whole plan; whatever is left after the first pass refines the simulated estimates
export const PLAN_TIME_BUDGET_MS = 2500;

/**
 * Plan context: base, targets split into rolled ("hard") targets and bench-crafted ones.
 * opts.maxCrafts: 1, or 2 with "Can have up to 3 Crafted Modifiers". opts.reserve: extra free slots the
 * finished roll needs (for a metacraft). opts.caps / opts.counts: affix limits and mod counts of the roll.
 */
export function buildContext(db, base, ilvl, influences, wanted, fixed = [], opts = {}) {
  // wanted: [{mod, minMod}] where minMod is the lowest acceptable tier mod
  const groupIndex = new Map();
  const gid = (g) => { if (!groupIndex.has(g)) groupIndex.set(g, groupIndex.size); return groupIndex.get(g); };
  const pool = opts.pool || basePool(db, base, influences, ilvl);
  const totalW = { p: 0, s: 0 };
  for (const e of pool) totalW[e.mod.g] += e.w;

  const targets = wanted.map((w) => {
    const t = makeTarget(w.minMod, { wantedMod: w.mod });
    const natural = pool.filter((e) => satisfies(e.mod, t));
    t.naturalWeight = natural.reduce((a, e) => a + e.w, 0);
    t.share = t.naturalWeight / (totalW.p + totalW.s || 1);
    t.bench = opts.noBench ? [] : benchOptionsFor(db, base, t);
    t.minIlvl = natural.length ? Math.min(...natural.map((e) => e.mod.l)) : null;
    return t;
  });
  // bench craft the bench-able targets that are hardest to roll naturally (or the ones given in opts.craftMods)
  const maxCrafts = db.meta?.multimod ? opts.maxCrafts ?? 1 : Math.min(1, opts.maxCrafts ?? 1);
  const benchable = targets.filter((t) => t.bench.length);
  benchable.sort((a, b) => a.naturalWeight - b.naturalWeight);
  const crafts = opts.craftMods ? benchable.filter((t) => opts.craftMods.includes(t.wantedMod)) : benchable.slice(0, maxCrafts);
  for (const c of crafts) c.option = pickBench(c);
  const hard = targets.filter((t) => !crafts.includes(t));
  return {
    db, base, ilvl, influences, pool, targets, hard, crafts, totalW, gid, groupIndex,
    tags: itemTags(db, base, influences),
    fixedEntries: fixed.map((m) => ({ mod: m })),
    extraBenchable: benchable.filter((t) => !crafts.includes(t)),
    multimodSide: db.meta?.multimod?.mod.g || "s",
    reserve: opts.reserve || null,
    caps: opts.caps || maxAffixes(base),
    counts: opts.counts || rareModCounts(base),
    noExact: !!opts.noExact,
    prices: opts.prices || null,
    eldritch: opts.eldritch || null, // the item's eldritch implicits as parsed ({dominant})
    absentGroups: opts.absentGroups || null, // mod groups the roll must leave empty
  };
}

/** Exact odds for small cases, otherwise a Monte Carlo estimate that the planner can refine. */
function rerollOdds(ctx, entries, forced, trials, seed) {
  if (!ctx.noExact) {
    const ex = exactReroll(ctx, entries, [...ctx.fixedEntries.map((e) => e.mod), ...forced]);
    if (ex) return exactStats(ex.p);
  }
  const P = new CompiledPool(ctx, entries);
  const run = (n, sd) => simulateReroll(ctx, P, forced, n, sd);
  return { rerun: run, ...stats(run(trials, seed), trials) };
}

// ---------------------------------------------------------------- reroll methods
function chaosMethod(ctx, trials) {
  return { kind: "chaos", name: "Chaos Orb spam", currency: [["Chaos Orb", 1]], ...rerollOdds(ctx, ctx.pool, [], trials, 1) };
}

function essenceMethods(ctx, trials) {
  const out = [];
  const families = new Map();
  for (const e of ctx.db.essences) {
    const modId = e.mods[ctx.base.cls];
    if (!modId) continue;
    const mod = ctx.db.modById.get(modId);
    if (!mod) continue;
    if (e.ilvl && ctx.ilvl < e.ilvl) continue;
    if (ctx.caps[mod.g] <= 0) continue; // a locked side can't take the essence mod
    if (!targetMask(mod, ctx.hard) && !targetMask(mod, ctx.crafts)) continue;
    const fam = e.name.replace(/^\S+ Essence of /, "Essence of ");
    // keep the cheapest (lowest level) essence of a family that still hits the target
    const prev = families.get(fam);
    if (!prev || e.level < prev.e.level) families.set(fam, { e, mod });
  }
  let seed = 100;
  for (const { e, mod } of families.values()) {
    out.push({
      kind: "essence", name: e.name, currency: [[e.name, 1]], essenceMod: mod,
      corrupt: e.corrupt, ...rerollOdds(ctx, ctx.pool, [mod], trials, seed++),
    });
  }
  return out;
}

function fossilApplicable(ctx, f) {
  if (f.name === "Fractured Fossil") return false; // makes a copy, not a crafting step
  if (f.allowed.length && !f.allowed.some((t) => ctx.tags.has(t))) return false;
  if (f.forbidden.some((t) => ctx.tags.has(t))) return false;
  return true;
}

function fossilPool(ctx, fossils) {
  const entries = [];
  const mult = (mod) => {
    let m = 1;
    for (const f of fossils) {
      for (const [tag, w] of f.neg) if (mod.t.includes(tag)) m *= w / 100;
      for (const [tag, w] of f.pos) if (mod.t.includes(tag)) m *= w / 100;
    }
    return m;
  };
  for (const e of ctx.pool) {
    const w = e.w * mult(e.mod);
    if (w > 0) entries.push({ mod: e.mod, w });
  }
  const added = new Set(fossils.flatMap((f) => f.added));
  for (const id of added) {
    const mod = ctx.db.modById.get(id);
    if (!mod || mod.l > ctx.ilvl || ctx.caps[mod.g] <= 0) continue;
    const w = spawnWeight(mod, ctx.tags) * mult(mod);
    if (w > 0) entries.push({ mod, w });
  }
  const forced = fossils.flatMap((f) => f.forced).map((id) => ctx.db.modById.get(id)).filter(Boolean);
  return { entries, forced };
}

function fossilMethods(ctx, trials) {
  const targetTags = new Set([...ctx.hard, ...ctx.crafts].flatMap((t) => t.mod.t));
  const singles = ctx.db.fossils.filter((f) => fossilApplicable(ctx, f));
  const relevant = singles.filter((f) =>
    f.pos.some(([tag]) => targetTags.has(tag)) ||
    f.neg.some(([tag, w]) => w === 0 && !targetTags.has(tag)));
  // rank fossil combos by how much they raise the weight share of the wanted mods (cheap, no simulation)
  const shareScore = (entries) => {
    let tot = 0;
    for (const e of entries) tot += e.w;
    let score = 0;
    for (const t of ctx.hard) {
      let w = 0;
      for (const e of entries) if (satisfies(e.mod, t)) w += e.w;
      if (w <= 0) return -Infinity;
      score += Math.log(w / tot);
    }
    return score;
  };
  const scored = relevant.map((f) => ({ f, s: shareScore(fossilPool(ctx, [f]).entries) })).filter((x) => isFinite(x.s));
  scored.sort((a, b) => b.s - a.s);
  const top = scored.slice(0, 6).map((x) => x.f);
  const combos = top.map((f) => [f]);
  for (let i = 0; i < top.length; i++)
    for (let j = i + 1; j < top.length; j++) {
      combos.push([top[i], top[j]]);
      for (let k = j + 1; k < top.length; k++) combos.push([top[i], top[j], top[k]]);
    }
  const ranked = combos.map((c) => ({ c, s: shareScore(fossilPool(ctx, c).entries) })).filter((x) => isFinite(x.s));
  ranked.sort((a, b) => b.s - a.s);
  let seed = 500;
  return ranked.slice(0, 5).map(({ c }) => {
    const { entries, forced } = fossilPool(ctx, c);
    return {
      kind: "fossil",
      name: c.map((f) => f.name).join(" + "),
      fossils: c,
      currency: [...c.map((f) => [f.name, 1]), [resonatorName(c.length), 1]],
      ...rerollOdds(ctx, entries, forced, trials, seed++),
    };
  });
}

export function resonatorName(n) {
  return ["", "Primitive Chaotic Resonator", "Potent Chaotic Resonator", "Powerful Chaotic Resonator", "Prime Chaotic Resonator"][n];
}

/**
 * Harvest "Reforge a Rare item with new random modifiers, including a <tag> modifier": the first mod has the tag,
 * and the tag's mods are more common for the rest (data/manual/harvest.json). Only tags a wanted mod has.
 */
function harvestTagMethods(ctx, trials) {
  const h = ctx.db.manual?.harvest;
  const league = ctx.db.manual?.league;
  const crafts = [
    ...(h ? h.reforgeTag.map((r) => ({ ...r, mult: h.moreCommonMultiplier, approximate: !!h.approximate, label: `Harvest: reforge including a ${r.name} modifier`, text: h.reforgeTagText.replaceAll("{name}", r.name), currency: "Harvest lifeforce" })) : []),
    // the league mechanic's reforges, when league.json lists any
    ...(league?.crafts || []).filter((c) => c.type === "tagReforge").map((c) => ({ ...c, mult: c.moreCommonMultiplier ?? 10, approximate: true, label: `${league.mechanic}: ${c.name}`, league: true, currency: c.name })),
  ];
  const wantedTags = new Set([...ctx.hard, ...ctx.crafts].flatMap((t) => t.mod.t));
  // rank the tags cheaply (how much they raise the wanted mods' share, as for fossils) and work out the best few
  const shareOf = (entries) => {
    const tot = entries.reduce((a, e) => a + e.w, 0);
    let sc = 0;
    for (const t of ctx.hard) {
      const w = entries.filter((e) => satisfies(e.mod, t)).reduce((a, e) => a + e.w, 0);
      sc += Math.log((w || 1e-12) / tot);
    }
    return sc;
  };
  const candidates = [];
  for (const r of crafts) {
    if (!wantedTags.has(r.tag)) continue;
    const entries = ctx.pool.map((e) => ({ mod: e.mod, w: e.mod.t.includes(r.tag) ? e.w * r.mult : e.w }));
    const first = entries.filter((e) => e.mod.t.includes(r.tag));
    if (first.length) candidates.push({ r, entries, first, score: shareOf(entries) });
  }
  candidates.sort((a, b) => b.score - a.score);
  const out = [];
  let seed = 300;
  for (const { r, entries, first } of candidates.slice(0, HARVEST_TAGS_KEPT)) {
    const base = { kind: "harvest", name: r.label, harvest: r, league: !!r.league, approximate: r.approximate, text: r.text, mult: r.mult, currency: [[r.currency, r.cost ?? null]] };
    const fixed = ctx.fixedEntries.map((e) => e.mod);
    const ex = ctx.noExact ? null : exactRerollFirstFrom(ctx, entries, first, fixed);
    if (ex) { out.push({ ...base, ...exactStats(ex.p) }); continue; }
    const P = new CompiledPool(ctx, entries);
    const only = Uint8Array.from(entries.map((e) => (e.mod.t.includes(r.tag) ? 1 : 0)));
    const run = (n, sd) => simulateReroll(ctx, P, [], n, sd, only);
    out.push({ ...base, rerun: run, ...stats(run(trials, seed), trials) });
    seed++;
  }
  return out;
}

function rerollMethods(ctx, trials) {
  return [chaosMethod(ctx, trials), ...essenceMethods(ctx, trials), ...fossilMethods(ctx, Math.floor(trials / 2)), ...harvestTagMethods(ctx, trials)];
}

// ---------------------------------------------------------------- alteration route

/** The stage-1 goal of the alteration route: the hardest prefix target and the hardest suffix target. */
export function stageOneTargets(ctx) {
  const pick = (side) => ctx.hard.map((t, i) => ({ t, i })).filter((x) => x.t.side === side).sort((a, b) => a.t.naturalWeight - b.t.naturalWeight)[0];
  // a fractured mod fills its side of the magic item
  const full = new Set((ctx.fixedEntries || []).map((e) => e.mod.g));
  return [pick("p"), pick("s")].filter((x) => x && !full.has(x.t.side));
}

/**
 * Alteration (+augment) until the 1-2 hardest mods are hit, then regal, then exalted slams.
 * block: {key, tag, mod, side} for a "Cannot roll ... Modifiers" craft during the exalts.
 */
function altRegalMethod(ctx, trials, block = null) {
  if (!ctx.hard.length) return null;
  // a fractured mod stays through alterations; with one fractured mod the magic item has one open side
  const fixedMods = ctx.fixedEntries.map((e) => e.mod);
  if (fixedMods.length > 1 || (fixedMods.length && !fixedMods.every((m) => m.g === "p" || m.g === "s"))) return null;
  const s1 = stageOneTargets(ctx);
  if (!s1.length) return null;
  const ex = ctx.noExact ? null : exactAltRegal(ctx, s1, block);
  if (ex) return altRegalResult(ctx, s1, ex, true, block);

  const P = new CompiledPool(ctx, ctx.pool);
  const rng = mulberry32(900); // same stage 1 for every variant
  const st = new State(ctx.groupIndex.size + 8);
  st.bind(P);
  const rareMax = maxAffixes(ctx.base);
  const metaSide = block?.tag ? (block.side === "p" ? 0 : 1) : -1;
  const onlySide = block?.onlySide ? (block.onlySide === "p" ? 0 : 1) : -1;
  const blockBit = block ? BLOCK_BITS[block.tag] : 0;

  // stage 1 in closed form; stage 2 starts from good magic items drawn directly
  const so = stageOne(ctx, s1);
  if (!so || so.p1 <= 0) return null;
  const { p1, augPerAlt } = so;

  // stage 2 starting from successful magic items
  const n2 = Math.max(4000, trials);
  let h2 = 0, exalts = 0;
  for (let t = 0; t < n2; t++) {
    st.reset(rareMax);
    for (const m of so.sample(rng)) { const f = fixedInfo(ctx, m); st.add(f.side, f.groups, f.mask, f.craftMask); }
    addRandom(P, st, rng); // regal
    // the meta craft fills a slot while it's on; it comes off before the bench crafts
    const meta = !!block?.tag && st.free(metaSide) > 0;
    if (meta) st.max[metaSide === 0 ? "p" : "s"]--;
    const room = meta ? metaSide : null;
    let used = 0;
    while (!success(ctx, P, st, room)) {
      // stop when the remaining targets can no longer fit
      const need = [0, 0];
      ctx.hard.forEach((tg, i) => { if (!(st.mask & (1 << i))) need[tg.side === "p" ? 0 : 1]++; });
      const r = craftReserve(ctx.crafts, P.allCrafts & ~st.craftMask & ~blockedCrafts(P, st), ctx.multimodSide, ctx.reserve);
      const real = (sd) => st.free(sd) + (room === sd ? 1 : 0);
      if (need[0] > st.free(0) || need[1] > st.free(1) || need[0] + r.p > real(0) || need[1] + r.s > real(1) || st.free(0) + st.free(1) <= 0) break;
      if (onlySide >= 0 && (need[1 - onlySide] > 0 || st.free(onlySide) <= 0)) break;
      if (!addRandom(P, st, rng, meta ? blockBit : 0, null, onlySide)) break;
      used++;
    }
    exalts += used;
    if (success(ctx, P, st, room)) h2++;
  }
  return altRegalResult(ctx, s1, { p1, p2: h2 / n2, augPerAlt, avgExalts: exalts / n2 }, false, block);
}

function altRegalResult(ctx, s1, r, exact, block) {
  const total = r.p1 * r.p2;
  const restart = total > 0 ? {
    "Orb of Alteration": 1 / total, "Orb of Augmentation": r.augPerAlt / total, "Regal Orb": 1 / r.p2, "Exalted Orb": r.avgExalts / r.p2,
  } : null;
  // when exalts can miss, compare annulling a miss (up to K times per item) with starting over right away
  let annul = null;
  if (!block && r.p1 > 0 && r.p2 < 1 - 1e-9) {
    const options = [];
    for (const K of ANNUL_LIMITS) {
      const a = simulateAnnulRoute(ctx, s1, K);
      if (!(a.ps > 0)) continue;
      options.push({
        maxAnnuls: K, ps: a.ps, runs: a.runs,
        currency: {
          "Orb of Alteration": 1 / (r.p1 * a.ps), "Orb of Augmentation": r.augPerAlt / (r.p1 * a.ps), "Regal Orb": 1 / a.ps,
          "Exalted Orb": a.exalts / a.ps, "Orb of Annulment": a.annuls / a.ps,
        },
      });
    }
    if (options.length) {
      const cr = costOf(restart, ctx.prices);
      for (const o of options) o.cost = costOf(o.currency, ctx.prices);
      const priced = options.filter((o) => o.cost !== null);
      // without prices, show the variant that annuls at most once
      const best = priced.length ? priced.sort((a, b) => a.cost - b.cost)[0] : options[0];
      annul = { ...best, options, restartCost: cr, choice: cr !== null && best.cost !== null ? (best.cost < cr ? "annul" : "restart") : null };
    }
  }
  return {
    restartCurrency: restart,
    annul,
    kind: "altregal",
    name: block?.eldritch ? `Alteration → Regal → ${ctx.db.manual.eldritch.orbs.exalt}` : block ? `Alteration → Regal → "${block.mod.x}" + Exalted Orb` : "Alteration → Regal → Exalted Orb",
    block,
    stage1Targets: s1.map((x) => x.t),
    p1: r.p1, p2: r.p2, augPerAlt: r.augPerAlt, avgExalts: r.avgExalts,
    currency: [["Orb of Alteration", 1]],
    ...(exact ? exactStats(total) : stats(Math.round(total * 1e6), 1e6)),
    p: total,
    expectedAlts: total > 0 ? 1 / total : null,
    expectedRegals: r.p2 > 0 ? 1 / r.p2 : null,
    expectedExalts: r.p2 > 0 ? r.avgExalts / r.p2 : null,
  };
}

/** Total cost in Chaos Orbs of {currency name: amount}, or null without a price for every item. */
export function costOf(amounts, prices) {
  if (!amounts || !prices) return null;
  prices = prices.prices || prices; // prices.json shape {divine, prices: {...}} or a plain {name: chaos}
  let c = 0;
  for (const [name, n] of Object.entries(amounts)) {
    if (!(n > 0)) continue;
    const pr = name === "Chaos Orb" ? 1 : prices[name];
    if (!(pr >= 0)) return null;
    c += n * pr;
  }
  return c;
}

/** "Cannot roll Attack/Caster Modifiers" variants that help: the exalts still need mods without that tag. */
function blockVariants(ctx) {
  const out = [];
  for (const [key, tag] of [["noAttack", "attack"], ["noCaster", "caster"]]) {
    const meta = ctx.db.meta?.[key];
    if (!meta) continue;
    if ([...ctx.hard, ...ctx.crafts].some((t) => t.mod.t.includes(tag))) continue;
    const blocked = ctx.pool.filter((e) => e.mod.t.includes(tag)).reduce((a, e) => a + e.w, 0);
    if (blocked <= 0) continue;
    out.push({ key, tag, mod: meta.mod, cost: meta.cost, side: meta.mod.g });
  }
  return out;
}

// ---------------------------------------------------------------- side lock: bench lock + Chaos, or Harvest keep-side reforge

/**
 * Two stages: first roll the wanted mods of one side with the best reroll method, then reroll only the other side
 * until it's right: with the bench lock craft + Chaos Orb (the Chaos Orb keeps the locked side and removes the lock
 * craft, so each try needs a new one, and stage 1 must leave a slot for it), or with Harvest's
 * "Reforge a Rare item, keeping all Prefixes/Suffixes".
 */
function lockMethods(ctx, trials, wanted) {
  const out = [];
  const db = ctx.db;
  const h = db.manual?.harvest;
  const lockers = [
    ...[["p", "lockPrefixes"], ["s", "lockSuffixes"]].filter(([, k]) => db.meta?.[k]).map(([L, k]) => ({ L, meta: db.meta[k] })),
    ...(h?.reforgeKeep || []).map((k) => ({ L: k.keep, harvest: k, approximate: !!h.approximate })),
    ...(db.manual?.league?.crafts || []).filter((c) => c.type === "keepSide").map((c) => ({ L: c.keep, harvest: { ...c, cost: null }, approximate: true })),
    // Eldritch Chaos Orb with the other side's influence dominant
    ...(eldritchCapable(ctx) ? Object.entries(db.manual.eldritch.dominance).map(([kind, side]) => ({ L: side === "p" ? "s" : "p", eldritch: kind })) : []),
  ];
  const stage1Cache = new Map(), stage2Cache = new Map(); // lockers on the same side share their sub-plans
  for (const lk of lockers) {
    const { L, meta } = lk;
    const O = L === "p" ? "s" : "p";
    const onL = ctx.hard.filter((t) => t.side === L), onO = ctx.hard.filter((t) => t.side === O);
    if (!onL.length || !onO.length || ctx.fixedEntries.length) continue;
    const pick = (list) => wanted.filter((w) => list.some((t) => t.wantedMod === w.mod));
    const craftL = ctx.crafts.filter((c) => c.side === L), craftO = ctx.crafts.filter((c) => c.side === O);
    // stage 1: wanted mods (and bench crafts) of side L, plus a free slot for a lock craft
    const reserve = { p: 0, s: 0 };
    if (meta) reserve[meta.mod.g]++;
    const k1 = `${L}:${reserve.p}${reserve.s}`;
    if (!stage1Cache.has(k1)) {
      const c1 = buildContext(db, ctx.base, ctx.ilvl, ctx.influences, pick(onL).concat(pickCrafts(wanted, craftL)), [], { reserve, noExact: ctx.noExact, craftMods: craftL.map((c) => c.wantedMod) });
      const best = rerollMethods(c1, Math.floor(trials / 2)).filter((m) => m.p > 0).sort((a, b) => b.p - a.p)[0] || null;
      if (best) delete best.rerun;
      stage1Cache.set(k1, { ctx1: c1, best });
    }
    const { ctx1, best: stage1 } = stage1Cache.get(k1);
    if (!stage1) continue;
    // stage 2: keeps side L; new mods only on side O. Assume side L is full apart from slots kept for crafts.
    const keptL = ctx.caps[L] - craftL.length;
    const caps = { [L]: 0, [O]: ctx.caps[O] };
    const counts = mergeCounts(ctx.counts.map(([n, p]) => [Math.min(caps[O], Math.max(LOCKED_REROLL_MIN_NEW, n - keptL)), p]));
    const pool = ctx.pool.filter((e) => e.mod.g === O);
    if (!stage2Cache.has(L)) {
      const c2 = buildContext(db, ctx.base, ctx.ilvl, ctx.influences, pick(onO).concat(pickCrafts(wanted, craftO)), [], { caps, counts, pool, noExact: ctx.noExact, craftMods: craftO.map((c) => c.wantedMod) });
      const odds = rerollOdds(c2, c2.pool, [], trials, 777);
      delete odds.rerun;
      stage2Cache.set(L, { ctx2: c2, r2: odds });
    }
    const { ctx2, r2 } = stage2Cache.get(L);
    const p1 = stage1.p, p2 = r2.p;
    const tries = p1 > 0 && p2 > 0 ? 1 / p1 + 1 / p2 : null;
    const second = meta ? `"${meta.mod.x}" + Chaos Orb` : lk.eldritch ? `${db.manual.eldritch.orbs.chaos} (${eldritchName(lk.eldritch)} dominant)` : `Harvest "${lk.harvest.text}"`;
    out.push({
      kind: "lock",
      name: `${stage1.name}, then ${second}`,
      lockSide: L, meta, harvestKeep: lk.harvest || null, eldritch: lk.eldritch || null, stage1, stage1Ctx: ctx1, stage2Ctx: ctx2,
      approximate: !!(lk.approximate || stage1.approximate),
      p1, p2, keptL,
      exact: !!(stage1.exact && r2.exact),
      hits: stage1.exact && r2.exact ? null : Math.min(stage1.hits ?? Infinity, r2.hits ?? Infinity),
      trials: r2.trials,
      p: tries ? 1 / tries : 0,
      expected: tries,
      n90: null,
      upperBound: tries ? null : 3 / trials,
      currency: [...stage1.currency, meta ? ["Chaos Orb", 1] : lk.eldritch ? [db.manual.eldritch.orbs.chaos, 1] : ["Harvest lifeforce", lk.harvest.cost]],
    });
  }
  return out;
}

// ---------------------------------------------------------------- influence: influenced Exalted Orbs and Awakener's Orb

const cap1 = (s) => s[0].toUpperCase() + s.slice(1);
export const influenceExaltName = (inf) => `${cap1(inf)}'s Exalted Orb`;

/** The influence a mod needs on this base (null for normal mods). */
export function modInfluence(db, base, mod) {
  const infl = db.classes[base.cls]?.influence || {};
  for (const [name, tag] of Object.entries(infl)) if (mod.sw.some(([t, w]) => t === tag && w > 0)) return name;
  return null;
}

/** Weighted mods an influenced Exalted Orb can add: the influence's own mods only. */
function influencePool(ctx, inf) {
  const normal = new Set(basePool(ctx.db, ctx.base, [], ctx.ilvl).map((e) => e.mod.id));
  return basePool(ctx.db, ctx.base, [inf], ctx.ilvl).filter((e) => !normal.has(e.mod.id));
}

/** Chance that one influenced Exalted Orb adds a mod meeting target t (assumes both sides have room). */
function influenceExaltChance(ctx, inf, t) {
  const pool = influencePool(ctx, inf);
  const tot = pool.reduce((a, e) => a + e.w, 0);
  const hit = pool.filter((e) => satisfies(e.mod, t)).reduce((a, e) => a + e.w, 0);
  return tot > 0 ? hit / tot : 0;
}

/**
 * One influence on the item and one wanted influenced mod: roll everything else on a base without influence
 * (leaving a slot on that mod's side), then slam the influenced Exalted Orb. A miss means starting over.
 */
function influenceExaltMethods(ctx, trials, wanted) {
  if (ctx.influences.length !== 1 || ctx.fixedEntries.length) return [];
  const inf = ctx.influences[0];
  const infTargets = ctx.hard.filter((t) => modInfluence(ctx.db, ctx.base, t.mod) === inf);
  if (infTargets.length !== 1) return [];
  const T = infTargets[0];
  const p2 = influenceExaltChance(ctx, inf, T);
  if (!(p2 > 0)) return [];
  const rest = wanted.filter((w) => w.mod !== T.wantedMod);
  const reserve = { p: 0, s: 0 };
  reserve[T.side]++;
  const ctx1 = buildContext(ctx.db, ctx.base, ctx.ilvl, [], rest, [], { reserve, noExact: ctx.noExact, prices: ctx.prices, craftMods: ctx.crafts.map((c) => c.wantedMod) });
  const stage1 = ctx1.hard.length || ctx1.crafts.length ? rerollMethods(ctx1, Math.floor(trials / 2)).filter((m) => m.p > 0).sort((a, b) => b.p - a.p)[0] : null;
  if ((ctx1.hard.length || ctx1.crafts.length) && !stage1) return [];
  if (stage1) delete stage1.rerun;
  const p1 = stage1 ? stage1.p : 1;
  const orb = influenceExaltName(inf);
  return [{
    kind: "influenceExalt",
    name: `${stage1 ? stage1.name + ", then " : ""}${orb}`,
    influence: inf, orb, target: T, stage1, stage1Ctx: ctx1, ctx: ctx1,
    p1, p2, p: p1 * p2,
    exact: !stage1 || !!stage1.exact, hits: stage1?.hits ?? null, trials: stage1?.trials ?? null,
    expected: p1 * p2 > 0 ? 1 / (p1 * p2) : null, n90: null,
    currency: [...(stage1 ? stage1.currency : []), [orb, 1]],
  }];
}

/**
 * Two influences and a wanted influenced mod from each: slam one influenced mod onto each of two bases with the
 * influenced Exalted Orbs, then combine them with an Awakener's Orb, which keeps those two mods and rolls the rest.
 */
function awakenerMethods(ctx, trials, wanted) {
  if (ctx.influences.length !== 2 || ctx.fixedEntries.length) return [];
  const [X, Y] = ctx.influences;
  const tx = ctx.hard.filter((t) => modInfluence(ctx.db, ctx.base, t.mod) === X);
  const ty = ctx.hard.filter((t) => modInfluence(ctx.db, ctx.base, t.mod) === Y);
  if (tx.length !== 1 || ty.length !== 1) return [];
  const pA = influenceExaltChance(ctx, X, tx[0]), pB = influenceExaltChance(ctx, Y, ty[0]);
  if (!(pA > 0 && pB > 0)) return [];
  // the awakened item keeps the two influenced mods; the rest of the wanted mods have to come from its new roll
  const keep = [tx[0], ty[0]].map((t) => influencePool(ctx, modInfluence(ctx.db, ctx.base, t.mod)).find((e) => satisfies(e.mod, t)).mod);
  const restWanted = wanted.filter((w) => w.mod !== tx[0].wantedMod && w.mod !== ty[0].wantedMod);
  const ctx2 = buildContext(ctx.db, ctx.base, ctx.ilvl, ctx.influences, restWanted, keep, { noExact: ctx.noExact, prices: ctx.prices, craftMods: ctx.crafts.map((c) => c.wantedMod) });
  const r = rerollOdds(ctx2, ctx2.pool, [], trials, 888);
  delete r.rerun;
  const pRest = r.p;
  const attempts = pRest > 0 ? 1 / pRest : null;
  const actions = attempts ? attempts * (1 / pA + 1 / pB + 1) : null;
  const ox = influenceExaltName(X), oy = influenceExaltName(Y);
  return [{
    kind: "awakener",
    name: `${ox} + ${oy}, then Awakener's Orb`,
    influences: [X, Y], orbs: [ox, oy], targets: [tx[0], ty[0]], pA, pB, pRest, attempts, ctx: ctx2,
    p: actions ? 1 / actions : 0, expected: actions, n90: null,
    exact: !!r.exact, hits: r.hits ?? null, trials: r.trials ?? null, upperBound: actions ? null : r.upperBound,
    currency: [[ox, 1], [oy, 1], ["Awakener's Orb", 1]],
  }];
}

// ---------------------------------------------------------------- eldritch

/** Can this base get Searing Exarch / Eater of Worlds implicits (and so use eldritch currency)? */
export function eldritchCapable(ctx) {
  if (!ctx.db.manual?.eldritch) return false;
  const tags = new Set(ctx.base.tags);
  return ctx.db.eldritch.some((m) => m.sw.some(([t]) => tags.has(t)));
}

export const eldritchName = (kind) => (kind === "exarch" ? "Searing Exarch" : "Eater of Worlds");

/** Alteration route where the exalts are Eldritch Exalted Orbs: only the side that still misses mods gets new mods. */
function eldritchExaltVariant(ctx) {
  if (!eldritchCapable(ctx)) return null;
  const s1 = stageOneTargets(ctx);
  const missing = ctx.hard.filter((t) => !s1.some((x) => x.t === t));
  const sides = new Set(missing.map((t) => t.side));
  if (sides.size !== 1) return null;
  const side = [...sides][0];
  const kind = Object.entries(ctx.db.manual.eldritch.dominance).find(([, sd]) => sd === side)?.[0];
  return kind ? { eldritch: kind, onlySide: side } : null;
}

// ---------------------------------------------------------------- veiled mods

/**
 * One wanted unveiled mod: a Veiled Chaos Orb (reroll with a veiled mod, then unveil at Jun and pick it from the
 * options), or Aisling on an item that already has the rest (removes a random mod, adds a veiled one).
 */
function veiledMethods(ctx, trials, wanted) {
  const veiled = ctx.hard.filter((t) => t.wantedMod.d === "u");
  if (veiled.length !== 1) return [];
  const U = veiled[0], Z = U.side;
  const uPool = unveiledPool(ctx.db, ctx.base, ctx.influences, ctx.ilvl).filter((e) => e.mod.g === Z);
  const pU = choiceChance(uPool, U, UNVEIL_CHOICES);
  if (!(pU > 0)) return [];
  const rest = wanted.filter((w) => w.mod !== U.wantedMod);
  const fixed = ctx.fixedEntries.map((e) => e.mod);
  const opts = { noExact: ctx.noExact, prices: ctx.prices, absentGroups: U.groups, craftMods: ctx.crafts.map((c) => c.wantedMod) };
  const ctxV = buildContext(ctx.db, ctx.base, ctx.ilvl, ctx.influences, rest, fixed, opts);
  const out = [];
  // Veiled Chaos Orb: the veiled mod takes one slot on its side; the rest is a normal roll
  const placeholder = { id: `__veiled_${Z}`, n: "Veiled", g: Z, gr: [`__Veiled_${Z}`], st: [], stKey: "", t: [], sw: [], x: Z === "p" ? "Veiled prefix" : "Veiled suffix" };
  const sideChance = Z === "p" ? VEILED_PREFIX_CHANCE : 1 - VEILED_PREFIX_CHANCE;
  const r = rerollOdds(ctxV, ctxV.pool, [placeholder], trials, 919);
  delete r.rerun;
  const pv = sideChance * r.p * pU;
  out.push({
    kind: "veiledChaos", name: "Veiled Chaos Orb, then unveil", ctx: ctxV, target: U, pU, pRest: r.p, sideChance,
    ...(r.exact ? exactStats(pv) : stats(Math.round(pv * (r.trials || 1)), r.trials || 1)), p: pv,
    exact: !!r.exact, currency: [["Veiled Chaos Orb", 1]],
  });
  // Aisling: needs a finished item without bench crafts; assumes it is full, so the veiled mod lands where a mod was removed
  if (!ctxV.crafts.length && !fixed.length) {
    const stage1 = rerollMethods(ctxV, Math.floor(trials / 2)).filter((m) => m.p > 0).sort((a, b) => b.p - a.p)[0];
    if (stage1) {
      delete stage1.rerun;
      const caps = ctx.caps;
      const junkZ = caps[Z] - ctxV.hard.filter((t) => t.side === Z).length;
      const pA = (junkZ / (caps.p + caps.s)) * pU;
      if (pA > 0) {
        out.push({
          kind: "aisling", name: `${stage1.name}, then Aisling`, ctx: ctxV, stage1, stage1Ctx: ctxV, target: U, pU, pA, junkZ,
          p1: stage1.p, p2: pA, p: stage1.p * pA, exact: !!stage1.exact, hits: stage1.hits ?? null, trials: stage1.trials ?? null,
          expected: 1 / (stage1.p * pA), n90: null, currency: [...stage1.currency, ["Aisling (Betrayal safehouse)", 1]],
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- recombinator

/** Chance that one Alteration gives a magic item with exactly these mods (at most one prefix and one suffix). */
function magicOnlyChance(ctx, targets) {
  const W = { p: 0, s: 0 };
  for (const e of ctx.pool) W[e.mod.g] += e.w;
  const Wt = W.p + W.s;
  const sat = (t) => ctx.pool.filter((e) => satisfies(e.mod, t)).reduce((a, e) => a + e.w, 0);
  if (targets.length === 1) return (1 - MAGIC_TWO_MOD_CHANCE) * sat(targets[0]) / Wt;
  const [A, B] = targets;
  return MAGIC_TWO_MOD_CHANCE * ((sat(A) / Wt) * (sat(B) / W[B.side]) + (sat(B) / Wt) * (sat(A) / W[A.side]));
}

/**
 * Advanced: two magic items that carry the wanted mods between them (made with Alterations), combined with a
 * Recombinator. Each side's mods go into one pool and the result keeps a random number of them
 * (data/manual/recombinator.json); the plan needs all of them kept.
 */
function recombinatorMethods(ctx) {
  const h = ctx.db.manual?.recombinator;
  if (!h || ctx.fixedEntries.length || ctx.hard.length < 2) return [];
  const P = ctx.hard.filter((t) => t.side === "p"), S = ctx.hard.filter((t) => t.side === "s");
  if (P.length > 2 || S.length > 2) return [];
  const keepAll = (n) => (n === 0 ? 1 : (h.keepCounts[n] || []).find(([k]) => k === n)?.[1] || 0);
  const pc = keepAll(P.length) * keepAll(S.length);
  if (!(pc > 0)) return [];
  // every way to split the mods over two magic items (each with at most one prefix and one suffix)
  let best = null;
  const n = ctx.hard.length;
  for (let mask = 1; mask < (1 << n) - 1; mask++) {
    const A = ctx.hard.filter((_, i) => mask & (1 << i)), B = ctx.hard.filter((_, i) => !(mask & (1 << i)));
    if (A.length > 2 || B.length > 2 || [A, B].some((x) => x.length === 2 && x[0].side === x[1].side)) continue;
    const pA = magicOnlyChance(ctx, A), pB = magicOnlyChance(ctx, B);
    if (!(pA > 0 && pB > 0)) continue;
    const actions = (1 / pA + 1 / pB + 1) / pc;
    if (!best || actions < best.actions) best = { A, B, pA, pB, actions };
  }
  if (!best) return [];
  return [{
    kind: "recomb", name: "Two magic items, then a Recombinator", approximate: true, advanced: true,
    A: best.A, B: best.B, pA: best.pA, pB: best.pB, pc, attempts: 1 / pc,
    p: 1 / best.actions, expected: best.actions, n90: null, exact: false, hits: null, trials: null,
    currency: [["Orb of Alteration", 1], ["Recombinator", 1]],
  }];
}

function pickCrafts(wanted, crafts) {
  return wanted.filter((w) => crafts.some((t) => t.wantedMod === w.mod));
}

function mergeCounts(list) {
  const m = new Map();
  for (const [n, p] of list) m.set(n, (m.get(n) || 0) + p);
  return [...m.entries()];
}

// ---------------------------------------------------------------- planner
export function planCraft(db, base, ilvl, influences, wanted, fixed = [], opts = {}) {
  const tStart = Date.now();
  const trials = opts.trials || 20000;
  const noExact = opts.exact === false; // force Monte Carlo (used by the tests)
  const prices = opts.prices || null; // prices.json: {divine, prices: {currency name: price in Chaos Orbs}}
  const ctx = buildContext(db, base, ilvl, influences, wanted, fixed, { noExact, prices, eldritch: opts.eldritch });
  const methods = [];
  methods.push(...rerollMethods(ctx, trials));
  const ar = altRegalMethod(ctx, Math.floor(trials / 2));
  if (ar) methods.push(ar);
  const ev = eldritchExaltVariant(ctx);
  for (const b of [...blockVariants(ctx), ...(ev ? [ev] : [])]) {
    const m = altRegalMethod(ctx, Math.floor(trials / 2), b);
    // keep a variant that has better odds, or (eldritch exalts) the same odds with fewer exalts
    const fewerExalts = b.eldritch && m && ar && m.p >= ar.p * (1 - 1e-9) && m.expectedExalts < ar.expectedExalts * (1 - 1e-6);
    if (m && ar && (m.p > ar.p || fewerExalts)) methods.push(m);
  }
  methods.push(...lockMethods(ctx, trials, wanted));
  methods.push(...influenceExaltMethods(ctx, trials, wanted), ...awakenerMethods(ctx, trials, wanted), ...veiledMethods(ctx, trials, wanted), ...recombinatorMethods(ctx));
  for (const m of methods) m.ctx = m.ctx || ctx;

  // with two or more bench-able mods: the same methods with multimod and two bench crafts
  if (ctx.extraBenchable.length && db.meta?.multimod) {
    const ctx2 = buildContext(db, base, ilvl, influences, wanted, fixed, { maxCrafts: 2, noExact, prices });
    const mm = rerollMethods(ctx2, trials);
    const ar2 = altRegalMethod(ctx2, Math.floor(trials / 2));
    if (ar2) mm.push(ar2);
    mm.sort((a, b) => b.p - a.p);
    for (const m of mm.slice(0, MULTIMOD_VARIANTS_KEPT)) {
      if (!(m.p > 0)) continue;
      m.ctx = ctx2;
      m.multimod = true;
      m.name += " + multimod";
      methods.push(m);
    }
  }
  // refine with whatever time is left (opts.refineMs overrides, e.g. 0 in tests)
  refine(methods, opts.refineMs ?? Math.max(0, (opts.timeBudgetMs ?? PLAN_TIME_BUDGET_MS) - (Date.now() - tStart)));
  // derived plans that can't work are noise; the basic methods stay so the user sees they were checked
  const basic = new Set(["chaos", "essence", "fossil", "altregal", "harvest"]);
  for (let i = methods.length - 1; i >= 0; i--) if (!basic.has(methods[i].kind) && !(methods[i].p > 0)) methods.splice(i, 1);
  methods.sort((a, b) => b.p - a.p);
  for (const m of methods) {
    m.steps = buildSteps(m.ctx, m);
    m.usage = usageOf(m, m.ctx);
    m.cost = priceUsage(m.usage, prices);
    m.crafts = m.ctx.crafts.map((c) => ({ mod: c.wantedMod, option: c.option }));
    delete m.ctx; delete m.stage1Ctx; delete m.stage2Ctx; delete m.target; delete m.targets; delete m.A; delete m.B;
  }
  const minIlvl = Math.max(base.lvl || 1, ...ctx.targets.map((t) => t.minIlvl || 1));
  const impossible = ctx.hard.filter((t) => t.naturalWeight === 0);
  return {
    base, ilvl, influences, minIlvl,
    targets: ctx.targets.map((t) => ({
      mod: t.wantedMod, minMod: t.mod, side: t.side, share: t.share,
      bench: ctx.crafts.includes(t) ? t.option : null,
      benchPossible: t.bench.length > 0, naturalWeight: t.naturalWeight,
    })),
    benchTarget: ctx.crafts[0] ? { mod: ctx.crafts[0].wantedMod, option: ctx.crafts[0].option } : null,
    extraBenchable: ctx.extraBenchable.map((t) => t.wantedMod),
    impossibleNaturally: impossible.map((t) => t.wantedMod),
    methods,
  };
}

/** Refines the most promising simulated methods (round-robin) until the estimates are reasonably precise. */
function refine(methods, budget) {
  const t0 = Date.now();
  let seed = 7000;
  for (let round = 0; round < 40 && Date.now() - t0 < budget; round++) {
    const sims = methods.filter((m) => m.rerun);
    const withHits = sims.filter((m) => m.hits > 0);
    const pool = withHits.length ? withHits : sims;
    const todo = pool.sort((x, y) => (y.p || y.upperBound) - (x.p || x.upperBound)).slice(0, 6).filter((m) => m.hits < 60 && m.trials < 1500000);
    if (!todo.length) break;
    for (const m of todo) {
      if (Date.now() - t0 >= budget) break;
      const n = Math.min(Math.max(m.trials, 20000), 60000);
      const h = m.rerun(n, seed++);
      Object.assign(m, stats(m.hits + h, m.trials + n));
    }
  }
  for (const m of methods) delete m.rerun;
}
