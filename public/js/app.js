import { loadDb } from "./engine/data.js";
import { parseItemText, identifyMods } from "./engine/parse.js";
import { tierTables } from "./engine/pool.js";
import { ITEMS, LABELS } from "./samples.js";

const DATA_DIR = new URL("../data/", import.meta.url).href;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let db = null;
let current = null; // {item, rows:[{m, want, minModId, family}]}
let worker = null;
let reqId = 0;
const pending = new Map();

async function init() {
  try {
    db = await loadDb(async (path) => (await fetch(new URL(path, DATA_DIR))).json());
    $("meta").textContent = `Path of Exile 1 · game data ${db.version}`;
    const lg = db.manual?.league;
    if (lg) $("leagueNote").textContent = lg.crafts?.length
      ? `League mechanic (${lg.league} ${lg.mechanic}): ${lg.crafts.length} craft${lg.crafts.length > 1 ? "s" : ""} included, approximate.`
      : `League mechanic (${lg.league} ${lg.mechanic}): not modelled yet; its crafting rules haven't been checked.`;
    $("readBtn").disabled = false;
  } catch (e) {
    $("meta").textContent = "Couldn't load game data.";
    showMsg("parseMsg", "Couldn't load the game data file. Reload the page to try again.");
    return;
  }
  try {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (ev) => { const p = pending.get(ev.data.id); if (p) { pending.delete(ev.data.id); p(ev.data); } };
    worker.onerror = () => { worker = null; };
  } catch { worker = null; }
}

function showMsg(id, html, cls = "") {
  const el = $(id);
  el.className = "msg " + cls;
  el.innerHTML = html;
  el.hidden = !html;
}

function readItem() {
  const text = $("itemText").value;
  const item = parseItemText(db, text);
  $("resultPanel").hidden = true;
  if (item.errors?.length) {
    showMsg("parseMsg", item.errors.map(esc).join("<br>"));
    $("itemPanel").hidden = true;
    return;
  }
  showMsg("parseMsg", "");
  const ident = identifyMods(db, item);
  const { tierOf, families } = tierTables(db, item.base, item.influences);
  const rows = ident.mods.map((m) => {
    const info = tierOf.get(m.mod.id);
    return { m, want: !m.fractured, minModId: m.mod.id, family: info ? families.get(info.family) : null };
  });
  current = { item, rows, unknown: ident.unknown };
  renderItem();
}

function renderItem() {
  const { item, rows, unknown } = current;
  const flags = [...item.flags].filter((f) => ["corrupted", "mirrored", "synthesised", "split"].includes(f));
  $("itemHead").innerHTML = `
    <span class="name">${esc(item.rarity === "rare" ? item.name : item.base.name)}</span>
    <span class="tag">${esc(item.base.name)} · ${esc(db.classes[item.base.cls].name)} · item level ${item.ilvl} · ${esc(item.rarity)}</span>
    ${item.influences.length ? `<span class="infl">${item.influences.map(cap).join(" + ")} influence</span>` : ""}
    ${flags.length ? `<span class="infl">${flags.map(cap).join(", ")}</span>` : ""}
    ${eldritchText(item.eldritch)}`;
  $("ilvlInput").value = item.ilvl;
  const list = $("modList");
  list.innerHTML = "";
  if (!rows.length) list.innerHTML = `<p class="hint">No explicit mods found on this item.</p>`;
  rows.forEach((r, i) => {
    const el = document.createElement("div");
    el.className = "mod" + (r.want ? "" : " off");
    const m = r.m;
    let control;
    if (m.fractured) control = `<span class="fixed">Fractured on the base</span>`;
    else if (m.crafted) control = `<span class="fixed">Bench craft</span>`;
    else if (r.family && r.family.length > 1) {
      const opts = r.family.map((fm, k) => {
        const above = fm.l > item.ilvl ? ` (needs ilvl ${fm.l})` : "";
        return `<option value="${esc(fm.id)}" ${fm.id === r.minModId ? "selected" : ""}>T${k + 1} or better: ${esc(rangeText(fm))}${above}</option>`;
      }).join("");
      control = `<select data-i="${i}" aria-label="Minimum tier">${opts}</select>`;
    } else control = `<span class="fixed">${m.essenceOnly ? "Essence-only mod" : "Only tier"}</span>`;
    const tier = m.tier ? `T${m.tier} of ${m.tierCount}` : m.crafted ? "crafted" : m.essenceOnly ? "essence mod" : "";
    el.innerHTML = `
      <input type="checkbox" data-i="${i}" ${r.want ? "checked" : ""} ${m.fractured ? "disabled" : ""} aria-label="Want this mod">
      <span class="side ${m.side}">${m.side === "p" ? "PREFIX" : "SUFFIX"}</span>
      <span class="text">${esc(m.lines.join(" / "))}
        ${m.crafted ? `<span class="badge crafted">crafted</span>` : ""}${m.fractured ? `<span class="badge fractured">fractured</span>` : ""}${m.summed ? `<span class="badge summed" title="Ctrl+C adds up lines with the same stat. This line was split between two mods; Ctrl+Alt+C shows each one.">summed line</span>` : ""}
        <small>${esc(m.mod.n || "")}${tier ? " · " + tier : ""}</small></span>
      ${control}`;
    list.appendChild(el);
  });
  list.querySelectorAll("input[type=checkbox]").forEach((cb) => cb.addEventListener("change", () => {
    rows[+cb.dataset.i].want = cb.checked;
    cb.closest(".mod").classList.toggle("off", !cb.checked);
  }));
  list.querySelectorAll("select").forEach((sel) => sel.addEventListener("change", () => { rows[+sel.dataset.i].minModId = sel.value; }));
  if (unknown.length) showMsg("unknownMsg", `Couldn't identify: ${unknown.map((u) => `“${esc(u)}”`).join(", ")}. ${item.advanced ? "" : "Copying with Ctrl+Alt+C usually fixes this."} These lines are left out of the plan.`, "warn");
  else showMsg("unknownMsg", "");
  $("itemPanel").hidden = false;
  $("itemPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function eldritchText(el) {
  if (!el || (!el.exarch && !el.eater)) return "";
  const part = (name, x) => (x ? `${name} rank ${x.rank}` : null);
  const dom = el.dominant ? ` · ${el.dominant === "exarch" ? "Searing Exarch" : "Eater of Worlds"} dominant` : " · no dominance";
  return `<span class="infl">Eldritch: ${[part("Searing Exarch", el.exarch), part("Eater of Worlds", el.eater)].filter(Boolean).join(", ")}${dom}</span>`;
}

function rangeText(mod) {
  return mod.x.replace(/\n/g, " / ");
}
function cap(s) { return s[0].toUpperCase() + s.slice(1); }

async function findPlans() {
  const { item, rows } = current;
  const wanted = rows.filter((r) => r.want && !r.m.fractured).map((r) => ({ modId: r.m.mod.id, minModId: r.minModId }));
  const fixedIds = rows.filter((r) => r.m.fractured).map((r) => r.m.mod.id);
  if (!wanted.length) { showMsg("unknownMsg", "Tick at least one mod you want.", "warn"); return; }
  const ilvl = Math.max(1, Math.min(100, parseInt($("ilvlInput").value, 10) || item.ilvl));
  const req = { baseId: item.base.id, ilvl, influences: item.influences, wanted, fixedIds, trials: 20000, eldritch: item.eldritch ? { dominant: item.eldritch.dominant } : null };
  $("resultPanel").hidden = false;
  $("progress").hidden = false;
  $("methods").innerHTML = "";
  $("planSummary").innerHTML = "";
  $("planBtn").disabled = true;
  $("resultPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const plan = await runPlan(req);
    renderPlan(plan, ilvl);
  } catch (e) {
    $("planSummary").innerHTML = `<div class="msg">Something went wrong while simulating: ${esc(e.message || e)}</div>`;
  } finally {
    $("progress").hidden = true;
    $("planBtn").disabled = false;
  }
}

function runPlan(req) {
  if (worker) {
    return new Promise((resolve, reject) => {
      const id = ++reqId;
      pending.set(id, (res) => (res.ok ? resolve(res.plan) : reject(new Error(res.error))));
      worker.postMessage({ id, dataDir: DATA_DIR, req });
    });
  }
  // fallback: run on the main thread
  return new Promise((resolve) => setTimeout(async () => {
    const { runPlan: run } = await import("./engine/run.js");
    resolve(run(db, req));
  }, 30));
}

function pct(p) {
  if (p >= 0.1) return (p * 100).toFixed(1) + "%";
  if (p >= 0.001) return (p * 100).toFixed(2) + "%";
  return (p * 100).toPrecision(2) + "%";
}
function oneIn(p) {
  const n = 1 / p;
  if (n < 10) return n.toFixed(1);
  if (n < 1e4) return Math.round(n).toLocaleString();
  if (n < 1e6) return (n / 1e3).toFixed(1) + "k";
  return (n / 1e6).toFixed(1) + "M";
}

function renderPlan(plan, ilvl) {
  const parts = [];
  if (plan.benchTarget) parts.push(`<strong>${esc(plan.benchTarget.option.mod.x.replace(/\n/g, " / "))}</strong> will be bench crafted at the end, so the random part doesn't need to hit it.`);
  if (plan.extraBenchable.length) parts.push(`${plan.extraBenchable.map((m) => `“${esc(m.x)}”`).join(", ")} can be bench crafted too. Plans marked “+ multimod” craft two mods with “Can have up to 3 Crafted Modifiers”; the others roll it.`);
  const unveiled = plan.impossibleNaturally.filter((m) => m.d === "u"), normal = plan.impossibleNaturally.filter((m) => m.d !== "u");
  if (unveiled.length) parts.push(`${unveiled.map((m) => `“${esc(m.x)}”`).join(", ")} is an unveiled mod: only the Veiled Chaos Orb and Aisling plans (or a bench craft, if you have unlocked it) can give it.`);
  if (normal.length) parts.push(`${normal.map((m) => `“${esc(m.x)}”`).join(", ")} can't roll naturally on this base at item level ${ilvl}; only an essence (or a higher item level) can give it.`);
  if (ilvl < plan.minIlvl) parts.push(`Your item level (${ilvl}) is below ${plan.minIlvl}, which the chosen tiers need.`);
  parts.push(`Ranked by chance per try (two-stage methods by total tries). A method with lower odds can still be cheaper if its currency is cheap — for example Alterations versus Deafening Essences, or a metacraft that costs Divine Orbs on every try.`);
  $("planSummary").innerHTML = `<p class="summary">${parts.join(" ")}</p>`;
  const box = $("methods");
  box.innerHTML = "";
  plan.methods.forEach((m, i) => {
    const d = document.createElement("details");
    const realistic = m.p > 0 && m.p >= 1e-5;
    d.className = "method" + (i === 0 && m.p > 0 ? " best" : "") + (realistic ? "" : " unlikely");
    if (i === 0) d.open = true;
    const odds = m.kind === "recomb" && m.p > 0
      ? `<b>~${oneIn(m.p)} actions</b><small>${pct(m.pA)} and ${pct(m.pB)} per alteration · ${pct(m.pc)} per recombination · approximate</small>`
      : m.kind === "awakener" && m.p > 0
      ? `<b>~${oneIn(m.p)} orbs</b><small>${pct(m.pA)} and ${pct(m.pB)} per influenced exalt · ${pct(m.pRest)} per awakening${m.exact ? " · exact" : ""}</small>`
      : m.kind === "influenceExalt" && m.p > 0
      ? `<b>1 in ${oneIn(m.p)}</b><small>stage 1: ${pct(m.p1)} per try · ${pct(m.p2)} per influenced exalt${m.exact ? " · exact" : ""}</small>`
      : m.kind === "lock" && m.p > 0
      ? `<b>~${oneIn(m.p)} tries</b><small>stage 1: ${pct(m.p1)} per try · stage 2: ${pct(m.p2)} per try${m.approximate ? " · approximate" : m.exact ? " · exact" : ""}</small>`
      : m.kind === "altregal" && m.p > 0
      ? `<b>~${oneIn(m.p)} alterations</b><small>${pct(m.p1)} per alteration to start · ${pct(m.p2)} that regal + exalts finish it${m.exact ? " · exact" : ""}</small>`
      : m.p > 0
      ? `<b>1 in ${oneIn(m.p)}</b><small>${pct(m.p)} per try${m.n90 ? ` · ${m.n90.toLocaleString()} tries for 90%` : ""}${m.approximate ? " · approximate" : m.exact ? " · exact" : m.hits < 30 ? " · rough estimate" : ""}</small>`
      : m.exact
      ? `<b>Impossible</b><small>this method can't make the item</small>`
      : `<b>&lt; 1 in ${oneIn(m.upperBound)}</b><small>no hits in ${m.trials.toLocaleString()} simulated tries</small>`;
    const kind = {
      chaos: "Chaos spam", essence: "Essence", fossil: "Fossils", harvest: "Harvest reforge",
      altregal: m.eldritch ? "Alteration route with eldritch exalts" : m.block ? "Alteration route with a metacraft" : "Alteration route · cheap currency, many tries",
      influenceExalt: "Influenced Exalted Orb", veiledChaos: "Veiled Chaos Orb + unveil", recomb: "Advanced · Recombinator", aisling: "Aisling + unveil · two stages", awakener: "Awakener's Orb · two influences",
      lock: m.eldritch ? "Two stages · Eldritch Chaos rerolls one side" : m.harvestKeep ? "Two stages · Harvest rerolls one side" : "Metacraft · two stages, each stage-2 try needs a new lock craft",
    }[m.kind] + (m.multimod ? " · multimod" : "") + (m.approximate ? (m.kind === "recomb" ? " · approximate" : " · Harvest data is hand-written") : "");
    d.innerHTML = `
      <summary><span class="mname">${esc(m.name)}<span class="kind">${kind}${m.corrupt ? " · corrupted essence" : ""}</span></span><span class="odds">${odds}</span></summary>
      <ol class="steps">${m.steps.map((s) => `<li><b>${esc(s.title)}</b><span>${esc(s.detail)}</span></li>`).join("")}</ol>`;
    box.appendChild(d);
  });
  if (!plan.methods.some((m) => m.p > 0)) {
    box.insertAdjacentHTML("afterbegin", `<div class="msg warn">None of the covered methods can realistically make this exact item. Try relaxing tiers or unticking a mod. Items like this are usually made with Harvest, Eldritch or metacrafting, which are coming in a later version.</div>`);
  }
}

for (const key of Object.keys(ITEMS)) $("sampleSel").add(new Option(LABELS[key] || key, key));
$("readBtn").addEventListener("click", readItem);
$("planBtn").addEventListener("click", findPlans);
$("sampleSel").addEventListener("change", (e) => {
  if (!e.target.value) return;
  $("itemText").value = ITEMS[e.target.value];
  e.target.value = "";
  if (db) readItem();
});
$("itemText").addEventListener("paste", () => setTimeout(() => { if (db) readItem(); }, 0));
init();
