// Alteration route, annul variant: when an exalt misses, use an Orb of Annulment and keep exalting, instead of
// starting over from a new magic item. Simulated, because the annul loops make the exact state space too large.
import { satisfies, craftReserve, maxAffixes } from "./pool.js";
import { MAGIC_TWO_MOD_CHANCE } from "./assumptions.js";
import { mulberry32 } from "./sim.js";

export const ANNUL_RUNS = 4000;
export const ANNUL_LIMITS = [1, 2, 3];

/**
 * One attempt from a good magic item (stage 1 of the alteration route): Regal Orb, then exalt while the missing mods
 * still fit; when they don't (or a bench craft's group holds a worse roll), annul a random mod, at most maxAnnuls
 * times, then give up and start over. Annulment removes one random explicit mod, possibly a wanted one.
 * Returns per attempt: chance to finish, average exalts and annulments used.
 */
export function simulateAnnulRoute(ctx, s1, maxAnnuls, runs = ANNUL_RUNS, seed = 4242) {
  const rng = mulberry32(seed);
  const entries = ctx.pool.filter((e) => e.w > 0);
  const rare = maxAffixes(ctx.base);
  const crafts = ctx.crafts;
  const W = { p: 0, s: 0 };
  for (const e of entries) W[e.mod.g] += e.w;
  const Wt = W.p + W.s;
  const satEntries = s1.map((x) => entries.filter((e) => satisfies(e.mod, x.t)));
  const satW = satEntries.map((list) => list.reduce((a, e) => a + e.w, 0));
  if (satW.some((w) => !(w > 0))) return null;

  const pickFrom = (list) => {
    let tot = 0;
    for (const e of list) tot += e.w;
    let r = rng() * tot;
    for (const e of list) { r -= e.w; if (r <= 0) return e.mod; }
    return list[list.length - 1].mod;
  };
  // a good magic item, drawn from its exact distribution given that stage 1 succeeded
  const goodMagic = () => {
    if (s1.length === 2) return [pickFrom(satEntries[0]), pickFrom(satEntries[1])];
    const side = s1[0].t.side, os = side === "p" ? "s" : "p";
    const alone = (1 - MAGIC_TWO_MOD_CHANCE) * satW[0] / Wt;
    const pair = MAGIC_TWO_MOD_CHANCE * satW[0] * W[os] * (1 / (Wt * W[os]) + 1 / (Wt * W[side]));
    const a = pickFrom(satEntries[0]);
    if (rng() * (alone + pair) < alone) return [a];
    return [a, pickFrom(entries.filter((e) => e.mod.g === os))];
  };
  const draw = (item) => {
    const groups = new Set(item.flatMap((m) => m.gr));
    const n = { p: 0, s: 0 };
    for (const m of item) n[m.g]++;
    const avail = entries.filter((e) => n[e.mod.g] < rare[e.mod.g] && !e.mod.gr.some((g) => groups.has(g)));
    return avail.length ? pickFrom(avail) : null;
  };
  const state = (item) => {
    const n = { p: 0, s: 0 };
    for (const m of item) n[m.g]++;
    const missingHard = ctx.hard.filter((t) => !item.some((m) => satisfies(m, t)));
    let missing = 0, blocked = 0;
    crafts.forEach((c, j) => {
      if (item.some((m) => satisfies(m, c))) return;
      missing |= 1 << j;
      if (item.some((m) => m.gr.some((g) => c.groups.includes(g)))) blocked |= 1 << j;
    });
    const r = craftReserve(crafts, missing, ctx.multimodSide, ctx.reserve);
    const need = { p: r.p, s: r.s };
    for (const t of missingHard) need[t.side]++;
    const fits = n.p + need.p <= rare.p && n.s + need.s <= rare.s;
    return { done: !missingHard.length && !blocked && fits, canExalt: fits && !blocked };
  };

  let exalts = 0, annuls = 0, finished = 0;
  for (let run = 0; run < runs; run++) {
    const item = goodMagic();
    const regal = draw(item);
    if (regal) item.push(regal);
    let used = 0;
    for (;;) {
      const s = state(item);
      if (s.done) { finished++; break; }
      const m = s.canExalt ? draw(item) : null;
      if (m) { item.push(m); exalts++; continue; }
      if (used >= maxAnnuls || !item.length) break;
      item.splice(Math.floor(rng() * item.length), 1);
      annuls++; used++;
    }
  }
  return { ps: finished / runs, exalts: exalts / runs, annuls: annuls / runs, runs, maxAnnuls };
}
