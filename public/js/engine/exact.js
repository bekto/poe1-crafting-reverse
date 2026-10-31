// Exact odds (no Monte Carlo noise) for crafts with one or two wanted mods.
//
// Rolling mods one at a time with chance proportional to weight, without repeating a mod group, is the
// same as giving every mod group an exponential "clock" with rate = its total weight and taking groups
// in the order their clocks ring (skipping a side once it is full, stopping when the item has enough mods).
// In that picture the prefix side and the suffix side are independent; they only meet at the moment the
// item gets its last mod. So the odds are a one-dimensional integral over that moment, and on each side
// the number of other groups that have rung by time t follows from a small Poisson-binomial table.
// Groups with the same weight are interchangeable, which keeps the tables small.
import { satisfies, maxAffixes } from "./pool.js";
import { rareModCounts, MAGIC_TWO_MOD_CHANCE } from "./assumptions.js";

export const MAX_EXACT_TARGETS = 2;
// log-time grid for the integral: step and range (in multiples of the fastest/slowest clock)
const GRID_STEP = 0.04;
const GRID_START = 1e-10; // × 1 / total weight
const GRID_END = 45; // × 1 / smallest weight; e^-45 of the slowest clock is still left

/**
 * Turns a weighted pool into mod groups ("units"). Returns null when the structure isn't one this method
 * handles exactly (a mod in several groups, a group on both sides, or a target spread over several groups).
 */
export function buildUnits(ctx, entries) {
  const units = new Map();
  for (const e of entries) {
    if (!(e.w > 0)) continue;
    if (e.mod.gr.length !== 1) return null;
    const g = e.mod.gr[0];
    let u = units.get(g);
    if (!u) units.set(g, (u = { g, side: e.mod.g, w: 0, sat: ctx.hard.map(() => 0), benchSat: 0 }));
    if (u.side !== e.mod.g) return null;
    u.w += e.w;
    ctx.hard.forEach((t, i) => { if (satisfies(e.mod, t)) u.sat[i] += e.w; });
    if (ctx.benchTarget && satisfies(e.mod, ctx.benchTarget)) u.benchSat += e.w;
  }
  const targetUnit = ctx.hard.map((_, i) => {
    const us = [...units.values()].filter((u) => u.sat[i] > 0);
    return us.length > 1 ? undefined : us[0] || null;
  });
  if (targetUnit.includes(undefined)) return null;
  let benchUnit = null;
  if (ctx.benchTarget) {
    if (ctx.benchTarget.groups.length !== 1) return null;
    benchUnit = units.get(ctx.benchTarget.groups[0]) || null;
    if ([...units.values()].some((u) => u.benchSat > 0 && u !== benchUnit)) return null;
  }
  return { units, targetUnit, benchUnit };
}

/** Applies mods that are on the item before rolling (fractured, essence, fossil-forced). */
function applyForced(ctx, model, forced, caps) {
  const st = { hit: ctx.hard.map(() => false), benchHit: false, benchBlocked: false, removed: new Set() };
  for (const m of forced) {
    caps[m.g] = Math.max(0, caps[m.g] - 1);
    for (const g of m.gr) if (model.units.has(g)) st.removed.add(model.units.get(g));
    ctx.hard.forEach((t, i) => { if (satisfies(m, t)) st.hit[i] = true; });
    if (ctx.benchTarget) {
      if (satisfies(m, ctx.benchTarget)) st.benchHit = true;
      else if (m.gr.some((g) => ctx.benchTarget.groups.includes(g))) st.benchBlocked = true;
    }
  }
  return st;
}

/** Splits units into per-side "others" (grouped by weight) and the special units of one scenario. */
function sides(model, removed, needs, excludes, caps, benchSide) {
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
    out[side] = {
      cap: caps[side],
      classes: [...byW.values()],
      needs: needs.filter((n) => n.u.side === side).map((n) => ({ w: n.u.w, q: n.q })),
      excl: excludes.filter((u) => u.side === side).map((u) => u.w),
      fullAllowed: benchSide !== side, // the bench craft needs a free slot on its side
    };
    out[side].units = out[side].classes.reduce((a, c) => a + c.m, 0) + out[side].needs.length + out[side].excl.length;
  }
  return out;
}

function binomRow(m, p, len) {
  // P(exactly j of m clocks have rung), j < len
  const row = new Float64Array(len);
  const q = 1 - p;
  let c = 1;
  for (let j = 0; j < len && j <= m; j++) {
    row[j] = c * Math.pow(p, j) * Math.pow(q, m - j);
    c = (c * (m - j)) / (j + 1);
  }
  return row;
}

function conv(a, b, len) {
  const out = new Float64Array(len);
  for (let i = 0; i < len; i++) { if (!a[i]) continue; for (let j = 0; i + j < len; j++) out[i + j] += a[i] * b[j]; }
  return out;
}

/**
 * For one side at time t: G[j] = P(exactly j groups rang and the wanted/excluded conditions hold), j < cap;
 * F[a] = density of a group ringing at t with exactly a rung before, the a+1 of them meeting the conditions.
 */
function sideAt(S, t) {
  const c = S.cap;
  const G = new Float64Array(Math.max(c, 1)), F = new Float64Array(Math.max(c, 1));
  if (c === 0) return { G, F };
  const p = S.classes.map((k) => -Math.expm1(-k.w * t));
  const rows = S.classes.map((k, i) => binomRow(k.m, p[i], c));
  const rowsLess = S.classes.map((k, i) => binomRow(k.m - 1, p[i], c));
  // prefix/suffix products so "all classes but one unit of class k" costs O(K)
  const K = rows.length;
  const one = new Float64Array(c); one[0] = 1;
  const pre = [one];
  for (let k = 0; k < K; k++) pre.push(conv(pre[k], rows[k], c));
  const suf = new Array(K + 1); suf[K] = one;
  for (let k = K - 1; k >= 0; k--) suf[k] = conv(suf[k + 1], rows[k], c);
  const Q = pre[K];
  let NA = 1;
  const np = S.needs.map((n) => -Math.expm1(-n.w * t) * n.q);
  for (const v of np) NA *= v;
  let EX = 1;
  for (const w of S.excl) EX *= Math.exp(-w * t);
  const nN = S.needs.length;
  for (let j = nN; j < c; j++) G[j] = NA * EX * Q[j - nN];
  // an "other" group rings at t
  for (let k = 0; k < K; k++) {
    const cls = S.classes[k];
    const dens = cls.m * cls.w * Math.exp(-cls.w * t);
    if (!(dens > 0)) continue;
    const Qk = conv(conv(pre[k], rowsLess[k], c), suf[k + 1], c);
    for (let a = nN; a < c; a++) F[a] += dens * NA * EX * Qk[a - nN];
  }
  // a wanted group rings at t (with the wanted tier)
  S.needs.forEach((n, v) => {
    let others = 1;
    np.forEach((x, u) => { if (u !== v) others *= x; });
    const dens = n.w * Math.exp(-n.w * t) * n.q * others * EX;
    for (let a = nN - 1; a < c; a++) F[a] += dens * Q[a - nN + 1];
  });
  return { G, F };
}

/** P(conditions hold on the finished item) for every number of rolled mods d in ds. */
function eventProbs(sd, ds) {
  const X = sd.p, Y = sd.s;
  let wTot = 0, wMin = Infinity;
  for (const S of [X, Y]) {
    for (const k of S.classes) { wTot += k.w * k.m; wMin = Math.min(wMin, k.w); }
    for (const n of S.needs) { wTot += n.w; wMin = Math.min(wMin, n.w); }
    for (const w of S.excl) { wTot += w; wMin = Math.min(wMin, w); }
  }
  const res = new Map(ds.map((d) => [d, 0]));
  if (!(wTot > 0)) {
    for (const d of ds) res.set(d, finalNoDraw(sd, d, true));
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
  const g = (S, side, i, b) => {
    if (b < 0 || b > S.cap) return 0;
    if (S.cap === 0) return S.needs.length || !S.fullAllowed ? 0 : 1;
    if (b < S.cap) return side.G[b];
    return S.fullAllowed ? (S === X ? fullX[i] : fullY[i]) : 0;
  };
  for (const d of ds) {
    if (d <= 0) { res.set(d, finalNoDraw(sd, d, false)); continue; }
    let sum = 0;
    for (let i = 0; i <= n; i++) {
      const pt = pts[i];
      let v = 0;
      for (const [Z, z, W, wk] of [[X, pt.x, Y, pt.y], [Y, pt.y, X, pt.x]]) {
        const maxA = Z.cap - 1 - (Z.fullAllowed ? 0 : 1);
        for (let a = 0; a <= maxA && a < d; a++) v += z.F[a] * g(W, wk, i, d - 1 - a);
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
  if (S.units > S.cap) return S.fullAllowed ? full : 0;
  if (S.excl.length) return 0;
  if (!S.fullAllowed && S.units >= S.cap) return 0;
  return S.needs.reduce((a, n) => a * n.q, 1);
}

// no mods are rolled at all (forced mods already fill the count)
function finalNoDraw(sd) {
  for (const S of [sd.p, sd.s]) {
    if (S.needs.length) return 0;
    if (!S.fullAllowed && S.cap <= 0) return 0;
  }
  return 1;
}

/**
 * Exact chance that one full reroll (chaos, essence, fossil) meets every hard target and leaves room for the
 * bench craft. Returns null when the case isn't handled exactly.
 */
export function exactReroll(ctx, entries, forced) {
  if (ctx.hard.length > MAX_EXACT_TARGETS) return null;
  const model = buildUnits(ctx, entries);
  if (!model) return null;
  const caps = { ...maxAffixes(ctx.base) };
  const st = applyForced(ctx, model, forced, caps);
  const needs = [];
  for (let i = 0; i < ctx.hard.length; i++) {
    if (st.hit[i]) continue;
    const u = model.targetUnit[i];
    if (!u || st.removed.has(u)) return { p: 0 };
    needs.push({ u, q: u.sat[i] / u.w });
  }
  const scenarios = [];
  const bench = ctx.benchTarget && !st.benchHit ? model.benchUnit : null;
  if (ctx.benchTarget && !st.benchHit) {
    // the bench mod's group rolls with a good enough tier: no craft needed
    if (bench && bench.benchSat > 0 && !st.removed.has(bench)) scenarios.push({ needs: [...needs, { u: bench, q: bench.benchSat / bench.w }], excl: [], benchSide: null });
    // or it doesn't roll, and a slot stays free on its side
    if (!st.benchBlocked) scenarios.push({ needs, excl: bench && !st.removed.has(bench) ? [bench] : [], benchSide: ctx.benchTarget.side });
  } else scenarios.push({ needs, excl: [], benchSide: null });

  const counts = rareModCounts(ctx.base);
  const ds = counts.map(([n]) => n - forced.length);
  let p = 0;
  for (const sc of scenarios) {
    const sd = sides(model, st.removed, sc.needs, sc.excl, caps, sc.benchSide);
    const probs = eventProbs(sd, ds);
    counts.forEach(([n, w]) => { p += w * probs.get(n - forced.length); });
  }
  return { p: Math.min(1, p) };
}

// ------------------------------------------------------------------ alteration route

/**
 * Exact odds for the alteration route when it has at most two hard targets: stage 1 (alteration with an
 * augmentation when only one of the stage-1 mods shows up) and stage 2 (regal, then exalts while the
 * missing mods can still fit), following the same rules as the simulation in craft.js.
 */
export function exactAltRegal(ctx, s1) {
  if (ctx.hard.length > MAX_EXACT_TARGETS || ctx.fixedEntries.length) return null;
  const model = buildUnits(ctx, ctx.pool);
  if (!model) return null;
  const units = [...model.units.values()];
  const W = { p: 0, s: 0 };
  for (const u of units) W[u.side] += u.w;
  const Wt = W.p + W.s;
  if (!(Wt > 0)) return null;
  const s1u = s1.map((x) => ({ i: x.i, u: model.targetUnit[x.i] }));
  if (s1u.some((x) => !x.u)) return { p1: 0, p2: 0, augPerAlt: 0, avgExalts: 0 };
  const sat = (x) => x.u.sat[x.i];
  const other = (side) => (side === "p" ? "s" : "p");

  // stage 1: distribution of successful magic items, as lists of [unit, satisfied?] pairs
  const starts = []; // {p, mods: [{u, kind}]}, kind as in outcomes()
  let augPerAlt = 0;
  const single = MAGIC_TWO_MOD_CHANCE, one = 1 - MAGIC_TWO_MOD_CHANCE;
  if (s1u.length === 2) {
    const [A, B] = s1u;
    // both mods, in either order; with one mod the augmentation adds the other side, with the same odds
    const pAB = (sat(A) / Wt) * (sat(B) / W[B.u.side]) + (sat(B) / Wt) * (sat(A) / W[A.u.side]);
    starts.push({ p: pAB, mods: [{ u: A.u, kind: { target: A.i } }, { u: B.u, kind: { target: B.i } }] });
    augPerAlt = one * (sat(A) + sat(B)) / Wt;
  } else if (s1u.length === 1) {
    const [A] = s1u;
    const os = other(A.u.side);
    starts.push({ p: one * (sat(A) / Wt), mods: [{ u: A.u, kind: { target: A.i } }] });
    for (const v of units) {
      if (v.side !== os) continue;
      // the other mod can itself be a good roll of the bench group
      const kinds = v.sat.some((x) => x > 0) || v === model.benchUnit ? outcomes(ctx, model, v) : [[null, v.w]];
      for (const [kind, w] of kinds) {
        const pv = single * ((sat(A) / Wt) * (w / W[os]) + (w / Wt) * (sat(A) / W[A.u.side]));
        if (pv > 0) starts.push({ p: pv, mods: [{ u: A.u, kind: { target: A.i } }, { u: v, kind }] });
      }
    }
  } else return null;
  const p1 = starts.reduce((a, s) => a + s.p, 0);
  if (!(p1 > 0)) return { p1: 0, p2: 0, augPerAlt, avgExalts: 0 };

  // stage 2: regal + exalts, exact over every reachable item (at most 4 more mods). Groups without a role
  // are interchangeable when they share side and weight, so the state counts how many of each class are taken.
  const rare = maxAffixes(ctx.base);
  const bench = ctx.benchTarget;
  const benchSide = bench ? bench.side : null;
  const isRole = (u) => u.sat.some((x) => x > 0) || u === model.benchUnit;
  const roles = units.filter(isRole);
  const classes = [];
  const classOf = new Map();
  for (const u of units) {
    if (isRole(u)) continue;
    const key = u.side + ":" + u.w.toPrecision(12);
    if (!classOf.has(key)) { classOf.set(key, classes.length); classes.push({ side: u.side, w: u.w, m: 0 }); }
    classes[classOf.get(key)].m++;
    classOf.set(u, classOf.get(key));
  }
  const memo = new Map();
  // returns {ps: chance to finish, ex: expected exalts still to use}
  const solve = (st, regal) => {
    const key = st.c.join(",") + "|" + st.roles + "|" + st.hit.join("") + "|" + +st.benchHit + +st.benchBlocked + "|" + +regal;
    const hitMemo = memo.get(key);
    if (hitMemo) return hitMemo;
    const done = st.hit.every(Boolean) && (!bench || st.benchHit || (st.n[benchSide] < rare[benchSide] && !st.benchBlocked));
    let res;
    if (!regal && done) res = { ps: 1, ex: 0 };
    else {
      const need = { p: 0, s: 0 };
      ctx.hard.forEach((t, i) => { if (!st.hit[i]) need[t.side]++; });
      if (bench && !st.benchHit && !st.benchBlocked) need[benchSide]++;
      if (!regal && (need.p > rare.p - st.n.p || need.s > rare.s - st.n.s || st.n.p + st.n.s >= rare.p + rare.s)) res = { ps: 0, ex: 0 };
    }
    if (!res) {
      let tot = 0;
      const open = (side) => st.n[side] < rare[side];
      classes.forEach((k, i) => { if (open(k.side)) tot += (k.m - st.c[i]) * k.w; });
      roles.forEach((u, r) => { if (open(u.side) && !(st.roles & (1 << r))) tot += u.w; });
      if (!(tot > 0)) res = { ps: done ? 1 : 0, ex: 0 };
      else {
        let ps = 0, ex = 0;
        const go = (child, pr) => { const c = solve(child, false); ps += pr * c.ps; ex += pr * c.ex; };
        classes.forEach((k, i) => {
          const left = k.m - st.c[i];
          if (left > 0 && open(k.side)) go(addPlain(st, i, k.side), (left * k.w) / tot);
        });
        roles.forEach((u, r) => {
          if (!open(u.side) || st.roles & (1 << r)) return;
          for (const [kind, w] of outcomes(ctx, model, u)) if (w > 0) go(addRole(st, r, u, kind, model), w / tot);
        });
        res = { ps, ex: ex + (regal ? 0 : 1) };
      }
    }
    memo.set(key, res);
    return res;
  };
  let p2 = 0, avgExalts = 0;
  for (const s of starts) {
    let st = { c: classes.map(() => 0), roles: 0, n: { p: 0, s: 0 }, hit: ctx.hard.map(() => false), benchHit: false, benchBlocked: false };
    for (const m of s.mods) {
      const r = roles.indexOf(m.u);
      st = r >= 0 ? addRole(st, r, m.u, m.kind, model) : addPlain(st, classOf.get(m.u), m.u.side);
    }
    const res = solve(st, true);
    p2 += (s.p / p1) * res.ps;
    avgExalts += (s.p / p1) * res.ex;
  }
  return { p1, p2, augPerAlt, avgExalts };
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
  if (u === model.benchUnit) { if (kind && kind.bench) s.benchHit = true; else s.benchBlocked = true; }
  return s;
}

// ways a unit with a role can roll: [{target}|{bench}|{none}, weight]
function outcomes(ctx, model, u) {
  const out = [];
  let rest = u.w;
  u.sat.forEach((w, i) => { if (w > 0) { out.push([{ target: i, bench: u === model.benchUnit && u.benchSat > 0 }, w]); rest -= w; } });
  if (u === model.benchUnit && u.benchSat > 0 && !u.sat.some((x) => x > 0)) { out.push([{ bench: true }, u.benchSat]); rest -= u.benchSat; }
  if (rest > 1e-9 * u.w) out.push([null, rest]);
  return out;
}
