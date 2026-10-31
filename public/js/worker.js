// Runs the crafting simulations off the main thread so the page stays responsive.
import { loadDb } from "./engine/data.js";
import { runPlan } from "./engine/run.js";

let db = null;

async function ensureDb(dir) {
  if (!db) db = await loadDb(async (path) => (await fetch(new URL(path, dir))).json());
  return db;
}

self.onmessage = async (ev) => {
  const { id, dataDir, req } = ev.data;
  try {
    const d = await ensureDb(dataDir);
    const plan = runPlan(d, req);
    self.postMessage({ id, ok: true, plan });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e && e.stack || e) });
  }
};
