// Shared entry point for the worker and the main-thread fallback.
import { planCraft } from "./craft.js";

export function runPlan(d, req) {
  const base = d.bases.find((b) => b.id === req.baseId);
  const wanted = req.wanted.map((w) => ({ mod: d.modById.get(w.modId), minMod: d.modById.get(w.minModId) }));
  const fixed = req.fixedIds.map((i) => d.modById.get(i));
  const plan = planCraft(d, base, req.ilvl, req.influences, wanted, fixed, { trials: req.trials || 20000, prices: req.prices || null });
  return slimPlan(plan);
}

// Only send what the UI needs (mod objects carry compiled regexes)
function slimMod(m) { return m ? { id: m.id, x: m.x, g: m.g, n: m.n, l: m.l } : null; }
function slimPlan(p) {
  return {
    minIlvl: p.minIlvl,
    targets: p.targets.map((t) => ({ mod: slimMod(t.mod), minMod: slimMod(t.minMod), side: t.side, share: t.share, bench: t.bench ? { mod: slimMod(t.bench.mod), cost: t.bench.cost } : null, benchPossible: t.benchPossible, naturalWeight: t.naturalWeight })),
    benchTarget: p.benchTarget ? { mod: slimMod(p.benchTarget.mod), option: { mod: slimMod(p.benchTarget.option.mod), cost: p.benchTarget.option.cost } } : null,
    extraBenchable: p.extraBenchable.map(slimMod),
    impossibleNaturally: p.impossibleNaturally.map(slimMod),
    methods: p.methods.map((m) => ({
      kind: m.kind, name: m.name, p: m.p, hits: m.hits, trials: m.trials, upperBound: m.upperBound,
      expected: m.expected, n90: m.n90, exact: !!m.exact, currency: m.currency, steps: m.steps, corrupt: m.corrupt || false,
      p1: m.p1, p2: m.p2, multimod: !!m.multimod, approximate: !!m.approximate, harvestKeep: !!m.harvestKeep,
      restartCurrency: m.restartCurrency || null, annul: m.annul ? { currency: m.annul.currency, maxAnnuls: m.annul.maxAnnuls, choice: m.annul.choice, cost: m.annul.cost, restartCost: m.annul.restartCost } : null, lockSide: m.lockSide || null, block: m.block ? m.block.tag : null,
      crafts: (m.crafts || []).map((c) => ({ mod: slimMod(c.mod), option: { mod: slimMod(c.option.mod), cost: c.option.cost } })),
    })),
  };
}
