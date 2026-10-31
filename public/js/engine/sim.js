// Monte Carlo simulation core: compiled mod pools, item state, and the shared success rules.
import { satisfies, craftReserve } from "./pool.js";

export function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickCount(counts, rng) {
  let r = rng();
  for (const [n, p] of counts) { if ((r -= p) <= 0) return n; }
  return counts[counts.length - 1][0];
}

export function targetMask(mod, targets) {
  let m = 0;
  targets.forEach((t, i) => { if (satisfies(mod, t)) m |= 1 << i; });
  return m;
}

// tags the "Cannot roll ... Modifiers" meta crafts block
export const BLOCK_BITS = { attack: 1, caster: 2 };

/** Compiles a weighted mod list into flat arrays for fast sampling. */
export class CompiledPool {
  constructor(ctx, entries) {
    this.n = entries.length;
    this.mods = entries.map((e) => e.mod);
    this.w = Float64Array.from(entries.map((e) => e.w));
    this.side = Uint8Array.from(entries.map((e) => (e.mod.g === "p" ? 0 : 1)));
    this.groups = entries.map((e) => e.mod.gr.map((g) => ctx.gid(g)));
    this.mask = Int32Array.from(entries.map((e) => targetMask(e.mod, ctx.hard)));
    this.craftMask = Int32Array.from(entries.map((e) => targetMask(e.mod, ctx.crafts)));
    this.blockBits = Uint8Array.from(entries.map((e) => Object.entries(BLOCK_BITS).reduce((a, [tag, bit]) => a | (e.mod.t.includes(tag) ? bit : 0), 0)));
    // members of every group, so picking a mod can remove its whole group at once
    this.members = new Map();
    this.groups.forEach((gs, i) => gs.forEach((g) => {
      if (!this.members.has(g)) this.members.set(g, []);
      this.members.get(g).push(i);
    }));
    this.sideTotal = [0, 0];
    for (let i = 0; i < this.n; i++) this.sideTotal[this.side[i]] += this.w[i];
    this.removed = new Int32Array(this.n);
    this.needMask = (1 << ctx.hard.length) - 1;
    this.allCrafts = (1 << ctx.crafts.length) - 1;
    this.craftGroups = ctx.crafts.map((c) => c.groups.map(ctx.gid));
  }
}

/** Mutable item state during a simulated craft. */
export class State {
  constructor(nGroups) { this.gStamp = new Int32Array(nGroups); this.stamp = 0; this.P = null; this.reset({ p: 3, s: 3 }); }
  bind(P) { this.P = P; }
  reset(max) {
    this.stamp++; this.nP = 0; this.nS = 0; this.mask = 0; this.craftMask = 0; this.max = { ...max }; this.count = 0;
    if (this.P) this.tot = [this.P.sideTotal[0], this.P.sideTotal[1]];
  }
  has(groups) { for (const g of groups) if (this.gStamp[g] === this.stamp) return true; return false; }
  add(side, groups, mask, craftMask = 0) {
    if (side === 0) this.nP++; else this.nS++;
    const P = this.P;
    for (const g of groups) {
      if (this.gStamp[g] === this.stamp) continue;
      this.gStamp[g] = this.stamp;
      const mem = P && P.members.get(g);
      if (mem) for (const j of mem) if (P.removed[j] !== this.stamp) { P.removed[j] = this.stamp; this.tot[P.side[j]] -= P.w[j]; }
    }
    this.mask |= mask; this.craftMask |= craftMask; this.count++;
  }
  free(side) { return side === 0 ? this.max.p - this.nP : this.max.s - this.nS; }
}

/** Adds one random mod (reroll / regal / exalt). block: mods with these BLOCK_BITS can't be picked. */
export function addRandom(P, st, rng, block = 0, only = null) {
  const pOpen = st.nP < st.max.p, sOpen = st.nS < st.max.s;
  const stamp = st.stamp, removed = P.removed, side = P.side, w = P.w, bits = P.blockBits;
  const skip = (i) => removed[i] === stamp || (block && bits[i] & block) || (only && !only[i]);
  let total;
  if (!block && !only) total = (pOpen ? Math.max(0, st.tot[0]) : 0) + (sOpen ? Math.max(0, st.tot[1]) : 0);
  else {
    total = 0;
    for (let i = 0; i < P.n; i++) if (!skip(i) && (side[i] === 0 ? pOpen : sOpen)) total += w[i];
  }
  if (total <= 1e-9) return false;
  let r = rng() * total;
  for (let i = 0; i < P.n; i++) {
    if (skip(i)) continue;
    const sd = side[i];
    if (sd === 0 ? !pOpen : !sOpen) continue;
    r -= w[i];
    if (r <= 0) { st.add(sd, P.groups[i], P.mask[i], P.craftMask[i]); return true; }
  }
  return false;
}

/** Missing crafts whose group is already taken by a worse roll (they can't be crafted). */
export function blockedCrafts(P, st) {
  let b = 0;
  P.craftGroups.forEach((gs, j) => { if (!(st.craftMask & (1 << j)) && st.has(gs)) b |= 1 << j; });
  return b;
}

/** Hard targets all rolled, and every missing bench craft has its slot (plus multimod when needed). */
export function success(ctx, P, st, extraRoom = null) {
  if ((st.mask & P.needMask) !== P.needMask) return false;
  const missing = P.allCrafts & ~st.craftMask;
  if (!missing && !ctx.reserve) return true;
  if (blockedCrafts(P, st) & missing) return false;
  const r = craftReserve(ctx.crafts, missing, ctx.multimodSide, ctx.reserve);
  return st.free(0) + (extraRoom === 0 ? 1 : 0) >= r.p && st.free(1) + (extraRoom === 1 ? 1 : 0) >= r.s;
}

export function fixedInfo(ctx, mod) {
  return { side: mod.g === "p" ? 0 : 1, groups: mod.gr.map(ctx.gid), mask: targetMask(mod, ctx.hard), craftMask: targetMask(mod, ctx.crafts) };
}

/**
 * Simulates repeated full rerolls (chaos, essence, fossil, Harvest). forced = mods always added first;
 * firstOnly (per pool entry) = the first rolled mod comes from these entries (a Harvest "including a ... modifier").
 */
export function simulateReroll(ctx, P, forced, trials, seed, firstOnly = null) {
  const rng = mulberry32(seed);
  const st = new State(ctx.groupIndex.size + 8);
  st.bind(P);
  const forcedInfo = [...ctx.fixedEntries.map((e) => e.mod), ...forced].map((m) => fixedInfo(ctx, m));
  let hits = 0;
  for (let t = 0; t < trials; t++) {
    st.reset(ctx.caps);
    for (const f of forcedInfo) st.add(f.side, f.groups, f.mask, f.craftMask);
    const n = pickCount(ctx.counts, rng);
    if (firstOnly && st.count < n) addRandom(P, st, rng, 0, firstOnly);
    while (st.count < n) if (!addRandom(P, st, rng)) break;
    if (success(ctx, P, st)) hits++;
  }
  return hits;
}

export function stats(hits, trials) {
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
export function exactStats(p) {
  return {
    p, exact: true, hits: null, trials: null, upperBound: null,
    expected: p > 0 ? 1 / p : null,
    n90: p > 0 ? (p >= 1 ? 1 : Math.ceil(Math.log(0.1) / Math.log(1 - p))) : null,
  };
}
