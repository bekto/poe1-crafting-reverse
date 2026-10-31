// Exact odds (no Monte Carlo noise) for crafts with one or two wanted mods.
//
// Rolling mods one at a time with chance proportional to weight, without repeating a mod group, is the
// same as giving every mod group an exponential "clock" with rate = its total weight and taking groups
// in the order their clocks ring (skipping a side once it is full, stopping when the item has enough mods).
// In that picture the prefix side and the suffix side are independent; they only meet at the moment the
// item gets its last mod. So the odds are a one-dimensional integral over that moment, and on each side
// the number of other groups that have rung by time t follows from a small Poisson-binomial table.
// Groups with the same weight are interchangeable, which keeps the tables small.
import { satisfies, maxAffixes, craftReserve } from "./pool.js";
import { MAGIC_TWO_MOD_CHANCE } from "./assumptions.js";

export const MAX_EXACT_TARGETS = 6;
// log-time grid for the integral: step and range (in multiples of the fastest/slowest clock)
const GRID_STEP = 0.04;
const GRID_START = 1e-10; // × 1 / total weight
const GRID_END = 45; // × 1 / smallest weight; e^-45 of the slowest clock is still left

/**
 * Turns a weighted pool into mod groups ("units"). Returns null when the structure isn't one this method
 * handles exactly (a mod in several groups, a group on both sides, or a target spread over several groups).
 * With blockTag, every unit also gets its weights without the mods carrying that tag (field x).
 */
export function buildUnits(ctx, entries, blockTag = null) {
  const units = new Map();
  const crafts = ctx.crafts || [];
  for (const e of entries) {
    if (!(e.w > 0)) continue;
    if (e.mod.gr.length !== 1) return null;
    const g = e.mod.gr[0];
    let u = units.get(g);
    if (!u) {
      const blank = () => ({ w: 0, sat: ctx.hard.map(() => 0), craftSat: crafts.map(() => 0) });
      units.set(g, (u = { g, side: e.mod.g, ...blank(), x: blank() }));
    }
    if (u.side !== e.mod.g) return null;
    const parts = blockTag && e.mod.t.includes(blockTag) ? [u] : [u, u.x];
    for (const part of parts) {
      part.w += e.w;
      ctx.hard.forEach((t, i) => { if (satisfies(e.mod, t)) part.sat[i] += e.w; });
      crafts.forEach((c, j) => { if (satisfies(e.mod, c)) part.craftSat[j] += e.w; });
    }
  }
  const all = [...units.values()];
  const targetUnit = ctx.hard.map((_, i) => {
    const us = all.filter((u) => u.sat[i] > 0);
    return us.length > 1 ? undefined : us[0] || null;
  });
  if (targetUnit.includes(undefined)) return null;
  const craftUnit = [];
  for (let j = 0; j < crafts.length; j++) {
    if (crafts[j].groups.length !== 1) return null;
    const u = units.get(crafts[j].groups[0]) || null;
    if (all.some((v) => v.craftSat[j] > 0 && v !== u)) return null;
    if (u && targetUnit.includes(u)) return null;
    craftUnit.push(u);
  }
  return { units, targetUnit, craftUnit };
}

/** Applies mods that are on the item before rolling (fractured, essence, fossil-forced). */
function applyForced(ctx, model, forced, caps) {
  const crafts = ctx.crafts || [];
  const st = { hit: ctx.hard.map(() => false), craftHit: 0, craftBlocked: 0, removed: new Set() };
  for (const m of forced) {
    caps[m.g] = Math.max(0, caps[m.g] - 1);
    for (const g of m.gr) if (model.units.has(g)) st.removed.add(model.units.get(g));
    ctx.hard.forEach((t, i) => { if (satisfies(m, t)) st.hit[i] = true; });
    crafts.forEach((c, j) => {
      if (satisfies(m, c)) st.craftHit |= 1 << j;
      else if (m.gr.some((g) => c.groups.includes(g))) st.craftBlocked |= 1 << j;
    });
  }
  st.craftBlocked &= ~st.craftHit;
  return st;
}

/** Splits units into per-side "others" (grouped by weight) and the special units of one scenario. */
function sides(model, removed, needs, excludes, caps, maxFinal) {
  const special = new Set([...needs.map((n) => n.u), ...excludes]);
  const out = {};
  for (const side of ["p", "s"]) {
    const byW = new Map();
    for (const u of model.units.values()) {
      if (u.side !== side || removed.has(u) || special.has(u)) continue;
      const key = u.w.toPrecision(12);
      if (!byW.has(key)) byW.set(key, { w: u.w, m: 0 });
      byW.get(key).m++;
    }
    const S = {
      cap: caps[side],
      maxFinal: maxFinal[side], // the finished item may have at most this many mods on this side
      classes: [...byW.values()],
      needs: needs.filter((n) => n.u.side === side).map((n) => ({ w: n.u.w, q: n.q })),
      excl: excludes.filter((u) => u.side === side).map((u) => u.w),
    };
    S.units = S.classes.reduce((a, c) => a + c.m, 0) + S.needs.length + S.excl.length;
    out[side] = S;
  }
  return out;
}

/**
 * For one side at time t: G[j] = P(exactly j groups rang and the wanted/excluded conditions hold), j < cap;
 * F[a] = density of a group ringing at t with exactly a rung before, the a+1 of them meeting the conditions.
 */
// scratch buffers for sideAt, reused between calls (the integral calls it a few thousand times per plan)
let scratch = new Float64Array(0);
function buffer(n) { if (scratch.length < n) scratch = new Float64Array(n * 2); return scratch; }

// P(exactly j of m clocks have rung), j < c, written into buf at off
function binomInto(buf, off, m, p, c) {
  const q = 1 - p;
  let coef = 1;
  for (let j = 0; j < c; j++) {
    buf[off + j] = j <= m ? coef * Math.pow(p, j) * Math.pow(q, m - j) : 0;
    coef = (coef * (m - j)) / (j + 1);
  }
}

// out = a * b truncated to c terms (all at offsets in buf)
function convInto(buf, out, a, b, c) {
  for (let i = 0; i < c; i++) {
    let v = 0;
    for (let j = 0; j <= i; j++) v += buf[a + j] * buf[b + i - j];
    buf[out + i] = v;
  }
}

function sideAt(S, t) {
  const c = S.cap;
  const G = new Float64Array(Math.max(c, 1)), F = new Float64Array(Math.max(c, 1));
  if (c === 0) return { G, F };
  const K = S.classes.length;
  // layout: rows[K], rowsLess[K], pre[K+1], suf[K+1], tmp, tmp2 — each c long
  const ROWS = 0, LESS = K * c, PRE = 2 * K * c, SUF = PRE + (K + 1) * c, TMP = SUF + (K + 1) * c, TMP2 = TMP + c;
  const buf = buffer(TMP2 + c);
  for (let k = 0; k < K; k++) {
    const cls = S.classes[k];
    const p = -Math.expm1(-cls.w * t);
    binomInto(buf, ROWS + k * c, cls.m, p, c);
    binomInto(buf, LESS + k * c, cls.m - 1, p, c);
  }
  // prefix/suffix products so "all classes but one unit of class k" costs O(K)
  for (let j = 0; j < c; j++) { buf[PRE + j] = j === 0 ? 1 : 0; buf[SUF + K * c + j] = j === 0 ? 1 : 0; }
  for (let k = 0; k < K; k++) convInto(buf, PRE + (k + 1) * c, PRE + k * c, ROWS + k * c, c);
  for (let k = K - 1; k >= 0; k--) convInto(buf, SUF + k * c, SUF + (k + 1) * c, ROWS + k * c, c);
  const Q = PRE + K * c;
  let NA = 1;
  const np = S.needs.map((n) => -Math.expm1(-n.w * t) * n.q);
  for (const v of np) NA *= v;
  let EX = 1;
  for (const w of S.excl) EX *= Math.exp(-w * t);
  const nN = S.needs.length;
  for (let j = nN; j < c; j++) G[j] = NA * EX * buf[Q + j - nN];
  // an "other" group rings at t
  for (let k = 0; k < K; k++) {
    const cls = S.classes[k];
    const dens = cls.m * cls.w * Math.exp(-cls.w * t);
    if (!(dens > 0)) continue;
    convInto(buf, TMP, PRE + k * c, LESS + k * c, c);
    convInto(buf, TMP2, TMP, SUF + (k + 1) * c, c);
    for (let a = nN; a < c; a++) F[a] += dens * NA * EX * buf[TMP2 + a - nN];
  }
  // a wanted group rings at t (with the wanted tier)
  for (let v = 0; v < nN; v++) {
    const n = S.needs[v];
    let others = 1;
    for (let u = 0; u < nN; u++) if (u !== v) others *= np[u];
    const dens = n.w * Math.exp(-n.w * t) * n.q * others * EX;
    for (let a = nN - 1; a < c; a++) F[a] += dens * buf[Q + a - nN + 1];
  }
  return { G, F };
}

/** P(conditions hold on the finished item) for every number of rolled mods d in ds. */
function eventProbs(sd, ds) {
  const X = sd.p, Y = sd.s;
  const res = new Map(ds.map((d) => [d, 0]));
  if (X.maxFinal < 0 || Y.maxFinal < 0) return res;
  let wTot = 0, wMin = Infinity;
  for (const S of [X, Y]) {
    if (S.cap === 0) continue;
    for (const k of S.classes) { wTot += k.w * k.m; wMin = Math.min(wMin, k.w); }
    for (const n of S.needs) { wTot += n.w; wMin = Math.min(wMin, n.w); }
    for (const w of S.excl) { wTot += w; wMin = Math.min(wMin, w); }
  }
  if (!(wTot > 0)) {
    for (const d of ds) res.set(d, nothingRolls(sd));
    return res;
  }
  const s0 = Math.log(GRID_START / wTot), s1 = Math.log(GRID_END / wMin);
  let n = Math.ceil((s1 - s0) / GRID_STEP);
  if (n % 2) n++;
  const h = (s1 - s0) / n;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = Math.exp(s0 + i * h);
    pts.push({ t, x: sideAt(X, t), y: sideAt(Y, t) });
  }
  // cumulative ∫0^t F[cap-1] ds per side ("the side is already full at t"), 3rd-order accurate
  const fullOf = (key, S) => {
    const out = new Float64Array(n + 1);
    if (S.cap === 0) return out;
    const f = pts.map((pt) => pt[key].F[S.cap - 1] * pt.t);
    for (let i = 0; i < n; i++) {
      const step = i + 2 <= n ? (h / 12) * (5 * f[i] + 8 * f[i + 1] - f[i + 2]) : (h / 12) * (-f[i - 1] + 8 * f[i] + 5 * f[i + 1]);
      out[i + 1] = out[i] + step;
    }
    return out;
  };
  const fullX = fullOf("x", X), fullY = fullOf("y", Y);
  // P(the side has b mods at t and meets its conditions)
  const g = (S, side, full, i, b) => {
    if (b < 0 || b > S.cap || b > S.maxFinal) return 0;
    if (S.cap === 0) return S.needs.length ? 0 : 1;
    return b < S.cap ? side.G[b] : full[i];
  };
  for (const d of ds) {
    if (d <= 0) { res.set(d, nothingRolls(sd)); continue; }
    let sum = 0;
    for (let i = 0; i <= n; i++) {
      const pt = pts[i];
      let v = 0;
      for (const [Z, z, W, wk, wf] of [[X, pt.x, Y, pt.y, fullY], [Y, pt.y, X, pt.x, fullX]]) {
        const maxA = Math.min(Z.cap, Z.maxFinal) - 1;
        for (let a = 0; a <= maxA && a < d; a++) v += z.F[a] * g(W, wk, wf, i, d - 1 - a);
      }
      const wgt = i === 0 || i === n ? 1 : i % 2 ? 4 : 2;
      sum += wgt * v * pt.t;
    }
    let p = (sum * h) / 3;
    // the pool can run dry before the item has d mods: then every group has rung
    const reach = Math.min(X.cap, X.units) + Math.min(Y.cap, Y.units);
    if (reach < d) p += endState(X, fullX[n]) * endState(Y, fullY[n]);
    res.set(d, Math.min(1, Math.max(0, p)));
  }
  return res;
}

// a side once every one of its groups has rung (only used when the pool runs dry)
function endState(S, full) {
  const k = Math.min(S.cap, S.units);
  if (k > S.maxFinal) return 0;
  if (S.units > S.cap) return full;
  if (S.excl.length) return 0;
  return S.needs.reduce((a, n) => a * n.q, 1);
}

// no mods are rolled at all (forced mods already fill the count)
function nothingRolls(sd) {
  return sd.p.needs.length || sd.s.needs.length ? 0 : 1;
}

/**
 * Exact chance that one full reroll (chaos, essence, fossil) meets every hard target and leaves room for the
 * bench crafts. Uses ctx.caps / ctx.counts when set (for rerolls that keep one side). Null when not handled.
 */
export function exactReroll(ctx, entries, forced) {
  if (ctx.hard.length > MAX_EXACT_TARGETS) return null;
  const model = buildUnits(ctx, entries);
  if (!model) return null;
  const crafts = ctx.crafts || [];
  const caps = { ...(ctx.caps || maxAffixes(ctx.base)) };
  const st = applyForced(ctx, model, forced, caps);
  if (st.craftBlocked) return { p: 0 };
  const needs = [];
  for (let i = 0; i < ctx.hard.length; i++) {
    if (st.hit[i]) continue;
    const u = model.targetUnit[i];
    if (!u || st.removed.has(u)) return { p: 0 };
    needs.push({ u, q: u.sat[i] / u.w });
  }
  // groups that must stay empty (e.g. for a mod that gets added later by unveiling)
  const absent = [];
  for (const g of ctx.absentGroups || []) {
    if (forced.some((m) => m.gr.includes(g))) return { p: 0 };
    const u = model.units.get(g);
    if (!u || st.removed.has(u)) continue;
    if (model.targetUnit.includes(u) || model.craftUnit.includes(u)) return null;
    absent.push(u);
  }
  // every open craft either rolls naturally with a good enough tier, or doesn't roll and gets a free slot
  const open = crafts.map((_, j) => j).filter((j) => !(st.craftHit & (1 << j)));
  const counts = ctx.counts;
  const ds = counts.map(([n]) => n - forced.length);
  let p = 0;
  for (let combo = 0; combo < 1 << open.length; combo++) {
    const scNeeds = [...needs], excl = [...absent];
    let missing = 0, possible = true;
    open.forEach((j, k) => {
      const u = model.craftUnit[j];
      const present = u && !st.removed.has(u);
      if (combo & (1 << k)) {
        if (!present || !(u.craftSat[j] > 0)) possible = false;
        else scNeeds.push({ u, q: u.craftSat[j] / u.w });
      } else {
        missing |= 1 << j;
        if (present) excl.push(u);
      }
    });
    if (!possible) continue;
    const r = craftReserve(crafts, missing, ctx.multimodSide, ctx.reserve);
    const maxFinal = { p: caps.p - r.p, s: caps.s - r.s };
    const probs = eventProbs(sides(model, st.removed, scNeeds, excl, caps, maxFinal), ds);
    counts.forEach(([n, w]) => { p += w * probs.get(n - forced.length); });
  }
  return { p: Math.min(1, p) };
}

/**
 * Exact odds of a reroll whose first mod is drawn only from `first` (entries of the pool), as Harvest's
 * "including a <tag> modifier" does. Mixes exactReroll over every possible first mod; first mods that leave the
 * rest of the roll in the same situation (same side and group weight, no role) are grouped into one case.
 */
export function exactRerollFirstFrom(ctx, entries, first, forced) {
  if (ctx.hard.length > MAX_EXACT_TARGETS) return null;
  const model = buildUnits(ctx, entries);
  if (!model) return null;
  const roleUnits = new Set([...model.targetUnit, ...model.craftUnit].filter(Boolean));
  const cases = new Map();
  let total = 0;
  const caps = { ...(ctx.caps || maxAffixes(ctx.base)) };
  for (const m of forced) caps[m.g]--;
  const taken = new Set(forced.flatMap((m) => m.gr));
  for (const e of first) {
    if (!(e.w > 0) || caps[e.mod.g] <= 0 || e.mod.gr.some((g) => taken.has(g))) continue;
    const u = model.units.get(e.mod.gr[0]);
    if (!u) continue;
    const key = roleUnits.has(u)
      ? `r:${u.g}:${ctx.hard.map((t) => +satisfies(e.mod, t)).join("")}:${(ctx.crafts || []).map((c) => +satisfies(e.mod, c)).join("")}`
      : `o:${u.side}:${u.w.toPrecision(12)}`;
    if (!cases.has(key)) cases.set(key, { mod: e.mod, w: 0 });
    cases.get(key).w += e.w;
    total += e.w;
  }
  if (!(total > 0)) return exactReroll(ctx, entries, forced);
  let p = 0;
  for (const c of cases.values()) {
    const r = exactReroll(ctx, entries, [...forced, c.mod]);
    if (!r) return null;
    p += (c.w / total) * r.p;
  }
  return { p };
}

// ------------------------------------------------------------------ alteration route

/**
 * Exact odds for the alteration route when it has at most two hard targets: stage 1 (alteration with an
 * augmentation when only one of the stage-1 mods shows up) and stage 2 (regal, then exalts while the
 * missing mods can still fit), following the same rules as the simulation in craft.js. With a block
 * variant ({tag, side}), a "Cannot roll ... Modifiers" craft goes on after the regal when there is room,
 * and the exalts skip mods with that tag. With {onlySide}, the exalts can only add mods to that side
 * (Eldritch Exalted Orbs with the matching dominance).
 */
export function exactAltRegal(ctx, s1, block = null) {
  if (ctx.hard.length > MAX_EXACT_TARGETS || ctx.fixedEntries.length > 1) return null;
  const model = buildUnits(ctx, ctx.pool, block?.tag || null);
  if (!model) return null;
  const F = ctx.fixedEntries[0]?.mod || null; // a fractured mod: stays on the magic item and fills its side
  const crafts = ctx.crafts || [];
  const fUnit = F ? model.units.get(F.gr[0]) || null : null;
  const units = [...model.units.values()];
  const W = { p: 0, s: 0 };
  for (const u of units) if (u !== fUnit) W[u.side] += u.w;
  const Wt = W.p + W.s;
  if (!(Wt > 0)) return null;
  const s1u = s1.map((x) => ({ i: x.i, u: model.targetUnit[x.i] }));
  if (!s1u.length) return null;
  if (s1u.some((x) => !x.u)) return { p1: 0, p2: 0, augPerAlt: 0, avgExalts: 0 };
  const sat = (x) => x.u.sat[x.i];
  const other = (side) => (side === "p" ? "s" : "p");
  const isRole = (u) => u.sat.some((x) => x > 0) || model.craftUnit.includes(u);

  // stage 1: distribution of successful magic items, as lists of {unit, kind}
  const starts = [];
  let augPerAlt = 0;
  const two = MAGIC_TWO_MOD_CHANCE, one = 1 - MAGIC_TWO_MOD_CHANCE;
  if (F) {
    // fractured: alteration keeps F, adds one mod to the open side with an augmentation when needed
    if (s1u.length !== 1 || s1u[0].u.side === F.g) return null;
    const [B] = s1u;
    starts.push({ p: sat(B) / W[B.u.side], mods: [{ fixed: F }, { u: B.u, kind: { target: B.i } }] });
    augPerAlt = 1 - two;
  } else if (s1u.length === 2) {
    const [A, B] = s1u;
    // both mods, in either order; with one mod the augmentation adds the other side, with the same odds
    const pAB = (sat(A) / Wt) * (sat(B) / W[B.u.side]) + (sat(B) / Wt) * (sat(A) / W[A.u.side]);
    starts.push({ p: pAB, mods: [{ u: A.u, kind: { target: A.i } }, { u: B.u, kind: { target: B.i } }] });
    augPerAlt = (one * (sat(A) + sat(B))) / Wt;
  } else {
    const [A] = s1u;
    const os = other(A.u.side);
    starts.push({ p: one * (sat(A) / Wt), mods: [{ u: A.u, kind: { target: A.i } }] });
    for (const v of units) {
      if (v.side !== os) continue;
      // the other mod can itself be a good roll of a bench craft
      for (const [kind, w] of isRole(v) ? outcomes(model, v, false) : [[null, v.w]]) {
        const pv = two * ((sat(A) / Wt) * (w / W[os]) + (w / Wt) * (sat(A) / W[A.u.side]));
        if (pv > 0) starts.push({ p: pv, mods: [{ u: A.u, kind: { target: A.i } }, { u: v, kind }] });
      }
    }
  }
  const p1 = starts.reduce((a, s) => a + s.p, 0);
  if (!(p1 > 0)) return { p1: 0, p2: 0, augPerAlt, avgExalts: 0 };

  // stage 2: regal + exalts, exact over every reachable item (at most 4 more mods). Groups without a role
  // are interchangeable when they share side and weights, so the state counts how many of each class are taken.
  const rare = maxAffixes(ctx.base);
  const roles = units.filter(isRole);
  const classes = [];
  const classOf = new Map();
  for (const u of units) {
    if (isRole(u)) continue;
    const key = u.side + ":" + u.w.toPrecision(12) + ":" + u.x.w.toPrecision(12);
    if (!classOf.has(key)) { classOf.set(key, classes.length); classes.push({ side: u.side, w: u.w, wx: u.x.w, m: 0 }); }
    classes[classOf.get(key)].m++;
    classOf.set(u, classOf.get(key));
  }
  const allCrafts = (1 << crafts.length) - 1;
  const fits = (st, missing, metaRoom) => {
    const r = craftReserve(crafts, missing, ctx.multimodSide, ctx.reserve);
    return st.n.p + r.p <= rare.p + (metaRoom === "p" ? 1 : 0) && st.n.s + r.s <= rare.s + (metaRoom === "s" ? 1 : 0);
  };
  const memo = new Map();
  // returns {ps: chance to finish, ex: expected exalts still to use}
  const solve = (st, regal) => {
    const key = st.c.join(",") + "|" + st.roles + "|" + st.hit.join("") + "|" + st.craftHit + "," + st.craftBlocked + "|" + +st.meta + +regal;
    const known = memo.get(key);
    if (known) return known;
    // the meta craft fills a slot while it's on the item; it comes off before the bench crafts
    const capOf = (side) => rare[side] - (st.meta && block.side === side ? 1 : 0);
    const missing = allCrafts & ~st.craftHit;
    const done = st.hit.every(Boolean) && !(missing & st.craftBlocked) && fits(st, missing, null);
    let res;
    if (!regal && done) res = { ps: 1, ex: 0 };
    else if (!regal) {
      const need = { p: 0, s: 0 };
      ctx.hard.forEach((t, i) => { if (!st.hit[i]) need[t.side]++; });
      const r = craftReserve(crafts, missing & ~st.craftBlocked, ctx.multimodSide, ctx.reserve);
      const free = (side) => capOf(side) - st.n[side];
      const otherSide = block?.onlySide ? other(block.onlySide) : null;
      if (need.p > free("p") || need.s > free("s") || need.p + r.p > rare.p - st.n.p || need.s + r.s > rare.s - st.n.s || free("p") + free("s") <= 0 ||
        (otherSide && need[otherSide] > 0) || (block?.onlySide && free(block.onlySide) <= 0)) res = { ps: 0, ex: 0 };
    }
    if (!res) {
      const filtered = st.meta && !regal;
      const open = (side) => st.n[side] < capOf(side) && (regal || !block?.onlySide || side === block.onlySide);
      let tot = 0;
      classes.forEach((k, i) => { if (open(k.side)) tot += (k.m - st.c[i]) * (filtered ? k.wx : k.w); });
      roles.forEach((u, r) => { if (open(u.side) && !(st.roles & (1 << r))) tot += filtered ? u.x.w : u.w; });
      if (!(tot > 0)) res = { ps: done ? 1 : 0, ex: 0 };
      else {
        let ps = 0, ex = 0;
        const go = (child, pr) => {
          // right after the regal, put the meta craft on if there's room for it
          if (regal && block?.tag) child.meta = child.n[block.side] < rare[block.side];
          const c = solve(child, false);
          ps += pr * c.ps;
          ex += pr * c.ex;
        };
        classes.forEach((k, i) => {
          const left = k.m - st.c[i];
          const w = filtered ? k.wx : k.w;
          if (left > 0 && open(k.side) && w > 0) go(addPlain(st, i, k.side), (left * w) / tot);
        });
        roles.forEach((u, r) => {
          if (!open(u.side) || st.roles & (1 << r)) return;
          for (const [kind, w] of outcomes(model, u, filtered)) if (w > 0) go(addRole(st, r, u, kind, model), w / tot);
        });
        res = { ps, ex: ex + (regal ? 0 : 1) };
      }
    }
    memo.set(key, res);
    return res;
  };
  let p2 = 0, avgExalts = 0;
  for (const s of starts) {
    let st = { c: classes.map(() => 0), roles: 0, n: { p: 0, s: 0 }, hit: ctx.hard.map(() => false), craftHit: 0, craftBlocked: 0, meta: false };
    for (const m of s.mods) {
      if (m.fixed) { st = addFixed(st, m.fixed, fUnit, roles, classOf, ctx, model); continue; }
      const r = roles.indexOf(m.u);
      st = r >= 0 ? addRole(st, r, m.u, m.kind, model) : addPlain(st, classOf.get(m.u), m.u.side);
    }
    const res = solve(st, true);
    p2 += (s.p / p1) * res.ps;
    avgExalts += (s.p / p1) * res.ex;
  }
  return { p1, p2, augPerAlt, avgExalts };
}

// ways a unit with a role can roll: [{target?, craft?} | null, weight]
function outcomes(model, u, filtered) {
  const part = filtered ? u.x : u;
  const out = [];
  let rest = part.w;
  part.sat.forEach((w, i) => { if (w > 0) { out.push([{ target: i }, w]); rest -= w; } });
  model.craftUnit.forEach((cu, j) => {
    if (cu === u && part.craftSat[j] > 0) { out.push([{ craft: j }, part.craftSat[j]]); rest -= part.craftSat[j]; }
  });
  if (rest > 1e-9 * u.w) out.push([null, rest]);
  return out;
}

// a fractured mod: takes its slot and its group (a worse roll of a bench craft's group blocks that craft)
function addFixed(st, F, fUnit, roles, classOf, ctx, model) {
  if (!fUnit) return { ...st, n: { ...st.n, [F.g]: st.n[F.g] + 1 } };
  const r = roles.indexOf(fUnit);
  if (r < 0) return addPlain(st, classOf.get(fUnit), F.g);
  const j = model.craftUnit.indexOf(fUnit);
  const kind = j >= 0 && satisfies(F, ctx.crafts[j]) ? { craft: j } : null;
  return addRole(st, r, fUnit, kind, model);
}

function addPlain(st, i, side) {
  const s = { ...st, c: [...st.c], n: { ...st.n } };
  s.c[i]++;
  s.n[side]++;
  return s;
}

function addRole(st, r, u, kind, model) {
  const s = { ...st, n: { ...st.n }, hit: [...st.hit], roles: st.roles | (1 << r) };
  s.n[u.side]++;
  if (kind && kind.target !== undefined) s.hit[kind.target] = true;
  model.craftUnit.forEach((cu, j) => {
    if (cu !== u) return;
    if (kind && kind.craft === j) s.craftHit |= 1 << j;
    else s.craftBlocked |= 1 << j;
  });
  return s;
}

/**
 * Chance that at least one of `choices` options, drawn by weight without repeating a mod group, meets target t.
 * Used for unveiling (Jun offers three unveiled mods to choose from).
 */
export function choiceChance(entries, t, choices) {
  const units = new Map();
  for (const e of entries) {
    if (!(e.w > 0)) continue;
    const g = e.mod.gr[0] ?? e.mod.id;
    if (!units.has(g)) units.set(g, { w: 0, sat: 0 });
    const u = units.get(g);
    u.w += e.w;
    if (satisfies(e.mod, t)) u.sat += e.w;
  }
  // interchangeable groups: same weight and same share of good mods
  const cls = new Map();
  for (const u of units.values()) {
    const key = u.w.toPrecision(12) + ":" + u.sat.toPrecision(12);
    if (!cls.has(key)) cls.set(key, { w: u.w, miss: 1 - u.sat / u.w, m: 0 });
    cls.get(key).m++;
  }
  const C = [...cls.values()];
  const memo = new Map();
  // P(none of the next k options is good | taken counts per class)
  const none = (taken, k) => {
    if (k === 0) return 1;
    const key = taken.join(",") + "|" + k;
    if (memo.has(key)) return memo.get(key);
    let tot = 0;
    C.forEach((c, i) => { tot += (c.m - taken[i]) * c.w; });
    let p = 1;
    if (tot > 0) {
      p = 0;
      C.forEach((c, i) => {
        const left = c.m - taken[i];
        if (!left || !(c.miss > 0)) return;
        const next = [...taken]; next[i]++;
        p += ((left * c.w) / tot) * c.miss * none(next, k - 1);
      });
    }
    memo.set(key, p);
    return p;
  };
  return 1 - none(C.map(() => 0), choices);
}
