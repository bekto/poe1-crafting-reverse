import { loadDb } from "./engine/data.js";
import { parseItemText, identifyMods } from "./engine/parse.js";
import { tierTables, modFamilies, baseChoices } from "./engine/pool.js";
import { ITEMS, LABELS } from "./samples.js";
import { encodeShare, decodeShare } from "./engine/share.js";

const DATA_DIR = new URL("../data/", import.meta.url).href;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let db = null;
let prices = null; // public/data/prices.json, written by the hourly GitHub Action (optional)
let lastPlan = null;
let rankBy = localStorage.getItem("rankBy") || "cost";
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
    setupBuilder();
  } catch (e) {
    $("meta").textContent = "Couldn't load game data.";
    showMsg("parseMsg", "Couldn't load the game data file. Reload the page to try again.");
    return;
  }
  startWorker();
  await loadPrices();
  // a share link plans straight away, so the worker has to exist first
  openShared();
  window.addEventListener("hashchange", openShared);
}

function startWorker() {
  try {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (ev) => { const p = pending.get(ev.data.id); if (p) { pending.delete(ev.data.id); p(ev.data); } };
    // if the worker dies, fail what it was doing (instead of a spinner that never stops) and plan on the main thread
    worker.onerror = (e) => {
      worker = null;
      for (const [id, p] of pending) { pending.delete(id); p({ ok: false, error: e.message || "the background worker stopped" }); }
    };
  } catch { worker = null; }
}

async function loadPrices() {
  try {
    const r = await fetch(new URL("prices.json", DATA_DIR));
    if (!r.ok) throw new Error(r.status);
    prices = await r.json();
    $("meta").textContent += ` · prices: ${prices.league} (${prices.source}, ${prices.updated})`;
  } catch {
    prices = null;
    $("meta").textContent += " · no price data";
  }
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

// ---------------------------------------------------------------- shareable links
function openShared() {
  const r = decodeShare(db, location.hash);
  if (!r) return;
  if (r.error) { showMsg("parseMsg", esc(r.error), "warn"); return; }
  const { baseId, ilvl, influences, wanted, fixedIds } = r.state;
  const base = db.bases.find((b) => b.id === baseId);
  const { tierOf, families } = tierTables(db, base, influences);
  const row = (mod, extra) => {
    const info = tierOf.get(mod.id);
    const m = { mod, lines: [mod.x.replace(/\n/g, " / ")], side: mod.g, crafted: mod.d === "c", fractured: false, tier: info?.tier ?? null, tierCount: info?.of ?? null, essenceOnly: !!mod.e, unveiled: mod.d === "u", ...extra.m };
    return { m, want: !m.fractured, minModId: extra.minModId || mod.id, family: info ? families.get(info.family) : null };
  };
  const rows = [
    ...wanted.map((w) => row(db.modById.get(w.modId), { minModId: w.minModId, m: {} })),
    ...fixedIds.map((id) => row(db.modById.get(id), { m: { fractured: true } })),
  ];
  const item = { base, ilvl, influences, rarity: "rare", name: "Shared item", flags: new Set(), eldritch: null, advanced: false, built: true };
  current = { item, rows, unknown: [] };
  showMsg("parseMsg", "");
  renderItem();
  findPlans();
}

function shareState(req) {
  return { baseId: req.baseId, ilvl: req.ilvl, influences: req.influences, wanted: req.wanted.map((w) => ({ modId: w.modId, minModId: w.minModId })), fixedIds: req.fixedIds };
}

// ---------------------------------------------------------------- manual item builder
const INFLUENCE_NAMES = ["shaper", "elder", "crusader", "hunter", "redeemer", "warlord"];
const builder = { base: null, families: [], picked: [] }; // picked: [{family, fractured}]

function setupBuilder() {
  const choices = baseChoices(db);
  const byLabel = new Map(choices.map((c) => [c.label, c.base]));
  $("bBaseList").innerHTML = choices.map((c) => `<option value="${esc(c.label)}">`).join("");
  $("bInfl").insertAdjacentHTML("beforeend", INFLUENCE_NAMES.map((i) => `<label><input type="checkbox" value="${i}"> ${cap(i)}</label>`).join(""));
  const refreshMods = () => {
    const infl = [...$("bInfl").querySelectorAll("input:checked")].map((x) => x.value);
    builder.families = builder.base ? modFamilies(db, builder.base, infl) : [];
    $("bModList").innerHTML = builder.families.map((f) => `<option value="${esc(f.label)}">`).join("");
    $("bMod").disabled = !builder.base;
    // influence mods that no longer fit are dropped
    builder.picked = builder.picked.filter((p) => builder.families.some((f) => f.key === p.family.key));
    drawPicked();
  };
  $("bBase").addEventListener("change", () => {
    const b = byLabel.get($("bBase").value) || null;
    if (b !== builder.base) builder.picked = [];
    builder.base = b;
    $("bMsg").textContent = b ? "" : "Pick a base from the list.";
    refreshMods();
  });
  $("bInfl").addEventListener("change", (e) => {
    const on = [...$("bInfl").querySelectorAll("input:checked")];
    if (on.length > 2) e.target.checked = false;
    refreshMods();
  });
  $("bMod").addEventListener("change", () => {
    const f = builder.families.find((x) => x.label === $("bMod").value);
    if (!f) return;
    $("bMod").value = "";
    const sideCount = builder.picked.filter((p) => p.family.side === f.side).length;
    const groups = new Set(builder.picked.flatMap((p) => p.family.mods[0].gr));
    if (f.mods[0].gr.some((g) => groups.has(g))) { $("bMsg").textContent = "That mod's group is already on the item."; return; }
    if (sideCount >= (builder.base.cls === "Jewel" ? 2 : 3)) { $("bMsg").textContent = `No free ${f.side === "p" ? "prefix" : "suffix"} left.`; return; }
    builder.picked.push({ family: f, fractured: false });
    $("bMsg").textContent = "";
    drawPicked();
  });
  $("bUse").addEventListener("click", useBuiltItem);
}

function drawPicked() {
  const ul = $("bMods");
  ul.innerHTML = builder.picked.map((p, i) => `<li><span class="side ${p.family.side}">${p.family.side === "p" ? "PREFIX" : "SUFFIX"}</span>
    <span class="text">${esc(p.family.label.replace(/^(Prefix|Suffix) · /, ""))}</span>
    <label class="frac"><input type="checkbox" data-i="${i}" ${p.fractured ? "checked" : ""}> fractured</label>
    <button type="button" class="link" data-del="${i}" aria-label="Remove this mod">remove</button></li>`).join("");
  ul.querySelectorAll("input[type=checkbox]").forEach((cb) => cb.addEventListener("change", () => { builder.picked[+cb.dataset.i].fractured = cb.checked; }));
  ul.querySelectorAll("button[data-del]").forEach((b) => b.addEventListener("click", () => { builder.picked.splice(+b.dataset.del, 1); drawPicked(); }));
  $("bUse").disabled = !builder.base || !builder.picked.length;
}

function useBuiltItem() {
  const base = builder.base;
  if (!base) return;
  const ilvl = Math.max(1, Math.min(100, parseInt($("bIlvl").value, 10) || 84));
  const influences = [...$("bInfl").querySelectorAll("input:checked")].map((x) => x.value);
  const item = { base, ilvl, influences, rarity: "rare", name: "Your item", flags: new Set(), eldritch: null, advanced: false, built: true };
  const rows = builder.picked.map((p) => {
    const mod = p.family.mods[0];
    const m = {
      mod, lines: [mod.x.replace(/\n/g, " / ")], side: mod.g, crafted: false, fractured: p.fractured,
      tier: 1, tierCount: p.family.mods.length, essenceOnly: !!mod.e, unveiled: mod.d === "u",
    };
    return { m, want: !p.fractured, minModId: mod.id, family: p.family.mods.length > 1 ? p.family.mods : null };
  });
  current = { item, rows, unknown: [] };
  showMsg("parseMsg", "");
  $("resultPanel").hidden = true;
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
  const notes = (item.warnings || []).map(esc);
  if (notes.length) showMsg("parseMsg", notes.join("<br>"), "warn");
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
  const req = { baseId: item.base.id, ilvl, influences: item.influences, wanted, fixedIds, trials: 20000, prices, eldritch: item.eldritch ? { dominant: item.eldritch.dominant } : null };
  try { history.replaceState(null, "", encodeShare(shareState(req))); } catch { /* an id that can't go in a link */ }
  $("resultPanel").hidden = false;
  $("progress").hidden = false;
  $("methods").innerHTML = "";
  $("planSummary").innerHTML = "";
  $("planBtn").disabled = true;
  $("resultPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  const mine = current; // the item may change while this plan runs
  try {
    const plan = await runPlan(req);
    if (current === mine) renderPlan(plan, ilvl);
  } catch (e) {
    if (current === mine) $("planSummary").innerHTML = `<div class="msg">Something went wrong while working out the plans: ${esc(e.message || e)}</div>`;
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
  return new Promise((resolve, reject) => setTimeout(async () => {
    try {
      const { runPlan: run } = await import("./engine/run.js");
      resolve(run(db, req));
    } catch (e) { reject(e); }
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
  if (prices && rankBy !== "cost") parts.push("Ranked by chance, with approximate plans after the others.");
  parts.push(prices
    ? `Costs use ${esc(prices.league)} prices from ${esc(prices.source)} (${esc(prices.updated)}). Items without a price (Harvest lifeforce, Aisling, some fossils) are listed as unpriced, and those plans rank after fully priced ones.`
    : `There's no price data, so methods are ranked by chance per try (two-stage methods by total tries), with approximate plans (hand-written Harvest and recombinator data) after the others. A method with lower odds can still be cheaper if its currency is cheap.`);
  $("planSummary").innerHTML = `<p class="summary">${parts.join(" ")}</p>`;
  lastPlan = plan;
  $("rankBox").hidden = !prices;
  drawMethods();
}

function ranked(methods) {
  const list = [...methods];
  // by chance: plans that rest on hand-written, unverified data (Harvest, recombinators) come after the rest
  if (rankBy !== "cost" || !prices) return list.sort((a, b) => (a.approximate ? 1 : 0) - (b.approximate ? 1 : 0) || b.p - a.p);
  const key = (m) => (!m.cost || !(m.p > 0) ? [3, -m.p] : m.cost.unpriced.length ? [m.cost.chaos > 0 ? 1 : 2, m.cost.chaos] : [0, m.cost.chaos]);
  return list.sort((a, b) => { const ka = key(a), kb = key(b); return ka[0] - kb[0] || ka[1] - kb[1]; });
}

function costText(m) {
  if (!m.cost || !(m.p > 0)) return "";
  const c = m.cost;
  const main = c.chaos > 0 ? `≈ ${fmtNum(c.chaos)} chaos${c.divine !== null ? ` (${fmtNum(c.divine)} div)` : ""}` : "";
  const un = c.unpriced.length ? `${main ? " + " : ""}unpriced: ${c.unpriced.map(esc).join(", ")}` : "";
  return `<small class="cost">${main}${un}</small>`;
}

function fmtNum(n) {
  if (n >= 100) return Math.round(n).toLocaleString();
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function drawMethods() {
  const plan = lastPlan;
  if (!plan) return;
  const box = $("methods");
  box.innerHTML = "";
  ranked(plan.methods).forEach((m, i) => {
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
      <summary><span class="mname" data-best="${rankBy === "cost" && prices ? "Cheapest" : "Best chance"}">${esc(m.name)}<span class="kind">${kind}${m.corrupt ? " · corrupted essence" : ""}</span></span><span class="odds">${odds}${costText(m)}</span></summary>
      <ol class="steps">${m.steps.map((s) => `<li><b>${esc(s.title)}</b><span>${esc(s.detail)}</span></li>`).join("")}</ol>`;
    box.appendChild(d);
  });
  if (!plan.methods.some((m) => m.p > 0)) {
    box.insertAdjacentHTML("afterbegin", `<div class="msg warn">None of the covered methods can realistically make this exact item. Try relaxing tiers or unticking a mod.</div>`);
  }
}

for (const key of Object.keys(ITEMS)) $("sampleSel").add(new Option(LABELS[key] || key, key));
$("readBtn").addEventListener("click", readItem);
$("shareBtn").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(location.href); $("shareMsg").textContent = "Link copied."; }
  catch { $("shareMsg").textContent = "Copy the address bar to share this plan."; }
});
for (const r of document.querySelectorAll('input[name="rank"]')) {
  r.checked = r.value === rankBy;
  r.addEventListener("change", () => { rankBy = r.value; localStorage.setItem("rankBy", rankBy); drawMethods(); });
}
$("planBtn").addEventListener("click", findPlans);
$("sampleSel").addEventListener("change", (e) => {
  if (!e.target.value) return;
  $("itemText").value = ITEMS[e.target.value];
  e.target.value = "";
  if (db) readItem();
});
$("itemText").addEventListener("paste", () => setTimeout(() => { if (db) readItem(); }, 0));
init();
