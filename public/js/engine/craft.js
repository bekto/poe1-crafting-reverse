// Monte Carlo crafting simulator and reverse-crafting planner for PoE 1.
import { basePool, itemTags, spawnWeight, maxAffixes, satisfies, makeTarget, benchOptionsFor } from "./pool.js";
import { MAGIC_TWO_MOD_CHANCE, rareModCounts } from "./assumptions.js";
import { exactReroll, exactAltRegal } from "./exact.js";

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickCount(counts, rng) {
  let r = rng();
  for (const [n, p] of counts) { if ((r -= p) <= 0) return n; }
  return counts[counts.length - 1][0];
}

/** Compiles a weighted mod list into flat arrays for fast sampling. */
class CompiledPool {
  constructor(entries, targets, groupIds) {
    this.n = entries.length;
    this.mods = entries.map((e) => e.mod);
    this.w = Float64Array.from(entries.map((e) => e.w));
    this.side = Uint8Array.from(entries.map((e) => (e.mod.g === "p" ? 0 : 1)));
    this.groups = entries.map((e) => e.mod.gr.map((g) => groupIds(g)));
    this.mask = Int32Array.from(entries.map((e) => targetMask(e.mod, targets)));
    // members of every group, so picking a mod can remove its whole group at once
    this.members = new Map();
    this.groups.forEach((gs, i) => gs.forEach((g) => {
      if (!this.members.has(g)) this.members.set(g, []);
      this.members.get(g).push(i);
    }));
    this.sideTotal = [0, 0];
    for (let i = 0; i < this.n; i++) this.sideTotal[this.side[i]] += this.w[i];
    this.removed = new Int32Array(this.n);
  }
}

function targetMask(mod, targets) {
  let m = 0;
  targets.forEach((t, i) => { if (satisfies(mod, t)) m |= 1 << i; });
  return m;
}

/** Mutable item state during a simulated craft. */
class State {
  constructor(nGroups) { this.gStamp = new Int32Array(nGroups); this.stamp = 0; this.P = null; this.reset({ p: 3, s: 3 }); }
  bind(P) { this.P = P; }
  reset(max) {
    this.stamp++; this.nP = 0; this.nS = 0; this.mask = 0; this.max = { ...max }; this.count = 0;
    if (this.P) this.tot = [this.P.sideTotal[0], this.P.sideTotal[1]];
  }
  has(groups) { for (const g of groups) if (this.gStamp[g] === this.stamp) return true; return false; }
  add(side, groups, mask) {
    if (side === 0) this.nP++; else this.nS++;
    const P = this.P;
    for (const g of groups) {
      if (this.gStamp[g] === this.stamp) continue;
      this.gStamp[g] = this.stamp;
      const mem = P && P.members.get(g);
      if (mem) for (const j of mem) if (P.removed[j] !== this.stamp) { P.removed[j] = this.stamp; this.tot[P.side[j]] -= P.w[j]; }
    }
    this.mask |= mask; this.count++;
  }
  free(side) { return side === 0 ? this.max.p - this.nP : this.max.s - this.nS; }
}

/** Adds one random mod (exalt-style). Records in st.lastBench whether it met the bench target. */
function addRandomTrack(P, st, rng) {
  const pOpen = st.nP < st.max.p, sOpen = st.nS < st.max.s;
  const total = (pOpen ? Math.max(0, st.tot[0]) : 0) + (sOpen ? Math.max(0, st.tot[1]) : 0);
  st.lastBench = false;
  if (total <= 1e-9) return false;
  let r = rng() * total;
  const stamp = st.stamp, removed = P.removed, side = P.side, w = P.w;
  for (let i = 0; i < P.n; i++) {
    if (removed[i] === stamp) continue;
    const sd = side[i];
    if (sd === 0 ? !pOpen : !sOpen) continue;
    r -= w[i];
    if (r <= 0) {
      st.add(sd, P.groups[i], P.mask[i]);
      if (P.benchMask && P.benchMask[i]) st.lastBench = true;
      return true;
    }
  }
  return false;
}

/**
 * Plan context: base, targets split into rolled ("hard") targets and one bench-crafted target.
 */
export function buildContext(db, base, ilvl, influences, wanted, fixed = []) {
  // wanted: [{mod, minMod}] where minMod is the lowest acceptable tier mod
  const groupIndex = new Map();
  const gid = (g) => { if (!groupIndex.has(g)) groupIndex.set(g, groupIndex.size); return groupIndex.get(g); };
  const pool = basePool(db, base, influences, ilvl);
  const totalW = { p: 0, s: 0 };
  for (const e of pool) totalW[e.mod.g] += e.w;

  const targets = wanted.map((w) => {
    const t = makeTarget(w.minMod, { wantedMod: w.mod });
    const natural = pool.filter((e) => satisfies(e.mod, t));
    t.naturalWeight = natural.reduce((a, e) => a + e.w, 0);
    t.share = t.naturalWeight / (totalW.p + totalW.s || 1);
    t.bench = benchOptionsFor(db, base, t);
    t.minIlvl = natural.length ? Math.min(...natural.map((e) => e.mod.l)) : null;
    return t;
  });
  // pick at most one bench craft: the bench-able target that is hardest to roll naturally
  const benchable = targets.filter((t) => t.bench.length);
  benchable.sort((a, b) => a.naturalWeight - b.naturalWeight);
  const benchTarget = benchable[0] || null;
  const hard = targets.filter((t) => t !== benchTarget);
  const fixedEntries = fixed.map((m) => ({ mod: m }));
  return {
    db, base, ilvl, influences, pool, targets, hard, benchTarget, totalW, gid, groupIndex,
    tags: itemTags(db, base, influences), fixedEntries,
    extraBenchable: benchable.slice(1),
  };
}

function compileFor(ctx, entries) {
  const P = new CompiledPool(entries, ctx.hard, ctx.gid);
  P.needMask = (1 << ctx.hard.length) - 1;
  if (ctx.benchTarget) {
    P.bench = {
      side: ctx.benchTarget.side === "p" ? 0 : 1,
      groups: ctx.benchTarget.groups.map(ctx.gid),
    };
    // a naturally rolled mod that already satisfies the bench target also counts
    P.benchMask = Int32Array.from(entries.map((e) => (satisfies(e.mod, ctx.benchTarget) ? 1 : 0)));
  }
  return P;
}

function fixedInfo(ctx, mod) {
  return { side: mod.g === "p" ? 0 : 1, groups: mod.gr.map(ctx.gid), mask: targetMask(mod, ctx.hard), benchHit: ctx.benchTarget && satisfies(mod, ctx.benchTarget) };
}

function success(P, st, benchHit) {
  if ((st.mask & P.needMask) !== P.needMask) return false;
  if (!P.bench || benchHit) return true;
  return st.free(P.bench.side) > 0 && !st.has(P.bench.groups);
}

/** Simulate repeated full rerolls (chaos, essence, fossil). forced = mods always added first. */
function simulateReroll(ctx, P, forced, trials, seed) {
  const rng = mulberry32(seed);
  const st = new State(ctx.groupIndex.size + 8);
  st.bind(P);
  const counts = rareModCounts(ctx.base);
  const max = maxAffixes(ctx.base);
  const forcedInfo = [...ctx.fixedEntries.map((e) => e.mod), ...forced].map((m) => fixedInfo(ctx, m));
  let hits = 0;
  for (let t = 0; t < trials; t++) {
    st.reset(max);
    let benchHit = false;
    for (const f of forcedInfo) { st.add(f.side, f.groups, f.mask); if (f.benchHit) benchHit = true; }
    const n = pickCount(counts, rng);
    while (st.count < n) {
      if (!addRandomTrack(P, st, rng)) break;
      if (st.lastBench) benchHit = true;
    }
    if (success(P, st, benchHit)) hits++;
  }
  return hits;
}

function stats(hits, trials) {
  const p = hits / trials;
  return {
    p,
    hits,
    trials,
    upperBound: hits === 0 ? 3 / trials : null, // 95% upper bound when nothing hit
    expected: p > 0 ? 1 / p : null,
    n90: p > 0 ? (p >= 1 ? 1 : Math.ceil(Math.log(0.1) / Math.log(1 - p))) : null,
  };
}

/** Odds of a known probability, in the same shape as stats(). */
function exactStats(p) {
  return {
    p, exact: true, hits: null, trials: null, upperBound: null,
    expected: p > 0 ? 1 / p : null,
    n90: p > 0 ? (p >= 1 ? 1 : Math.ceil(Math.log(0.1) / Math.log(1 - p))) : null,
  };
}

/** Exact odds for small cases, otherwise a Monte Carlo estimate that the planner can refine. */
function rerollOdds(ctx, entries, forced, P, trials, seed) {
  if (!ctx.noExact) {
    const ex = exactReroll(ctx, entries, [...ctx.fixedEntries.map((e) => e.mod), ...forced]);
    if (ex) return exactStats(ex.p);
  }
  const run = (n, sd) => simulateReroll(ctx, P, forced, n, sd);
  return { rerun: run, ...stats(run(trials, seed), trials) };
}

// ---------------------------------------------------------------- methods
function chaosMethod(ctx, trials) {
  const P = compileFor(ctx, ctx.pool);
  return { kind: "chaos", name: "Chaos Orb spam", currency: [["Chaos Orb", 1]], ...rerollOdds(ctx, ctx.pool, [], P, trials, 1) };
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
    const mask = targetMask(mod, ctx.hard);
    const benchHit = ctx.benchTarget && satisfies(mod, ctx.benchTarget);
    if (!mask && !benchHit) continue;
    const fam = e.name.replace(/^\S+ Essence of /, "Essence of ");
    // keep the cheapest (lowest level) essence of a family that still hits the target
    const prev = families.get(fam);
    if (!prev || e.level < prev.e.level) families.set(fam, { e, mod });
  }
  const P = compileFor(ctx, ctx.pool);
  let seed = 100;
  for (const { e, mod } of families.values()) {
    out.push({
      kind: "essence", name: e.name, currency: [[e.name, 1]], essenceMod: mod,
      corrupt: e.corrupt, ...rerollOdds(ctx, ctx.pool, [mod], P, trials, seed++),
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
    if (!mod || mod.l > ctx.ilvl) continue;
    const w = spawnWeight(mod, ctx.tags) * mult(mod);
    if (w > 0) entries.push({ mod, w });
  }
  const forced = fossils.flatMap((f) => f.forced).map((id) => ctx.db.modById.get(id)).filter(Boolean);
  return { entries, forced };
}

function fossilMethods(ctx, trials) {
  const targetTags = new Set(ctx.hard.flatMap((t) => t.mod.t));
  if (ctx.benchTarget) ctx.benchTarget.mod.t.forEach((t) => targetTags.add(t));
  const singles = ctx.db.fossils.filter((f) => fossilApplicable(ctx, f));
  const relevant = singles.filter((f) =>
    f.pos.some(([tag]) => targetTags.has(tag)) ||
    f.neg.some(([tag, w]) => w === 0 && !targetTags.has(tag)));
  // rank fossil combos by how much they raise the weight share of the wanted mods (cheap, no simulation)
  const shareScore = (entries) => {
    let tot = 0;
    for (const e of entries) tot += e.w;
    let score = 0;
    const all = ctx.benchTarget ? [...ctx.hard] : ctx.hard;
    for (const t of all) {
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
    const P = compileFor(ctx, entries);
    return {
      kind: "fossil",
      name: c.map((f) => f.name).join(" + "),
      fossils: c,
      currency: [...c.map((f) => [f.name, 1]), [resonatorName(c.length), 1]],
      ...rerollOdds(ctx, entries, forced, P, trials, seed++),
    };
  });
}

function resonatorName(n) {
  return ["", "Primitive Chaotic Resonator", "Potent Chaotic Resonator", "Powerful Chaotic Resonator", "Prime Chaotic Resonator"][n];
}

/** Alteration (+augment) until the 1-2 hardest mods are hit, then regal, then exalted slams. */
function altRegalMethod(ctx, trials) {
  if (!ctx.hard.length) return null;
  const P = compileFor(ctx, ctx.pool);
  // stage 1 goal: hardest prefix target + hardest suffix target
  const pick = (side) => ctx.hard.map((t, i) => ({ t, i })).filter((x) => x.t.side === side).sort((a, b) => a.t.naturalWeight - b.t.naturalWeight)[0];
  const s1 = [pick("p"), pick("s")].filter(Boolean);
  const s1Mask = s1.reduce((m, x) => m | (1 << x.i), 0);
  const s1Sides = new Set(s1.map((x) => x.t.side === "p" ? 0 : 1));
  const rng = mulberry32(900);
  const st = new State(ctx.groupIndex.size + 8);
  st.bind(P);
  const magicMax = { p: 1, s: 1 };
  const rareMax = maxAffixes(ctx.base);
  const forced = ctx.fixedEntries.map((e) => fixedInfo(ctx, e.mod));
  if (forced.length) return null; // fractured bases: rerolling to magic keeps the fractured mod, skip for now
  const ex = ctx.noExact ? null : exactAltRegal(ctx, s1);
  if (ex) return altRegalResult(s1, ex.p1, ex.p2, ex.augPerAlt, ex.avgExalts, true);

  let augs = 0;
  const altRoll = () => {
    st.reset(magicMax);
    const n = rng() < MAGIC_TWO_MOD_CHANCE ? 2 : 1;
    let benchHit = false;
    for (let k = 0; k < n; k++) { addRandomTrack(P, st, rng); if (st.lastBench) benchHit = true; }
    // augment if a needed side is still empty
    if (st.count === 1) {
      const needOther = [...s1Sides].some((sd) => st.free(sd) > 0) && (st.mask & s1Mask) !== s1Mask && (st.mask & s1Mask) !== 0;
      if (needOther) { augs++; addRandomTrack(P, st, rng); if (st.lastBench) benchHit = true; }
    }
    return { ok: (st.mask & s1Mask) === s1Mask, benchHit };
  };
  // stage 1 probability
  const n1 = trials * 2;
  let h1 = 0;
  for (let t = 0; t < n1; t++) if (altRoll().ok) h1++;
  const p1 = h1 / n1;
  const augPerAlt = augs / n1;
  if (p1 < 1e-4) return null;

  // stage 2 starting from successful magic items
  const n2 = Math.min(4000, Math.max(500, Math.floor(200000 * p1)));
  let h2 = 0, exalts = 0, regalFail = 0;
  for (let t = 0; t < n2; t++) {
    let r, guard = 0;
    do { r = altRoll(); } while (!r.ok && ++guard < 1e6);
    if (!r.ok) break;
    let benchHit = r.benchHit;
    st.max = { ...rareMax };
    // regal
    addRandomTrack(P, st, rng); if (st.lastBench) benchHit = true;
    let used = 0;
    while (!success(P, st, benchHit)) {
      // stop when the remaining targets can no longer fit
      const need = [0, 0];
      ctx.hard.forEach((tg, i) => { if (!(st.mask & (1 << i))) need[tg.side === "p" ? 0 : 1]++; });
      if (P.bench && !benchHit && !st.has(P.bench.groups)) need[P.bench.side]++;
      if (need[0] > st.free(0) || need[1] > st.free(1) || st.count >= rareMax.p + rareMax.s) break;
      if (!addRandomTrack(P, st, rng)) break;
      if (st.lastBench) benchHit = true;
      used++;
    }
    exalts += used;
    if (success(P, st, benchHit)) h2++; else if (used === 0) regalFail++;
  }
  return altRegalResult(s1, p1, h2 / n2, augPerAlt, exalts / n2, false);
}

function altRegalResult(s1, p1, p2, augPerAlt, avgExalts, exact) {
  const total = p1 * p2;
  return {
    kind: "altregal",
    name: "Alteration → Regal → Exalted Orb",
    stage1Targets: s1.map((x) => x.t),
    p1, p2, augPerAlt, avgExalts,
    currency: [["Orb of Alteration", 1]],
    ...(exact ? exactStats(total) : stats(Math.round(total * 1e6), 1e6)),
    p: total,
    expectedAlts: total > 0 ? 1 / total : null,
    expectedRegals: p2 > 0 ? 1 / p2 : null,
    expectedExalts: p2 > 0 ? avgExalts / p2 : null,
  };
}

// ---------------------------------------------------------------- planner
export function planCraft(db, base, ilvl, influences, wanted, fixed = [], opts = {}) {
  const trials = opts.trials || 20000;
  const ctx = buildContext(db, base, ilvl, influences, wanted, fixed);
  ctx.noExact = opts.exact === false; // force Monte Carlo (used by the tests)
  const methods = [];
  methods.push(chaosMethod(ctx, trials));
  methods.push(...essenceMethods(ctx, trials));
  methods.push(...fossilMethods(ctx, Math.floor(trials / 2)));
  const ar = altRegalMethod(ctx, Math.floor(trials / 2));
  if (ar) methods.push(ar);
  // refine the most promising reroll methods (round-robin) until the estimates are reasonably precise
  const t0 = Date.now();
  const budget = opts.refineMs ?? 8000;
  let seed = 7000;
  for (let round = 0; round < 40 && Date.now() - t0 < budget; round++) {
    const withHits = methods.filter((m) => m.rerun && m.hits > 0);
    const pool = withHits.length ? withHits : methods.filter((m) => m.rerun);
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
  methods.sort((a, b) => b.p - a.p);
  for (const m of methods) m.steps = buildSteps(ctx, m);
  const minIlvl = Math.max(base.lvl || 1, ...ctx.hard.map((t) => t.minIlvl || 1));
  const impossible = ctx.hard.filter((t) => t.naturalWeight === 0);
  return {
    base, ilvl, influences, minIlvl,
    targets: ctx.targets.map((t) => ({
      mod: t.wantedMod, minMod: t.mod, side: t.side, share: t.share,
      bench: t === ctx.benchTarget ? t.bench[0] : null,
      benchPossible: t.bench.length > 0, naturalWeight: t.naturalWeight,
    })),
    benchTarget: ctx.benchTarget ? { mod: ctx.benchTarget.wantedMod, option: pickBench(ctx.benchTarget) } : null,
    extraBenchable: ctx.extraBenchable.map((t) => t.wantedMod),
    impossibleNaturally: impossible.map((t) => t.wantedMod),
    methods,
  };
}

function pickBench(t) {
  // cheapest bench option that is still good enough = the lowest tier that satisfies
  return [...t.bench].sort((a, b) => (a.mod.l - b.mod.l))[0];
}

function fmtCost(cost) {
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

function pct(p) {
  if (p >= 0.1) return (p * 100).toFixed(1) + "%";
  if (p >= 0.001) return (p * 100).toFixed(2) + "%";
  return (p * 100).toPrecision(2) + "%";
}

function buildSteps(ctx, m) {
  const steps = [];
  const infl = ctx.influences.length ? ` with ${ctx.influences.join(" + ")} influence` : "";
  const minIlvl = Math.max(ctx.base.lvl || 1, ...ctx.hard.map((t) => t.minIlvl || 1));
  const fixedTxt = ctx.fixedEntries.length ? ` that already has the fractured mod${ctx.fixedEntries.length > 1 ? "s" : ""} ${ctx.fixedEntries.map((e) => `"${e.mod.x.replace(/\n/g, " / ")}"`).join(", ")}` : "";
  steps.push({
    title: `Get a ${ctx.base.name}${infl}`,
    detail: `Item level ${ctx.ilvl} (the plan was simulated at this level; at least ${minIlvl} is needed for the tiers you asked for)${fixedTxt}.`,
  });
  const odds = m.p > 0 ? `${pct(m.p)} per try — about ${fmtN(m.expected)} tries on average, ${fmtN(m.n90)} for a 90% chance.`
    : m.exact ? "This method can't make this item."
    : `Less than ${pct(m.upperBound)} per try in ${m.trials.toLocaleString()} simulated tries — not a realistic method for this item.`;
  if (m.kind === "chaos") {
    steps.push({ title: "Make it rare (Orb of Alchemy), then spam Chaos Orbs", detail: `Stop when the item has ${targetList(ctx)}. ${odds}` });
  } else if (m.kind === "essence") {
    steps.push({ title: `Spam ${m.name}`, detail: `Every essence guarantees "${m.essenceMod.x.replace(/\n/g, " / ")}" and rerolls the rest. Stop when it also has ${targetList(ctx, m.essenceMod)}. ${odds}${m.corrupt ? " This essence only comes from corrupting another essence with a Remnant of Corruption." : ""} Use an Orb of Scouring first if the item isn't normal or rare.` });
  } else if (m.kind === "fossil") {
    steps.push({
      title: `Fossil craft: ${m.name} in a ${resonatorName(m.fossils.length)}`,
      detail: `Effects: ${m.fossils.flatMap((f) => f.desc).join("; ")}. Keep rerolling until the item has ${targetList(ctx)}. ${odds}`,
    });
  } else if (m.kind === "altregal") {
    const s1 = m.stage1Targets.map((t) => `"${t.wantedMod.x.replace(/\n/g, " / ")}"`).join(" and ");
    steps.push({ title: "Orb of Transmutation, then spam Orbs of Alteration", detail: `Goal: a magic item with ${s1}. Use an Orb of Augmentation when only one of them shows up and there's a free slot. ${pct(m.p1)} per alteration (about ${fmtN(1 / m.p1)} alterations, ${(m.augPerAlt).toFixed(2)} augmentations per alteration).` });
    steps.push({ title: "Regal Orb, then Exalted Orbs for the missing mods", detail: `From a good magic item, ${pct(m.p2)} chance that the regal + exalt slams finish the rest (${m.avgExalts.toFixed(1)} exalts per attempt on average). If a slam misses, start over (or annul — not modelled). Overall about ${fmtN(m.expectedAlts)} alterations, ${fmtN(m.expectedRegals)} regals and ${fmtN(m.expectedExalts)} exalts.` });
  }
  if (ctx.benchTarget) {
    const o = pickBench(ctx.benchTarget);
    steps.push({ title: `Bench craft "${o.mod.x.replace(/\n/g, " / ")}"`, detail: `Crafting bench, costs ${fmtCost(o.cost) || "a little currency"}. Needs a free ${o.mod.g === "p" ? "prefix" : "suffix"}, which the odds above already require.` });
  }
  return steps;
}

function targetList(ctx, except) {
  const list = ctx.hard.filter((t) => !(except && satisfies(except, t))).map((t) => `"${t.mod.x.replace(/\n/g, " / ")}"${t.mod !== t.wantedMod ? " or better" : ""}`);
  if (ctx.benchTarget) list.push(`a free ${ctx.benchTarget.side === "p" ? "prefix" : "suffix"} for the bench craft`);
  return list.length ? list.join(", ") : "the mods you want";
}

function fmtN(n) {
  if (n === null || n === undefined || !isFinite(n)) return "∞";
  if (n < 10) return n.toFixed(1);
  if (n < 1e4) return Math.round(n).toLocaleString();
  if (n < 1e6) return (n / 1e3).toFixed(1) + "k";
  return (n / 1e6).toFixed(1) + "M";
}
