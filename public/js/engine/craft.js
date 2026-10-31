// Reverse-crafting planner for PoE 1: builds the targets, tries every covered method, and ranks them.
import { basePool, itemTags, spawnWeight, maxAffixes, satisfies, makeTarget, benchOptionsFor, craftReserve } from "./pool.js";
import { MAGIC_TWO_MOD_CHANCE, rareModCounts, LOCKED_REROLL_MIN_NEW } from "./assumptions.js";
import { exactReroll, exactAltRegal, exactRerollFirstFrom } from "./exact.js";
import {
  mulberry32, CompiledPool, State, addRandom, success, blockedCrafts, fixedInfo, simulateReroll,
  stats, exactStats, targetMask, BLOCK_BITS,
} from "./sim.js";
import { buildSteps, pickBench } from "./steps.js";

export { currencyName } from "./steps.js";

// how many of the best variants with multimod to keep next to the single-craft plans
const MULTIMOD_VARIANTS_KEPT = 4;

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
  if (!h) return [];
  const wantedTags = new Set([...ctx.hard, ...ctx.crafts].flatMap((t) => t.mod.t));
  const out = [];
  let seed = 300;
  for (const r of h.reforgeTag) {
    if (!wantedTags.has(r.tag)) continue;
    const entries = ctx.pool.map((e) => ({ mod: e.mod, w: e.mod.t.includes(r.tag) ? e.w * h.moreCommonMultiplier : e.w }));
    const first = entries.filter((e) => e.mod.t.includes(r.tag));
    if (!first.length) continue;
    const name = `Harvest: reforge including a ${r.name} modifier`;
    const base = { kind: "harvest", name, harvest: r, approximate: !!h.approximate, text: h.reforgeTagText.replaceAll("{name}", r.name), currency: [["Harvest lifeforce", r.cost]] };
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
  return [pick("p"), pick("s")].filter(Boolean);
}

/**
 * Alteration (+augment) until the 1-2 hardest mods are hit, then regal, then exalted slams.
 * block: {key, tag, mod, side} for a "Cannot roll ... Modifiers" craft during the exalts.
 */
function altRegalMethod(ctx, trials, block = null) {
  if (!ctx.hard.length) return null;
  if (ctx.fixedEntries.length) return null; // fractured bases: rerolling to magic keeps the fractured mod, skip for now
  const s1 = stageOneTargets(ctx);
  const ex = ctx.noExact ? null : exactAltRegal(ctx, s1, block);
  if (ex) return altRegalResult(ctx, s1, ex, true, block);

  const P = new CompiledPool(ctx, ctx.pool);
  const s1Mask = s1.reduce((m, x) => m | (1 << x.i), 0);
  const s1Sides = new Set(s1.map((x) => (x.t.side === "p" ? 0 : 1)));
  const rng = mulberry32(900); // same stage 1 for every variant
  const st = new State(ctx.groupIndex.size + 8);
  st.bind(P);
  const magicMax = { p: 1, s: 1 };
  const rareMax = maxAffixes(ctx.base);
  const metaSide = block ? (block.side === "p" ? 0 : 1) : -1;
  const blockBit = block ? BLOCK_BITS[block.tag] : 0;

  let augs = 0;
  const altRoll = () => {
    st.reset(magicMax);
    const n = rng() < MAGIC_TWO_MOD_CHANCE ? 2 : 1;
    for (let k = 0; k < n; k++) addRandom(P, st, rng);
    // augment if a needed side is still empty
    if (st.count === 1) {
      const needOther = [...s1Sides].some((sd) => st.free(sd) > 0) && (st.mask & s1Mask) !== s1Mask && (st.mask & s1Mask) !== 0;
      if (needOther) { augs++; addRandom(P, st, rng); }
    }
    return (st.mask & s1Mask) === s1Mask;
  };
  // stage 1 probability
  const n1 = trials * 2;
  let h1 = 0;
  for (let t = 0; t < n1; t++) if (altRoll()) h1++;
  const p1 = h1 / n1;
  const augPerAlt = augs / n1;
  if (p1 < 1e-4) return null;

  // stage 2 starting from successful magic items
  const n2 = Math.min(4000, Math.max(500, Math.floor(200000 * p1)));
  let h2 = 0, exalts = 0;
  for (let t = 0; t < n2; t++) {
    let ok = false, guard = 0;
    do { ok = altRoll(); } while (!ok && ++guard < 1e6);
    if (!ok) break;
    st.max = { ...rareMax };
    addRandom(P, st, rng); // regal
    // the meta craft fills a slot while it's on; it comes off before the bench crafts
    const meta = block && st.free(metaSide) > 0;
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
      if (!addRandom(P, st, rng, meta ? blockBit : 0)) break;
      used++;
    }
    exalts += used;
    if (success(ctx, P, st, room)) h2++;
  }
  return altRegalResult(ctx, s1, { p1, p2: h2 / n2, augPerAlt, avgExalts: exalts / n2 }, false, block);
}

function altRegalResult(ctx, s1, r, exact, block) {
  const total = r.p1 * r.p2;
  return {
    kind: "altregal",
    name: block ? `Alteration → Regal → "${block.mod.x}" + Exalted Orb` : "Alteration → Regal → Exalted Orb",
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
  ];
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
    const ctx1 = buildContext(db, ctx.base, ctx.ilvl, ctx.influences, pick(onL).concat(pickCrafts(wanted, craftL)), [], { reserve, noExact: ctx.noExact, craftMods: craftL.map((c) => c.wantedMod) });
    const stage1 = rerollMethods(ctx1, Math.floor(trials / 2)).filter((m) => m.p > 0).sort((a, b) => b.p - a.p)[0];
    if (!stage1) continue;
    // stage 2: keeps side L; new mods only on side O. Assume side L is full apart from slots kept for crafts.
    const keptL = ctx.caps[L] - craftL.length;
    const caps = { [L]: 0, [O]: ctx.caps[O] };
    const counts = mergeCounts(ctx.counts.map(([n, p]) => [Math.min(caps[O], Math.max(LOCKED_REROLL_MIN_NEW, n - keptL)), p]));
    const pool = ctx.pool.filter((e) => e.mod.g === O);
    const ctx2 = buildContext(db, ctx.base, ctx.ilvl, ctx.influences, pick(onO).concat(pickCrafts(wanted, craftO)), [], { caps, counts, pool, noExact: ctx.noExact, craftMods: craftO.map((c) => c.wantedMod) });
    const r2 = rerollOdds(ctx2, ctx2.pool, [], trials, 777);
    delete stage1.rerun;
    delete r2.rerun;
    const p1 = stage1.p, p2 = r2.p;
    const tries = p1 > 0 && p2 > 0 ? 1 / p1 + 1 / p2 : null;
    const second = meta ? `"${meta.mod.x}" + Chaos Orb` : `Harvest "${lk.harvest.text}"`;
    out.push({
      kind: "lock",
      name: `${stage1.name}, then ${second}`,
      lockSide: L, meta, harvestKeep: lk.harvest || null, stage1, stage1Ctx: ctx1, stage2Ctx: ctx2,
      approximate: !!(lk.approximate || stage1.approximate),
      p1, p2, keptL,
      exact: !!(stage1.exact && r2.exact),
      hits: stage1.exact && r2.exact ? null : Math.min(stage1.hits ?? Infinity, r2.hits ?? Infinity),
      trials: r2.trials,
      p: tries ? 1 / tries : 0,
      expected: tries,
      n90: null,
      upperBound: tries ? null : 3 / trials,
      currency: [...stage1.currency, meta ? ["Chaos Orb", 1] : ["Harvest lifeforce", lk.harvest.cost]],
    });
  }
  return out;
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
  const trials = opts.trials || 20000;
  const noExact = opts.exact === false; // force Monte Carlo (used by the tests)
  const ctx = buildContext(db, base, ilvl, influences, wanted, fixed, { noExact });
  const methods = [];
  methods.push(...rerollMethods(ctx, trials));
  const ar = altRegalMethod(ctx, Math.floor(trials / 2));
  if (ar) methods.push(ar);
  for (const b of blockVariants(ctx)) {
    const m = altRegalMethod(ctx, Math.floor(trials / 2), b);
    if (m && ar && m.p > ar.p) methods.push(m);
  }
  methods.push(...lockMethods(ctx, trials, wanted));
  for (const m of methods) m.ctx = ctx;

  // with two or more bench-able mods: the same methods with multimod and two bench crafts
  if (ctx.extraBenchable.length && db.meta?.multimod) {
    const ctx2 = buildContext(db, base, ilvl, influences, wanted, fixed, { maxCrafts: 2, noExact });
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
  refine(methods, opts.refineMs ?? 8000);
  methods.sort((a, b) => b.p - a.p);
  for (const m of methods) {
    m.steps = buildSteps(m.ctx, m);
    m.crafts = m.ctx.crafts.map((c) => ({ mod: c.wantedMod, option: c.option }));
    delete m.ctx; delete m.stage1Ctx; delete m.stage2Ctx;
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
