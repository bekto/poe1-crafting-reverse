// Shareable links: the base, item level, influences and wanted mods in location.hash, as plain text.
//
//   #b=<base id>&i=<item level>&f=<influence>,<influence>&w=<mod id>[~<lowest acceptable tier id>],...&x=<fractured mod id>,...
//
// Only letters, digits and _ / . , ~ = & - are used: no escaping, which every static host allows in a fragment.
const SAFE = /^[A-Za-z0-9_/.\-]+$/;

/** state: {baseId, ilvl, influences, wanted: [{modId, minModId}], fixedIds} -> "#..." */
export function encodeShare(state) {
  const parts = [`b=${state.baseId}`, `i=${state.ilvl}`];
  if (state.influences?.length) parts.push(`f=${state.influences.join(",")}`);
  parts.push(`w=${state.wanted.map((w) => (w.minModId && w.minModId !== w.modId ? `${w.modId}~${w.minModId}` : w.modId)).join(",")}`);
  if (state.fixedIds?.length) parts.push(`x=${state.fixedIds.join(",")}`);
  for (const id of [state.baseId, ...state.wanted.flatMap((w) => [w.modId, w.minModId]), ...(state.fixedIds || [])]) {
    if (id && !SAFE.test(id)) throw new Error(`can't share id "${id}"`);
  }
  return "#" + parts.join("&");
}

/** "#..." -> {state} or {error}; ids are checked against the game data. */
export function decodeShare(db, hash) {
  const h = (hash || "").replace(/^#/, "");
  if (!h) return null;
  const kv = Object.fromEntries(h.split("&").map((p) => { const i = p.indexOf("="); return i < 0 ? [p, ""] : [p.slice(0, i), p.slice(i + 1)]; }));
  if (!kv.b || !kv.w) return null; // not a share link
  const base = db.bases.find((b) => b.id === kv.b);
  if (!base) return { error: `Unknown base in the link (${kv.b}); the game data may have changed.` };
  const ilvl = Math.max(1, Math.min(100, parseInt(kv.i, 10) || 84));
  const influences = (kv.f || "").split(",").filter(Boolean);
  const okInfl = Object.keys(db.classes[base.cls]?.influence || {});
  if (influences.some((f) => !okInfl.includes(f))) return { error: "Unknown influence in the link." };
  const wanted = [];
  for (const part of kv.w.split(",").filter(Boolean)) {
    const [modId, minModId = modId] = part.split("~");
    if (!db.modById.has(modId) || !db.modById.has(minModId)) return { error: `Unknown mod in the link (${modId}); the game data may have changed.` };
    wanted.push({ modId, minModId });
  }
  const fixedIds = (kv.x || "").split(",").filter(Boolean);
  if (fixedIds.some((id) => !db.modById.has(id))) return { error: "Unknown fractured mod in the link." };
  if (!wanted.length) return { error: "The link has no mods." };
  return { state: { baseId: base.id, ilvl, influences, wanted, fixedIds } };
}
