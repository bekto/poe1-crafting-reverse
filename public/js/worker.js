// Runs the crafting simulations off the main thread so the page stays responsive.
import { indexData } from "./engine/data.js";
import { runPlan } from "./engine/run.js";

let db = null;

async function ensureDb(url) {
  if (!db) db = indexData(await (await fetch(url)).json());
  return db;
}

self.onmessage = async (ev) => {
  const { id, dataUrl, req } = ev.data;
  try {
    const d = await ensureDb(dataUrl);
    const plan = runPlan(d, req);
    self.postMessage({ id, ok: true, plan });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e && e.stack || e) });
  }
};
