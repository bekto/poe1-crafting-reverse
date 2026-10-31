// Stage 1 of the alteration route in closed form: the chance that an alteration (with the augmentation rule)
// gives the stage-1 mods, and a sampler for the good magic items it produces. Shared by the simulator and the
// annul variant; the exact engine (exact.js) uses the same formulas.
import { satisfies } from "./pool.js";
import { MAGIC_TWO_MOD_CHANCE } from "./assumptions.js";

/**
 * s1: 1 or 2 targets ({t}) on different sides; ctx.fixedEntries: at most one fractured mod.
 * Returns {p1, augPerAlt, sample(rng) -> [mods]} or null.
 */
export function stageOne(ctx, s1) {
  const fixed = ctx.fixedEntries.map((e) => e.mod);
  const entries = ctx.pool.filter((e) => e.w > 0 && !fixed.some((f) => e.mod.gr.some((g) => f.gr.includes(g))));
  const W = { p: 0, s: 0 };
  for (const e of entries) W[e.mod.g] += e.w;
  const Wt = W.p + W.s;
  const satEntries = s1.map((x) => entries.filter((e) => satisfies(e.mod, x.t)));
  const sat = satEntries.map((list) => list.reduce((a, e) => a + e.w, 0));
  if (!s1.length || !(Wt > 0) || sat.some((w) => !(w > 0))) return null;
  const two = MAGIC_TWO_MOD_CHANCE, one = 1 - two;
  const pickFrom = (rng, list) => {
    let tot = 0;
    for (const e of list) tot += e.w;
    let r = rng() * tot;
    for (const e of list) { r -= e.w; if (r <= 0) return e.mod; }
    return list[list.length - 1].mod;
  };
  if (fixed.length) {
    // the fractured mod stays; the open side always ends up with one mod (augment when it comes out empty)
    const side = s1[0].t.side;
    return { p1: sat[0] / W[side], augPerAlt: one, sample: (rng) => [...fixed, pickFrom(rng, satEntries[0])] };
  }
  if (s1.length === 2) {
    const [A, B] = s1.map((x) => x.t.side);
    return {
      p1: (sat[0] / Wt) * (sat[1] / W[B]) + (sat[1] / Wt) * (sat[0] / W[A]),
      augPerAlt: (one * (sat[0] + sat[1])) / Wt,
      sample: (rng) => [pickFrom(rng, satEntries[0]), pickFrom(rng, satEntries[1])],
    };
  }
  const side = s1[0].t.side, os = side === "p" ? "s" : "p";
  const alone = (one * sat[0]) / Wt;
  const pair = two * ((sat[0] / Wt) + (W[os] / Wt) * (sat[0] / W[side]));
  const others = entries.filter((e) => e.mod.g === os);
  return {
    p1: alone + (W[os] > 0 ? pair : 0),
    augPerAlt: 0,
    sample: (rng) => {
      const a = pickFrom(rng, satEntries[0]);
      if (!others.length || rng() * (alone + pair) < alone) return [a];
      return [a, pickFrom(rng, others)];
    },
  };
}
