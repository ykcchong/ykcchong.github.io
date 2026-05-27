"use strict";
/* Entity-centric views: Position, Loci (region+genes merged), Disease.
   Relies on globals $, api, escapeHtml, fmtCell, renderGrid, switchTab from app.js. */

const MT_LEN = 16569;

// ---------- helpers ----------
function card(title, bodyHtml, opts = {}) {
  const sub = opts.sub ? `<span class="muted">${escapeHtml(opts.sub)}</span>` : "";
  const titleHtml = opts.titleHtml ? title : escapeHtml(title);
  const cls = "card" + (opts.wide ? " card-wide" : "");
  return `<div class="${cls}"><h3>${titleHtml} ${sub}</h3>${bodyHtml || '<p class="muted">—</p>'}</div>`;
}
function table(cols, rows) {
  if (!rows || !rows.length) return '<p class="muted">No rows.</p>';
  const head = cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const body = rows.map((r) =>
    "<tr>" + cols.map((c) => `<td>${fmtCell(r[c])}</td>`).join("") + "</tr>"
  ).join("");
  return `<div class="grid-wrap"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
function sortRefsByPmid(refs) {
  // References with a PMID come first, sorted by PMID DESC (most recent ID = newer entry).
  // References without a PMID retain their original order at the end.
  const withId = [], without = [];
  for (const r of (refs || [])) {
    const n = parseInt(r?.nlmid, 10);
    if (Number.isFinite(n)) withId.push({ r, n }); else without.push(r);
  }
  withId.sort((a, b) => b.n - a.n);
  return [...withId.map((x) => x.r), ...without];
}

function fmtRef(r) {
  const cite = [r.authors, r.title, r.publication, r.volume, r.pages, r.date]
    .filter(Boolean).join(", ");
  const link = r.nlmid
    ? ` <a href="https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(r.nlmid)}/" target="_blank">PMID</a>`
    : "";
  return `<li>${escapeHtml(cite)}${link}</li>`;
}

// Reduce noisy status text (e.g. "Reported - possibly synergistic; hg L1b marker")
// down to a canonical short label such as "Reported", "Reported [VUS]", "Cfrm [P]".
function shortStatus(status) {
  const s = String(status || "").trim();
  if (!s) return "";
  const tag = s.match(/\[(P|LP|VUS[*+-]?|LB|B)\]/i);
  if (/^Cfrm/i.test(s)) return tag ? `Cfrm [${tag[1].toUpperCase()}]` : "Cfrm";
  if (/^Conflict/i.test(s)) return "Conflicting";
  if (/^Unclear/i.test(s)) return "Unclear";
  if (/^Reported/i.test(s)) return tag ? `Reported [${tag[1].toUpperCase()}]` : "Reported";
  return tag ? `[${tag[1].toUpperCase()}]` : s.length > 24 ? "Other" : s;
}

// Pathogenicity classification bucket (for filtering). Unclear is grouped with "other".
function statusBucket(status) {
  const s = String(status || "").trim();
  if (!s) return "unknown";
  if (/\[P\]/i.test(s)) return /^Cfrm/i.test(s) ? "cfrm-p" : "p";
  if (/\[LP\]/i.test(s)) return /^Cfrm/i.test(s) ? "cfrm-lp" : "lp";
  if (/\[VUS/i.test(s)) return "vus";
  if (/\[LB\]/i.test(s)) return "lb";
  if (/\[B\]/i.test(s)) return "b";
  if (/^Conflict/i.test(s)) return "conflict";
  if (/^Cfrm/i.test(s)) return "cfrm";
  if (/^Reported/i.test(s)) return "reported";
  // "Unclear" and anything uncategorized share one bucket.
  return "other";
}
const STATUS_BUCKETS = [
  ["cfrm-p",  "Cfrm [P]"],
  ["cfrm-lp", "Cfrm [LP]"],
  ["p",       "[P]"],
  ["lp",      "[LP]"],
  ["vus",     "[VUS]"],
  ["lb",      "[LB]"],
  ["b",       "[B]"],
  ["cfrm",    "Cfrm"],
  ["reported","Reported"],
  ["conflict","Conflicting"],
  ["other",   "Unclear / Other"],
];

// Worst (most severe) pathogenicity bucket ordering (lower = more severe)
const BUCKET_RANK = {
  "cfrm-p": 0, "cfrm-lp": 1, "p": 2, "lp": 3,
  "cfrm": 4, "vus": 5, "reported": 6, "conflict": 7, "unclear": 7,
  "lb": 8, "b": 9, "other": 10, "unknown": 11,
};
const BUCKET_COLOR = {
  "cfrm-p":  "#dc2626",
  "cfrm-lp": "#f97316",
  "p":       "#ef4444",
  "lp":      "#fb923c",
  "cfrm":    "#fca5a5",
  "vus":     "#facc15",
  "reported":"#fde68a",
  "conflict":"#a5b4fc",
  "unclear": "#a5b4fc",
  "lb":      "#86efac",
  "b":       "#34d399",
  "other":   "#9ca3af",
  "unknown": "#cbd5e1",
};
function worstBucket(statusesStr) {
  if (!statusesStr) return null;
  const parts = String(statusesStr).split("|").filter(Boolean);
  if (!parts.length) return null;
  let best = null, bestRank = 99;
  for (const s of parts) {
    const b = statusBucket(s);
    const r = BUCKET_RANK[b] ?? 99;
    if (r < bestRank) { best = b; bestRank = r; }
  }
  return best;
}

// Pathogenicity status -> pill class
function statusPill(status, opts = {}) {
  const s = String(status || "").trim();
  if (!s) return "";
  let cls = "pill pill-rep";
  const conf = /^Cfrm/i.test(s);
  if (/\[P\]/i.test(s)) cls = conf ? "pill pill-cfrm-p" : "pill pill-p";
  else if (/\[LP\]/i.test(s)) cls = conf ? "pill pill-cfrm-lp" : "pill pill-lp";
  else if (/\[VUS\*\]|\[VUS\+\]|\[VUS-\]|\[VUS\]/i.test(s)) cls = "pill pill-vus";
  else if (/\[LB\]/i.test(s)) cls = "pill pill-lb";
  else if (/\[B\]/i.test(s)) cls = "pill pill-b";
  else if (/^Conflict|^Unclear/i.test(s)) cls = "pill pill-unclear";
  const label = opts.short ? shortStatus(s) : s;
  return `<span class="${cls}" title="${escapeHtml(s)}">${escapeHtml(label)}</span>`;
}

// MitoTIP quartile -> interpretation. Quartile values in the DB are "Q1".."Q4".
// Q1 = likely pathogenic, Q2 = possibly pathogenic, Q3 = possibly benign, Q4 = likely benign.
const MITOTIP_Q = {
  Q1: { short: "LP", full: "likely pathogenic" },
  Q2: { short: "PP", full: "possibly pathogenic" },
  Q3: { short: "PB", full: "possibly benign" },
  Q4: { short: "LB", full: "likely benign" },
};
function mitotipInterp(quartile) {
  const q = String(quartile || "").trim().toUpperCase();
  return MITOTIP_Q[q] || null;
}
const MITOTIP_NOTE = '<p class="muted mt-note">MitoTIP interpretation derived from quartile: Q1 = LP (likely pathogenic), Q2 = PP (possibly pathogenic), Q3 = PB (possibly benign), Q4 = LB (likely benign).</p>';

const LOCUS_TYPE_COLOR = {
  m: "#3b82f6", // mRNA / protein-coding - blue
  t: "#f59e0b", // tRNA - amber
  r: "#10b981", // rRNA - green
  n: "#a855f7", // non-coding / control region - purple
  mdp: "#6b7280", // mitochondrial-derived peptide - gray
};
const LOCUS_TYPE_LABEL = { m: "protein-coding", t: "tRNA", r: "rRNA", n: "non-coding / control", mdp: "derived peptide" };

// Short label used by the stage-2 locus map. Strips bracketed/parenthetical disambiguators so
// that, e.g., "L(UUA/G)" renders as "L" and "CR:mtTF1" renders as "mtTF1".
function locusShortLabel(L) {
  const cn = (L.common_name || "").trim();
  const fallback = (L.name || "").replace(/^MT-/, "");
  if (!cn || cn === "-") return fallback;
  // tRNAs: drop the codon family in parentheses → "L(UUA/G)" → "L"
  if ((L.type || "").toLowerCase() === "t") {
    const m = cn.match(/^([A-Za-z])/);
    return m ? m[1] : cn;
  }
  // Control-region features such as "CR:mtTF1" → "mtTF1"
  if (cn.includes(":")) return cn.split(":").pop();
  return cn;
}

// Render an allele change as a short label; treat ":" or "-" as deletion.
function fmtAllele(ref, alt) {
  const r = String(ref || "").trim();
  const a = String(alt || "").trim();
  if (!r && !a) return "";
  if (a === ":" || a === "-" || a === "" || a.toLowerCase() === "del") return `${r}del`;
  if (r === ":" || r === "-" || r === "") return `ins${a}`;
  return `${r}>${a}`;
}

// ---------- Loci cache ----------
let LOCI_CACHE = null;
let LOCI_PROMISE = null;
function loadLoci() {
  if (LOCI_CACHE) return Promise.resolve(LOCI_CACHE);
  if (!LOCI_PROMISE) LOCI_PROMISE = api("/api/lookup/loci").then((d) => (LOCI_CACHE = d));
  return LOCI_PROMISE;
}

// ---------- Genome bar (Stage 1: whole 16 kb mtDNA, click to jump, with a 2 kb spotlight) ----------
const ZOOM_HALF = 1000; // window half-width used by stage-2 locus track and stage-3 lollipops
function renderGenomeBar(currentPos, enclosingNames) {
  const bar = $("genomeBar");
  if (!bar) return;
  if (!LOCI_CACHE) { loadLoci().then(() => renderGenomeBar(currentPos, enclosingNames)); return; }
  const enclSet = new Set(enclosingNames || []);
  const w = 1000, h = 40;
  const x = (p) => (p / MT_LEN) * w;
  const segs = LOCI_CACHE.map((L) => {
    if (L.starting == null || L.ending == null) return "";
    const color = LOCUS_TYPE_COLOR[(L.type || "").toLowerCase()] || "#cbd5e1";
    const enc = enclSet.has(L.name);
    const opacity = enc ? 1.0 : 0.7;
    const x0 = x(L.starting), x1 = x(L.ending);
    return `<rect x="${x0.toFixed(2)}" y="10" width="${(x1 - x0).toFixed(2)}" height="18" fill="${color}" opacity="${opacity}"><title>${escapeHtml(L.name)} (${escapeHtml(L.common_name || "")}) — ${escapeHtml(L.product || "")} [${L.starting}-${L.ending}]</title></rect>`;
  }).join("");
  const markerX = x(currentPos);
  const winS = Math.max(1, currentPos - ZOOM_HALF);
  const winE = Math.min(MT_LEN, currentPos + ZOOM_HALF);
  const wx0 = x(winS), wx1 = x(winE);
  let ticks = "";
  for (let p = 0; p <= MT_LEN; p += 1000) {
    const xp = x(p);
    ticks += `<line x1="${xp}" y1="30" x2="${xp}" y2="34" stroke="#9ca3af" stroke-width="0.6"/>` +
             `<text x="${xp}" y="40" font-size="8" fill="#6b7280" text-anchor="middle">${p / 1000 ? (p / 1000) + "k" : "1"}</text>`;
  }
  bar.innerHTML = `
    <svg id="genomeBarSvg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}">
      <rect x="0" y="10" width="${w}" height="18" fill="#f3f4f6" />
      ${segs}
      ${ticks}
      <rect x="${wx0.toFixed(2)}" y="8" width="${(wx1 - wx0).toFixed(2)}" height="22" fill="none" stroke="#dc2626" stroke-width="1" stroke-dasharray="3 2" pointer-events="none"/>
      <line x1="${markerX}" y1="4" x2="${markerX}" y2="30" stroke="#dc2626" stroke-width="1.5" />
      <polygon points="${markerX - 4},4 ${markerX + 4},4 ${markerX},10" fill="#dc2626" />
    </svg>
    <div class="genome-legend">
      <span><i style="background:${LOCUS_TYPE_COLOR.m}"></i>protein</span>
      <span><i style="background:${LOCUS_TYPE_COLOR.t}"></i>tRNA</span>
      <span><i style="background:${LOCUS_TYPE_COLOR.r}"></i>rRNA</span>
      <span><i style="background:${LOCUS_TYPE_COLOR.n}"></i>control / non-coding</span>
      <span class="muted">red box = zoom window (±${ZOOM_HALF} bp) · click anywhere to jump</span>
    </div>`;
  document.getElementById("genomeBarSvg").addEventListener("click", (ev) => {
    const r = ev.currentTarget.getBoundingClientRect();
    const pos = Math.max(1, Math.min(MT_LEN, Math.round(((ev.clientX - r.left) / r.width) * MT_LEN)));
    $("posInput").value = pos;
    doPosition();
  });
}

let CHOSEN_LOCUS = null; // name of locus chosen from stage-2 locus map (drives stage-3 lollipop range)
let CHOSEN_LOCUS_RANGE = null; // {start, end, name} - persists across lollipop clicks inside this window
let LOLLIPOP_SHOW_LOW = false; // when true, also show Reported/B/LB/polymorphism below the zoom strip line

// ---------- Stage 2: Locus track over the 2 kb window around the position ----------
function renderLocusTrack(currentPos, enclosingNames) {
  const el = $("locusTrack");
  if (!el || !LOCI_CACHE) return;
  const winS = Math.max(1, currentPos - ZOOM_HALF);
  const winE = Math.min(MT_LEN, currentPos + ZOOM_HALF);
  const enclSet = new Set(enclosingNames || []);
  const items = LOCI_CACHE
    .filter((L) => L.starting != null && L.ending != null)
    .filter((L) => !(L.ending < winS || L.starting > winE))
    .slice().sort((a, b) => a.starting - b.starting);
  if (!items.length) { el.innerHTML = `<div class="muted" style="padding:6px 8px;font-size:11px">No annotated locus in this window.</div>`; return; }
  // Greedy lane packing of clipped intervals
  const lanes = [];
  const placed = items.map((L) => {
    const cs = Math.max(L.starting, winS), ce = Math.min(L.ending, winE);
    let lane = lanes.findIndex((endP) => endP < cs);
    if (lane === -1) { lane = lanes.length; lanes.push(ce); } else { lanes[lane] = ce; }
    return { L, lane, cs, ce };
  });
  const W = 1000;
  const rowH = 22;
  const H = lanes.length * rowH + 30;
  const x = (p) => ((p - winS) / (winE - winS)) * W;
  // header: position ticks + the position marker
  const step = (winE - winS) <= 500 ? 50 : (winE - winS) <= 2000 ? 200 : 500;
  let header = `<line x1="0" y1="14" x2="${W}" y2="14" stroke="#9ca3af" stroke-width="0.6"/>`;
  for (let p = Math.ceil(winS / step) * step; p <= winE; p += step) {
    const xp = x(p);
    header += `<line x1="${xp}" y1="10" x2="${xp}" y2="14" stroke="#9ca3af"/>` +
              `<text x="${xp}" y="9" font-size="9" fill="#6b7280" text-anchor="middle">${p}</text>`;
  }
  const mx = x(currentPos);
  header += `<line x1="${mx}" y1="2" x2="${mx}" y2="${H}" stroke="#dc2626" stroke-dasharray="2 2" stroke-width="1"/>`;
  const parts = placed.map(({ L, lane, cs, ce }, idx) => {
    const color = LOCUS_TYPE_COLOR[(L.type || "").toLowerCase()] || "#cbd5e1";
    const enc = enclSet.has(L.name);
    const chosen = CHOSEN_LOCUS === L.name;
    const x0 = x(cs), x1 = x(ce);
    const w = Math.max(2, x1 - x0);
    const y = 18 + lane * rowH;
    // Pick the most concise human-readable label for the bar.
    const labelText = locusShortLabel(L);
    const charW = 6.2, padPx = 4;
    const approxW = labelText.length * charW + padPx;
    const stroke = chosen ? `stroke="#dc2626" stroke-width="2"` : (enc ? `stroke="#111827" stroke-width="1.2"` : "");
    // Find the closest neighbor on the same lane to decide whether right/left labels collide.
    const sameLane = placed.filter((p, i) => i !== idx && p.lane === lane);
    const rightNeighbor = sameLane.filter((p) => p.cs >= ce).sort((a, b) => a.cs - b.cs)[0];
    const leftNeighbor  = sameLane.filter((p) => p.ce <= cs).sort((a, b) => b.ce - a.ce)[0];
    const rightFreePx = rightNeighbor ? (x(rightNeighbor.cs) - x1 - 2) : (W - x1 - 2);
    const leftFreePx  = leftNeighbor  ? (x0 - x(leftNeighbor.ce) - 2) : (x0 - 2);
    let label = "";
    if (w >= approxW) {
      // label inside the rect
      label = `<text x="${x0 + w / 2}" y="${y + 12}" font-size="11" fill="#fff" text-anchor="middle" font-weight="700" style="pointer-events:none">${escapeHtml(labelText)}</text>`;
    } else if (rightFreePx >= approxW) {
      // label to the right (only if no neighbor will overlap)
      label = `<text x="${x1 + 3}" y="${y + 12}" font-size="11" fill="#111827" text-anchor="start" style="pointer-events:none">${escapeHtml(labelText)}</text>`;
    } else if (leftFreePx >= approxW) {
      // label to the left
      label = `<text x="${x0 - 3}" y="${y + 12}" font-size="11" fill="#111827" text-anchor="end" style="pointer-events:none">${escapeHtml(labelText)}</text>`;
    } else {
      // No horizontal space: float label ABOVE the bar in a tiny font.
      label = `<text x="${x0 + w / 2}" y="${y - 1}" font-size="9" fill="#111827" text-anchor="middle" style="pointer-events:none">${escapeHtml(labelText)}</text>`;
    }
    // Indicate truncation if locus extends past window
    const lTrunc = L.starting < winS ? `<polygon points="${x0},${y + rowH/2 - 4} ${x0 - 4},${y + rowH/2} ${x0},${y + rowH/2 + 4}" fill="${color}"/>` : "";
    const rTrunc = L.ending   > winE ? `<polygon points="${x1},${y + rowH/2 - 4} ${x1 + 4},${y + rowH/2} ${x1},${y + rowH/2 + 4}" fill="${color}"/>` : "";
    return `<g class="loc-bar" data-name="${escapeHtml(L.name)}" data-s="${L.starting}" data-e="${L.ending}" style="cursor:pointer">
      ${lTrunc}${rTrunc}
      <rect x="${x0.toFixed(2)}" y="${y}" width="${w.toFixed(2)}" height="${rowH - 6}" rx="3" fill="${color}" ${stroke}><title>${escapeHtml(L.name)} (${escapeHtml(L.common_name || "")}) \u2014 ${escapeHtml(L.product || "")} [${L.starting}\u2013${L.ending}]</title></rect>
      ${label}
    </g>`;
  }).join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" width="100%" height="${H}">${header}${parts}</svg>`;
  el.querySelectorAll(".loc-bar").forEach((g) => g.addEventListener("click", () => {
    CHOSEN_LOCUS = g.dataset.name;
    const s = +g.dataset.s, e = +g.dataset.e;
    CHOSEN_LOCUS_RANGE = { start: s, end: e, name: g.dataset.name };
    renderLocusTrack(currentPos, enclosingNames); // re-render to update chosen highlight
    renderZoomStrip(currentPos, { start: s, end: e, locusName: g.dataset.name, exact: true });
  }));
}

// ---------- Zoom strip: lollipops, optionally over a whole locus +/- 20 bp ----------
async function renderZoomStrip(pos, opts) {
  const el = $("zoomStrip");
  if (!el) return;
  let s, e, label;
  if (opts && opts.start && opts.end) {
    const pad = opts.exact ? 0 : 20;
    s = Math.max(1, opts.start - pad);
    e = Math.min(MT_LEN, opts.end + pad);
    label = opts.locusName
      ? `<b>${escapeHtml(opts.locusName)}</b> (${opts.start}–${opts.end})`
      : `region ${opts.start}–${opts.end}`;
  } else {
    s = Math.max(1, pos - ZOOM_HALF);
    e = Math.min(MT_LEN, pos + ZOOM_HALF);
    label = `\u00b1${ZOOM_HALF} bp around position <b>${pos}</b>`;
  }
  const showLow = LOLLIPOP_SHOW_LOW;
  const toolbar = `<label class="opt zoom-opt"><input id="lpShowLow" type="checkbox" ${showLow ? "checked" : ""}/> also show Reported / B / LB / polymorphism (below the line)</label>`;
  el.innerHTML = `<div class="zoom-head">${label} <span class="muted">(${s}–${e}) · click a lollipop to jump</span> ${toolbar}</div><div class="zoom-svg-wrap"><p class="muted" style="padding:6px 8px">Loading…</p></div>`;
  const cb = el.querySelector("#lpShowLow");
  if (cb) cb.addEventListener("change", () => {
    LOLLIPOP_SHOW_LOW = cb.checked;
    renderZoomStrip(pos, opts);
  });
  let variants = [];
  try {
    // When showing below-line lollipops we need polymorphisms too (dz_only=0).
    const d = await api(`/api/lookup/region?start=${s}&end=${e}&variants_limit=20000&dz_only=${showLow ? 0 : 1}`);
    variants = d.variants || [];
  } catch (_) {}
  // Aggregate per position. "high" buckets go above the line, "low" below (when enabled).
  const HIGH = new Set(["cfrm-p", "cfrm-lp", "p", "lp", "vus"]);
  const LOW  = new Set(["lb", "b", "cfrm", "reported", "conflict", "other", "polymorphism"]);
  const TIER = { "cfrm-p": 3, "p": 3, "cfrm-lp": 2, "lp": 2, "vus": 1 };
  const byPosHigh = new Map(), byPosLow = new Map();
  const addAgg = (map, pos, bucket, alt) => {
    let agg = map.get(pos);
    if (!agg) { agg = { pos, n: 0, worst: null, alts: [] }; map.set(pos, agg); }
    agg.n += 1;
    if (alt) agg.alts.push(alt);
    const r = BUCKET_RANK[bucket] ?? 99;
    const cr = BUCKET_RANK[agg.worst] ?? 99;
    if (r < cr) agg.worst = bucket;
  };
  for (const v of variants) {
    const hasDz = (v.n_mmutation + v.n_rtmutation) > 0;
    if (hasDz) {
      const wb = worstBucket(v.dz_statuses);
      if (!wb) continue;
      if (HIGH.has(wb)) addAgg(byPosHigh, v.position, wb, fmtAllele(v.ref, v.alt));
      else if (showLow && LOW.has(wb)) addAgg(byPosLow, v.position, wb, fmtAllele(v.ref, v.alt));
    } else if (showLow) {
      // Pure polymorphism: tag as the synthetic "polymorphism" bucket.
      addAgg(byPosLow, v.position, "polymorphism", fmtAllele(v.ref, v.alt));
    }
  }
  // Vertical layout
  const w = 1000;
  const tierGap = 14; // px per tier
  const maxHigh = 3 * tierGap + 12; // room for P (tier 3) + a bit of count scaling
  const maxLow  = showLow ? 32 : 0;
  const baseY = 14 + maxHigh; // axis sits below high-side area
  const h = baseY + maxLow + 22;
  const n = e - s + 1;
  const x = (p) => ((p - s + 0.5) / n) * w;
  let backbone = `<line x1="0" y1="${baseY}" x2="${w}" y2="${baseY}" stroke="#9ca3af" stroke-width="1"/>`;
  const step = n <= 60 ? 5 : (n <= 200 ? 20 : (n <= 1000 ? 100 : 500));
  for (let p = Math.ceil(s / step) * step; p <= e; p += step) {
    const xp = x(p);
    backbone += `<line x1="${xp}" y1="${baseY}" x2="${xp}" y2="${baseY + 4}" stroke="#9ca3af"/>` +
      `<text x="${xp}" y="${baseY + 14}" font-size="9" fill="#6b7280" text-anchor="middle">${p}</text>`;
  }
  if (pos >= s && pos <= e) {
    const xp = x(pos);
    backbone += `<line x1="${xp}" y1="0" x2="${xp}" y2="${h - 2}" stroke="#dc2626" stroke-dasharray="2 2" stroke-width="1"/>` +
      `<text x="${xp}" y="${baseY - 2}" font-size="9" fill="#dc2626" text-anchor="middle" font-weight="700">${pos}</text>`;
  }
  const radius = (k) => Math.min(7, 3 + Math.log2(k + 1) * 1.5);
  // Above-line (high) lollipops — vertical position by tier (P=top, LP=middle, VUS=bottom).
  const highLp = [...byPosHigh.values()].map((a) => {
    const xp = x(a.pos);
    const color = BUCKET_COLOR[a.worst];
    const tier = TIER[a.worst] || 1;
    const y = baseY - (tier * tierGap) - Math.min(6, a.n);
    const r = radius(a.n);
    const title = `pos ${a.pos} — ${a.alts.join(" ")} — worst: ${a.worst}`;
    return `<g class="lp" data-pos="${a.pos}" style="cursor:pointer">
      <line x1="${xp}" y1="${baseY}" x2="${xp}" y2="${y}" stroke="${color}" stroke-width="1.5"/>
      <circle cx="${xp}" cy="${y}" r="${r}" fill="${color}" stroke="#fff" stroke-width="0.8"><title>${escapeHtml(title)}</title></circle>
    </g>`;
  }).join("");
  // Below-line (low) lollipops — single tier, fixed depth + count radius.
  const lowLp = showLow ? [...byPosLow.values()].map((a) => {
    const xp = x(a.pos);
    const color = a.worst === "polymorphism" ? "#9ca3af" : (BUCKET_COLOR[a.worst] || "#9ca3af");
    const r = radius(a.n);
    const y = baseY + Math.min(maxLow - 2, 10 + Math.min(12, a.n));
    const title = `pos ${a.pos} — ${a.alts.join(" ")} — ${a.worst}`;
    return `<g class="lp" data-pos="${a.pos}" style="cursor:pointer">
      <line x1="${xp}" y1="${baseY}" x2="${xp}" y2="${y}" stroke="${color}" stroke-width="1.2" opacity="0.75"/>
      <circle cx="${xp}" cy="${y}" r="${r}" fill="${color}" fill-opacity="0.85" stroke="#fff" stroke-width="0.8"><title>${escapeHtml(title)}</title></circle>
    </g>`;
  }).join("") : "";
  const legendItems = [["cfrm-p","Cfrm [P]"],["cfrm-lp","Cfrm [LP]"],["p","[P]"],["lp","[LP]"],["vus","[VUS]"]];
  if (showLow) legendItems.push(["reported","Reported"], ["lb","[LB]"], ["b","[B]"], ["polymorphism","poly"]);
  const legend = `<div class="zoom-legend">
    ${legendItems.map(([k, lbl]) => `<span><i style="background:${k === "polymorphism" ? "#9ca3af" : BUCKET_COLOR[k]}"></i>${lbl}</span>`).join("")}
    <span class="muted">${showLow ? "above = pathogenic tiers (P/LP/VUS), below = lower-evidence / polymorphism" : "tiers: P (top) · LP (middle) · VUS (bottom)"}</span>
  </div>`;
  el.querySelector(".zoom-svg-wrap").innerHTML =
    `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}">${backbone}${highLp}${lowLp}</svg>${legend}`;
  el.querySelectorAll(".lp").forEach((g) => g.addEventListener("click", () => {
    const newPos = parseInt(g.dataset.pos, 10);
    $("posInput").value = newPos;
    $("posRef").value = "";
    $("posAlt").value = "";
    // Re-render Stage 3 to move the dashed marker, then refresh detail cards only.
    // Do NOT call doPosition (that would re-render Stage 1 and Stage 2).
    renderZoomStrip(newPos, opts || (CHOSEN_LOCUS_RANGE ? { start: CHOSEN_LOCUS_RANGE.start, end: CHOSEN_LOCUS_RANGE.end, locusName: CHOSEN_LOCUS_RANGE.name, exact: true } : undefined));
    refreshPositionDetail(newPos);
  }));
}

// Refresh only the position detail cards (no Stage 1 / Stage 2 re-render).
async function refreshPositionDetail(pos) {
  const out = $("posOut");
  if (!out) return;
  out.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const d = await api(`/api/lookup/position?pos=${pos}`);
    renderPositionDetail(pos, d);
  } catch (e) {
    out.innerHTML = `<p class="err">${escapeHtml(e.message)}</p>`;
  }
}

// ---------- Position ----------
async function doPosition() {
  const pos = parseInt($("posInput").value, 10);
  const ref = $("posRef").value.trim().toUpperCase() || null;
  const alt = $("posAlt").value.trim().toUpperCase() || null;
  if (!pos) return;
  await loadLoci();
  const out = $("posOut");
  out.innerHTML = '<p class="muted">Loading…</p>';
  const qs = new URLSearchParams({ pos });
  if (ref) qs.set("ref", ref);
  if (alt) qs.set("alt", alt);
  let d;
  try { d = await api(`/api/lookup/position?${qs}`); }
  catch (e) { out.innerHTML = `<p class="err">${escapeHtml(e.message)}</p>`; return; }

  renderGenomeBar(pos, d.loci.map((l) => l.name));
  // Preserve chosen locus window across lollipop clicks within it.
  const insideChosen = CHOSEN_LOCUS_RANGE && pos >= CHOSEN_LOCUS_RANGE.start && pos <= CHOSEN_LOCUS_RANGE.end;
  if (!insideChosen) { CHOSEN_LOCUS = null; CHOSEN_LOCUS_RANGE = null; }
  renderLocusTrack(pos, d.loci.map((l) => l.name));
  if (insideChosen) {
    renderZoomStrip(pos, { start: CHOSEN_LOCUS_RANGE.start, end: CHOSEN_LOCUS_RANGE.end, locusName: CHOSEN_LOCUS_RANGE.name, exact: true });
  } else {
    renderZoomStrip(pos);
  }
  renderPositionDetail(pos, d, { ref, alt });
}

function renderPositionDetail(pos, d, opts = {}) {
  const out = $("posOut");
  if (!out) return;
  out.innerHTML = buildPositionCards(pos, d, opts);
}

// Build the position-detail card HTML (Variants & disease, predictions, AF, counts,
// unpublished, haplogroups). Reused by the Disease tab so picking a mutation there
// shows the same panes as Position — minus the stage 1-3 genome graphs.
function buildPositionCards(pos, d, opts = {}) {
  const ref = opts.ref || null;
  const alt = opts.alt || null;
  const includePositionCard = opts.includePositionCard !== false;
  const onlyAllele = !!opts.onlyAllele && ref && alt;
  const loci = d.loci.map((l) =>
    `<li><b>${escapeHtml(l.name)}</b> <span class="muted">(${escapeHtml(l.common_name || "")})</span> — ${escapeHtml(l.product || "")} <span class="muted">[${l.starting}–${l.ending} ${escapeHtml(l.strand || "")}] · ${escapeHtml(LOCUS_TYPE_LABEL[(l.type || "").toLowerCase()] || l.type || "")}</span></li>`
  ).join("") || '<li class="muted">intergenic</li>';
  const codonsHtml = d.codons && d.codons.length
    ? table(["genename", "geneid", "codon", "codonpos"], d.codons)
    : '<p class="muted">No codon mapping (non-coding position).</p>';
  const posBody = `<ul class="bare">${loci}</ul><h4 class="sub-h">Codons</h4>${codonsHtml}`;

  // -------- Merged: variants + disease (polymorphism ∪ mmutation ∪ rtmutation) --------
  const variantMap = new Map(); // key = ref>alt
  const vkey = (r, a) => `${r || ""}>${a || ""}`;
  const vget = (r, a) => {
    const k = vkey(r, a);
    let v = variantMap.get(k);
    if (!v) { v = { ref: r, alt: a, aachange: null, srcs: new Set(), dz: [] }; variantMap.set(k, v); }
    return v;
  };
  for (const p of (d.polymorphism || [])) {
    const v = vget(p.ref, p.alt);
    v.aachange = v.aachange || p.aachange;
    v.srcs.add("poly");
  }
  for (const m of (d.mmutation || [])) {
    const v = vget(m.ref, m.alt);
    v.aachange = v.aachange || m.aa;
    v.srcs.add("coding");
    v.dz.push({ src: "coding", dz: m.dz, status: m.status, locus: m.locus, refs: m.references || [], extra: `aa ${m.aa || "·"} · homo ${m.homo ?? "?"} · het ${m.hetero ?? "?"}`, cfrm_date: m.cfrm_date });
  }
  for (const m of (d.rtmutation || [])) {
    const v = vget(m.ref, m.alt);
    v.srcs.add("RNA");
    v.dz.push({ src: "RNA", dz: m.dz, status: m.status, locus: m.locus, refs: m.references || [], extra: `rna ${m.rna || "·"} · homo ${m.homo ?? "?"} · het ${m.hetero ?? "?"}`, cfrm_date: m.cfrm_date });
  }
  const variantRows = [...variantMap.values()]
    .filter((v) => !onlyAllele || (v.ref === ref && v.alt === alt));
  const srcTag = (s) => {
    if (s === "poly") return `<span class="src-tag src-p">poly</span>`;
    if (s === "coding") return `<span class="src-tag src-c">coding</span>`;
    return `<span class="src-tag src-r">RNA</span>`;
  };
  const vdHtml = variantRows.length ? variantRows.map((v) => {
    const dzInner = v.dz.length ? v.dz.map((x) =>
      `<div class="dz-entry">${srcTag(x.src === "coding" ? "coding" : "RNA")} <b>${escapeHtml(x.dz || "")}</b> ${statusPill(x.status, { short: true })} <span class="muted">${escapeHtml(x.status || "")}</span><div class="muted dz-extra">${escapeHtml(x.locus || "")} · ${escapeHtml(x.extra)} · cfrm ${escapeHtml(x.cfrm_date || "—")}</div>${x.refs.length ? `<details class="refs-exp"><summary>${x.refs.length} reference${x.refs.length === 1 ? "" : "s"}</summary><ul class="refs">${sortRefsByPmid(x.refs).map(fmtRef).join("")}</ul></details>` : ""}</div>`
    ).join("") : '<p class="muted" style="margin:4px 0">No disease association.</p>';
    const tags = [...v.srcs].map(srcTag).join(" ");
    return `<details ${v.dz.length ? "open" : ""} class="var-row"><summary><b>${escapeHtml(fmtAllele(v.ref, v.alt))}</b> ${tags} <span class="muted">${escapeHtml(v.aachange || "")}</span> ${v.dz.length ? `<span class="dz-count">${v.dz.length} dz</span>` : ""}</summary><div class="var-body">${dzInner}</div></details>`;
  }).join("") : '<p class="muted">No known variants at this position.</p>';

  // -------- Merged predictions (APOGEE + MitoTIP) --------
  const predMap = new Map();
  const pget = (r, a) => {
    const k = vkey(r, a);
    let v = predMap.get(k);
    if (!v) { v = { ref: r, alt: a }; predMap.set(k, v); }
    return v;
  };
  for (const x of (d.apogee || [])) { const p = pget(x.ref, x.alt); p.apogee_score = x.score; p.apogee_status = x.status; }
  for (const x of (d.mitotip || [])) { const p = pget(x.ref, x.alt); p.mitotip_score = x.mitotip_score; p.mitotip_quartile = x.quartile; p.mitotip_status = x.mitomap_status; }
  const predRows = [...predMap.values()];
  // Derive MitoTIP interpretation from quartile (Q1=LP, Q2=PP, Q3=PB, Q4=LB).
  for (const p of predRows) {
    if (p.mitotip_quartile) {
      const it = mitotipInterp(p.mitotip_quartile);
      p.mitotip_interp = it ? `${p.mitotip_quartile} (${it.short})` : p.mitotip_quartile;
    }
  }
  const predHasApo = predRows.some((p) => p.apogee_score != null || p.apogee_status);
  const predHasMtt = predRows.some((p) => p.mitotip_score != null || p.mitotip_quartile || p.mitotip_status);
  const predCols = ["ref", "alt"];
  if (predHasApo) predCols.push("apogee_score", "apogee_status");
  if (predHasMtt) predCols.push("mitotip_score", "mitotip_interp");
  const predHtml = predRows.length
    ? table(predCols, predRows) + (predHasMtt ? MITOTIP_NOTE : "")
    : '<p class="muted">No prediction available (APOGEE = protein-coding only, MitoTIP = tRNA only).</p>';

  // -------- Pivot allele frequencies (alt as columns) --------
  const freqHtml = buildFreqPivot(d.gnomad || [], d.helix || []);
  const freqAltCount = new Set([...(d.gnomad || []), ...(d.helix || [])].map((r) => `${r.ref}>${r.alt}`)).size;

  const hap = (src) => {
    const top = (d.haplogroup_counts[src].top || []).slice(0, 10);
    if (!top.length) return '<p class="muted">—</p>';
    return `<p>total <b>${d.haplogroup_counts[src].total.toLocaleString()}</b></p>` +
      `<ul class="haps">${top.map(h => `<li>${escapeHtml(h.haplogroup || "(none)")} <span class="count">${h.cnt.toLocaleString()}</span></li>`).join("")}</ul>`;
  };
  const hapCombinedHtml = `<div class="hap-grid">
    <div><h4 class="sub-h">GenBank (full-length)</h4>${hap("genbank")}</div>
    <div><h4 class="sub-h">Control region</h4>${hap("gbcontrol")}</div>
  </div>`;

  // -------- Unpublished submissions at this position --------
  const unpub = d.unpublished || [];
  let unpubHtml = '<p class="muted">No unpublished submissions on file at this position.</p>';
  if (unpub.length) {
    const fields = [
      ["allele",   (u) => fmtAllele(u.refna, u.regna)],
      ["locus",    (u) => u.locus],
      ["aa",       (u) => u.aa],
      ["patient",  (u) => u.patient],
      ["tissue",   (u) => u.tissue],
      ["haplogroup", (u) => u.haplogroup],
      ["heteroplasmic", (u) => u.heteroplasmic],
      ["method",   (u) => u.method],
      ["sample_id", (u) => u.sample_id],
      ["ethnicity", (u) => u.ethnicity],
      ["origin",   (u) => u.origin],
      ["note",     (u) => u.note],
    ];
    unpubHtml = unpub.map((u, idx) => {
      const rows = fields.map(([k, get]) => {
        const v = get(u);
        if (v == null || v === "" || v === "-") return "";
        return `<tr><th>${k}</th><td>${escapeHtml(String(v))}</td></tr>`;
      }).filter(Boolean).join("");
      return `<details ${idx === 0 ? "open" : ""} class="unpub-rec"><summary>#${idx + 1} · ${escapeHtml(u.locus || "")} ${escapeHtml(fmtAllele(u.refna, u.regna))}${u.patient && u.patient !== "-" ? " · " + escapeHtml(u.patient) : ""}</summary><table class="kv">${rows}</table></details>`;
    }).join("");
  }

  const cards = [
    card(`Variants & disease — ${variantRows.length}`, vdHtml),
    card("Pathogenicity predictions", predHtml),
    card(`Population allele frequencies`, freqHtml, { wide: freqAltCount > 3 }),
    card("Variant counts (this site)", table(["ref", "alt", "ntchange", "fl_count", "cr_count"], d.variants_count)),
    card(`Unpublished submissions${unpub.length ? ` — ${unpub.length}` : ""}`, unpubHtml),
    card("Haplogroup distribution (top 10)", hapCombinedHtml, { wide: true }),
  ];
  if (includePositionCard) {
    cards.unshift(card("Position " + pos, posBody, { sub: `${ref || "*"}>${alt || "*"}` }));
  }
  return cards.join("");
}

// AF pivot: rows = metrics, columns = ref>alt across both sources
function buildFreqPivot(gnomad, helix) {
  const alts = new Set();
  for (const g of gnomad) alts.add(`${g.ref || ""}>${g.alt || ""}`);
  for (const h of helix) alts.add(`${h.ref || ""}>${h.alt || ""}`);
  if (alts.size === 0) return '<p class="muted">No population allele frequency at this position.</p>';
  const altList = [...alts].sort();
  const altKey = (k) => { const [r, a] = k.split(">"); return fmtAllele(r, a); };
  const gmap = new Map(gnomad.map((g) => [`${g.ref}>${g.alt}`, g]));
  const hmap = new Map(helix.map((h) => [`${h.ref}>${h.alt}`, h]));
  const pct = (x, dp = 3) => (x == null ? "" : `${(+x * 100).toFixed(dp)}%`);
  const intf = (x) => (x == null ? "" : (+x).toLocaleString());
  const afFrac = (af, ac, an) => {
    if (af == null && ac == null && an == null) return "";
    const left = af == null ? "—" : pct(af);
    const ratio = (ac != null || an != null) ? ` <span class="muted">(${ac != null ? intf(ac) : "?"}/${an != null ? intf(an) : "?"})</span>` : "";
    return `<span class="num">${left}</span>${ratio}`;
  };
  const hxFrac = (af, ct) => {
    if (af == null && ct == null) return "";
    const left = af == null ? "—" : pct(af);
    const c = ct != null ? ` <span class="muted">(${intf(ct)})</span>` : "";
    return `<span class="num">${left}</span>${c}`;
  };
  const rows = [
    { label: "gnomAD het AF", get: (k) => { const g = gmap.get(k); return g ? afFrac(g.af_het, g.ac_het, g.an) : ""; } },
    { label: "gnomAD hom AF", get: (k) => { const g = gmap.get(k); return g ? afFrac(g.af_hom, g.ac_hom, g.an) : ""; } },
    { label: "gnomAD filters", get: (k) => {
        const f = String(gmap.get(k)?.filters ?? "").trim();
        if (!f || /^PASS$/i.test(f)) return "";
        return escapeHtml(f);
      } },
    { label: "Helix het AF", get: (k) => { const h = hmap.get(k); return h ? hxFrac(h.af_het, h.counts_het) : ""; } },
    { label: "Helix hom AF", get: (k) => { const h = hmap.get(k); return h ? hxFrac(h.af_hom, h.counts_hom) : ""; } },
    { label: "Helix mean heteroplasmy", get: (k) => { const v = hmap.get(k)?.mean_arf; return v == null ? "" : `<span class="num">${pct(v, 2)}</span>`; } },
    { label: "Helix max heteroplasmy",  get: (k) => { const v = hmap.get(k)?.max_arf;  return v == null ? "" : `<span class="num">${pct(v, 2)}</span>`; } },
  ];
  // Drop rows that are entirely empty
  const liveRows = rows.filter((r) => altList.some((k) => r.get(k) !== ""));
  const head = `<tr><th>metric</th>${altList.map((k) => `<th>${escapeHtml(altKey(k))}</th>`).join("")}</tr>`;
  const body = liveRows.map((r) => `<tr><th class="row-h">${escapeHtml(r.label)}</th>${altList.map((k) => `<td class="num">${r.get(k)}</td>`).join("")}</tr>`).join("");
  return `<div class="grid-wrap"><table class="grid freq-pivot"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

async function navNeighbor(direction) {
  const cur = parseInt($("posInput").value, 10);
  if (!cur) return;
  try {
    const d = await api(`/api/lookup/position/neighbors?pos=${cur}`);
    const target = direction === "prev" ? d.prev : d.next;
    if (target) { $("posInput").value = target; doPosition(); }
  } catch (_) {}
}

// ---------- Loci tab (merged Region + Genes) ----------
let SELECTED_LOCUS = null;

function parseLocusSearch(q) {
  const m = (q || "").trim().match(/^(\d{1,5})\s*(?:-|\.\.| )\s*(\d{1,5})$/);
  if (m) return { range: [parseInt(m[1], 10), parseInt(m[2], 10)] };
  return { text: (q || "").trim().toLowerCase() };
}

async function renderLocusList() {
  await loadLoci();
  const q = parseLocusSearch($("locusSearch").value);
  const onlyDz = $("locusOnlyDz") ? $("locusOnlyDz").checked : false;
  const ul = $("locusList");
  let rows = LOCI_CACHE;
  if (onlyDz) {
    rows = rows.filter((L) => (L.n_mmutation + L.n_rtmutation) > 0);
  }
  if (q.text) {
    rows = rows.filter((L) =>
      (L.name || "").toLowerCase().includes(q.text) ||
      (L.common_name || "").toLowerCase().includes(q.text) ||
      (L.product || "").toLowerCase().includes(q.text) ||
      (L.type_label || "").toLowerCase().includes(q.text) ||
      (LOCUS_TYPE_LABEL[(L.type || "").toLowerCase()] || "").toLowerCase().includes(q.text));
  }
  if (q.range) {
    const [a, b] = q.range;
    const s = Math.min(a, b), e = Math.max(a, b);
    rows = rows.filter((L) => !(L.ending < s || L.starting > e));
  }
  ul.innerHTML = rows.map((L) => {
    const color = LOCUS_TYPE_COLOR[(L.type || "").toLowerCase()] || "#cbd5e1";
    const active = SELECTED_LOCUS && SELECTED_LOCUS.name === L.name ? " active" : "";
    return `<div class="list-row${active}" data-name="${escapeHtml(L.name)}">
      <span class="type-dot" style="background:${color}" title="${escapeHtml(LOCUS_TYPE_LABEL[(L.type || "").toLowerCase()] || L.type || "")}"></span>
      <span class="lr-main"><b>${escapeHtml(L.name)}</b> <span class="muted">${escapeHtml(L.common_name || "")}</span><br><span class="muted">${escapeHtml(L.product || "")}</span></span>
      <span class="lr-meta">${L.starting}–${L.ending}<br><span class="muted">${L.n_variants} v · ${L.n_mmutation + L.n_rtmutation} dz</span></span>
    </div>`;
  }).join("") || '<p class="muted" style="padding:12px">No matching locus.</p>';
  if (q.range && rows.length) {
    ul.insertAdjacentHTML("afterbegin",
      `<div class="list-row range-row" data-range="${Math.min(q.range[0], q.range[1])},${Math.max(q.range[0], q.range[1])}">
        <span class="type-dot" style="background:#dc2626"></span>
        <span class="lr-main"><b>Range ${Math.min(q.range[0], q.range[1])}–${Math.max(q.range[0], q.range[1])}</b><br><span class="muted">show all variants in this span</span></span>
        <span class="lr-meta">${Math.abs(q.range[1] - q.range[0]) + 1} bp</span>
      </div>`);
  }
  ul.querySelectorAll(".list-row").forEach((row) => {
    row.addEventListener("click", () => {
      if (row.dataset.range) {
        const [s, e] = row.dataset.range.split(",").map(Number);
        SELECTED_LOCUS = null;
        loadRegion({ start: s, end: e });
      } else {
        SELECTED_LOCUS = LOCI_CACHE.find((L) => L.name === row.dataset.name) || null;
        loadRegion({ locus: row.dataset.name });
      }
      ul.querySelectorAll(".list-row").forEach((r) => r.classList.remove("active"));
      row.classList.add("active");
    });
  });
}

async function loadRegion(args) {
  const qs = new URLSearchParams();
  if (args.locus) qs.set("locus", args.locus);
  if (args.start) qs.set("start", args.start);
  if (args.end) qs.set("end", args.end);
  const onlyDz = !!args.dz_only;
  if (onlyDz) { qs.set("dz_only", "1"); qs.set("variants_limit", "20000"); }
  const out = $("regOut");
  out.innerHTML = '<p class="muted" style="padding:12px">Loading…</p>';
  let d;
  try { d = await api(`/api/lookup/region?${qs}`); }
  catch (e) { out.innerHTML = `<p class="err" style="padding:12px">${escapeHtml(e.message)}</p>`; return; }

  const head = d.locus
    ? `<p><b>${escapeHtml(d.locus.name)}</b> (${escapeHtml(d.locus.common_name || "")}) — ${escapeHtml(d.locus.product || "")} · strand ${escapeHtml(d.locus.strand || "")} · ${escapeHtml(LOCUS_TYPE_LABEL[(d.locus.type || "").toLowerCase()] || d.locus.type || "")} · ${d.start}–${d.end} (${d.length} bp)</p>`
    : `<p><b>Range ${d.start}–${d.end}</b> (${d.length} bp)</p>`;

  const overlap = d.overlap_loci.filter((l) => !d.locus || l.name !== d.locus.name).map((l) =>
    `<li><b>${escapeHtml(l.name)}</b> ${escapeHtml(l.common_name || "")} ${escapeHtml(l.product || "")} [${l.starting}–${l.ending}]</li>`
  ).join("");

  const variants = d.variants || [];
  // Backend already applies dz_only when requested; no further client-side filtering needed.
  const shown = variants;
  const hasApo = shown.some((v) => v.apogee_score != null || v.apogee_status);
  const hasMtt = shown.some((v) => v.mitotip_score != null || v.mitotip_quartile || v.mitotip_mitomap_status);
  const hasGnh = shown.some((v) => v.gnomad_af_hom != null || v.gnomad_af_het != null);
  const hasHxh = shown.some((v) => v.helix_af_hom != null || v.helix_af_het != null);
  const hasDz  = shown.some((v) => (v.n_mmutation + v.n_rtmutation) > 0);
  const pct = (x, dp = 3) => (x == null ? "" : `${(+x * 100).toFixed(dp)}%`);
  const intf = (x) => (x == null ? "?" : (+x).toLocaleString());
  const gnCell = (v) => {
    if (v.gnomad_af_hom == null && v.gnomad_af_het == null) return "";
    const an = v.gnomad_an;
    const hom = v.gnomad_af_hom != null ? `<span title="homoplasmic">hom ${pct(v.gnomad_af_hom)}</span> <span class="muted">(${intf(v.gnomad_ac_hom)}/${intf(an)})</span>` : "";
    const het = v.gnomad_af_het != null ? `<span title="heteroplasmic">het ${pct(v.gnomad_af_het)}</span> <span class="muted">(${intf(v.gnomad_ac_het)}/${intf(an)})</span>` : "";
    return [hom, het].filter(Boolean).join("<br>");
  };
  const hxCell = (v) => {
    const hom = v.helix_af_hom != null ? `hom ${pct(v.helix_af_hom)}` : "";
    const het = v.helix_af_het != null ? `het ${pct(v.helix_af_het)}` : "";
    return [hom, het].filter(Boolean).join("<br>");
  };
  const variantRows = shown.map((v) => {
    const apo = v.apogee_status || (v.apogee_score != null ? (+v.apogee_score).toFixed(2) : "");
    const mttIt = v.mitotip_quartile ? mitotipInterp(v.mitotip_quartile) : null;
    const mttScore = v.mitotip_score != null ? (+v.mitotip_score).toFixed(1) : "";
    const mtt = mttIt
      ? (mttScore ? `${mttScore} (${mttIt.short})` : `${v.mitotip_quartile} (${mttIt.short})`)
      : mttScore;
    const dzN = (v.n_mmutation + v.n_rtmutation) || 0;
    const dzStatList = v.dz_statuses ? [...new Set(v.dz_statuses.split("|").filter(Boolean))] : [];
    const dzStat = dzStatList.map((s) => statusPill(s, { short: true })).join(" ");
    const dzText = v.dz_names ? `<div class="dz-text" title="${escapeHtml(v.dz_names)}">${escapeHtml(v.dz_names)}</div>` : "";
    const tds = [
      `<td class="num">${v.position}</td>`,
      `<td>${escapeHtml(v.ref || "")}</td>`,
      `<td class="alt-cell" title="${escapeHtml(v.alt || "")}">${escapeHtml(v.alt || "")}</td>`,
      `<td>${escapeHtml(v.aachange || "")}</td>`,
    ];
    if (hasApo) tds.push(`<td>${escapeHtml(String(apo))}</td>`);
    if (hasMtt) tds.push(`<td>${escapeHtml(String(mtt))}</td>`);
    if (hasGnh) tds.push(`<td class="num gn-cell">${gnCell(v)}</td>`);
    if (hasHxh) tds.push(`<td class="num">${hxCell(v)}</td>`);
    tds.push(`<td class="num">${(v.fl_count || 0).toLocaleString()}</td>`);
    tds.push(`<td class="num">${(v.cr_count || 0).toLocaleString()}</td>`);
    if (hasDz) tds.push(`<td class="dz-col">${dzN ? `${dzStat}${dzText}` : ""}</td>`);
    return `<tr data-pos="${v.position}" data-ref="${escapeHtml(v.ref || "")}" data-alt="${escapeHtml(v.alt || "")}">${tds.join("")}</tr>`;
  }).join("");
  const ths = ["<th>pos</th>", "<th>ref</th>", "<th>alt</th>", "<th>aa</th>"];
  if (hasApo) ths.push("<th>APOGEE</th>");
  if (hasMtt) ths.push("<th>MitoTIP</th>");
  if (hasGnh) ths.push("<th>gnomAD AF</th>");
  if (hasHxh) ths.push("<th>Helix AF</th>");
  ths.push("<th>FL</th>", "<th>CR</th>");
  if (hasDz) ths.push("<th>disease</th>");
  const t = variantRows
    ? `<div class="grid-wrap"><table class="grid variants-grid"><thead><tr>${ths.join("")}</tr></thead><tbody>${variantRows}</tbody></table></div>${hasMtt ? MITOTIP_NOTE : ""}`
    : '<p class="muted">No variants.</p>';
  const totalDz = variants.filter((v) => (v.n_mmutation + v.n_rtmutation) > 0).length;
  const toolbar = `<div class="var-toolbar">
    <label class="opt"><input id="regOnlyDz" type="checkbox" ${onlyDz ? "checked" : ""}/> only disease-related variants${onlyDz ? "" : ` <span class=\"muted\">(${totalDz}/${variants.length} shown)</span>`}</label>
    ${d.variants_count_total > variants.length ? `<span class="muted">Showing ${variants.length} of ${d.variants_count_total.toLocaleString()} variants.</span>` : `<span class="muted">${(d.variants_count_total || 0).toLocaleString()} variant(s) in range.</span>`}
  </div>`;

  out.innerHTML = [
    card("Region", head),
    card("Variants", toolbar + t, { wide: true }),
    overlap ? card("Overlapping loci", `<ul class="bare">${overlap}</ul>`) : "",
  ].filter(Boolean).join("");
  const cb = document.getElementById("regOnlyDz");
  if (cb) cb.addEventListener("change", () => loadRegion({ ...args, dz_only: cb.checked }));

  out.querySelectorAll("table.variants-grid tbody tr").forEach((tr, i) => {
    const v = shown[i];
    if (!v) return;
    tr.style.cursor = "pointer";
    tr.title = "open in Position";
    tr.addEventListener("click", () => {
      $("posInput").value = v.position;
      $("posRef").value = v.ref || "";
      $("posAlt").value = v.alt || "";
      switchTab("position");
      doPosition();
    });
  });
}

// ---------- Disease (split-pane) ----------
let DZ_MUT_LIST = [];
let DZ_PHEN_LIST = [];
let DZ_PHEN_SELECTED = null;  // Set of short_name (null = all)
let DZ_STATUS_SELECTED = null; // Set of bucket keys (null = all)
let DZ_SELECTED_IDX = -1;

// Test whether a mutation matches the chosen phenotypes (substring on dz).
function mutMatchesPhen(m, phenSet) {
  if (!phenSet) return true;           // null = unfiltered
  if (phenSet.size === 0) return false; // explicitly none selected
  const dz = String(m.dz || "").toLowerCase();
  for (const p of DZ_PHEN_LIST) {
    if (!phenSet.has(p.short_name)) continue;
    const sn = (p.short_name || "").toLowerCase();
    const nm = (p.name || "").toLowerCase();
    if (sn && dz.includes(sn)) return true;
    if (nm && dz.includes(nm)) return true;
  }
  return false;
}

function renderDzFilters() {
  const el = $("dzFilters");
  if (!el) return;
  // counts are scoped to the current phenotype filter so chip numbers update live
  const present = new Map();
  for (const m of DZ_MUT_LIST) {
    if (!mutMatchesPhen(m, DZ_PHEN_SELECTED)) continue;
    const b = statusBucket(m.status);
    present.set(b, (present.get(b) || 0) + 1);
  }
  const stChips = STATUS_BUCKETS
    .filter(([k]) => present.has(k))
    .map(([k, label]) => {
      const active = !DZ_STATUS_SELECTED || DZ_STATUS_SELECTED.has(k);
      return `<span class="chip pill-${k.replace("-", "-")} ${active ? "on" : "off"}" data-bucket="${k}">${escapeHtml(label)} <span class="chip-n">${present.get(k)}</span></span>`;
    }).join("");
  el.innerHTML = `<div class="flt-row">${stChips || '<span class="muted">—</span>'} <a href="#" id="dzStAll" class="flt-link">all</a> <a href="#" id="dzStPLP" class="flt-link" title="VUS, P, LP, Cfrm [P], Cfrm [LP]">VUS/P/LP</a> <a href="#" id="dzStNone" class="flt-link">none</a></div>`;
  el.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => {
    const k = c.dataset.bucket;
    if (!DZ_STATUS_SELECTED) DZ_STATUS_SELECTED = new Set(STATUS_BUCKETS.map(([x]) => x));
    if (DZ_STATUS_SELECTED.has(k)) DZ_STATUS_SELECTED.delete(k); else DZ_STATUS_SELECTED.add(k);
    renderDzFilters();
    renderDzList();
  }));
  const all = document.getElementById("dzStAll");
  if (all) all.addEventListener("click", (ev) => { ev.preventDefault(); DZ_STATUS_SELECTED = null; renderDzFilters(); renderDzList(); });
  const plp = document.getElementById("dzStPLP");
  if (plp) plp.addEventListener("click", (ev) => { ev.preventDefault(); DZ_STATUS_SELECTED = new Set(["vus", "p", "lp", "cfrm-p", "cfrm-lp"]); renderDzFilters(); renderDzList(); });
  const none = document.getElementById("dzStNone");
  if (none) none.addEventListener("click", (ev) => { ev.preventDefault(); DZ_STATUS_SELECTED = new Set(); renderDzFilters(); renderDzList(); });
}

let DZ_PHEN_FILTER = "";
let DZ_PHEN_LAYOUT = "above"; // "above" | "side"
function renderDzPhen() {
  // Render into the visible container based on layout choice.
  const targetId = DZ_PHEN_LAYOUT === "above" ? "dzPhenTop" : "dzPhen";
  const otherId = DZ_PHEN_LAYOUT === "above" ? "dzPhen" : "dzPhenTop";
  const phenEl = document.getElementById(targetId);
  const otherEl = document.getElementById(otherId);
  if (otherEl) otherEl.innerHTML = "";
  if (!phenEl) return;
  if (!DZ_PHEN_LIST.length) {
    phenEl.innerHTML = `<div class="phen-card muted"><h4>Phenotype catalog (0)</h4><p style="padding:0 8px">no catalog entry matches</p></div>`;
    return;
  }
  const ft = DZ_PHEN_FILTER.trim().toLowerCase();
  const shown = ft
    ? DZ_PHEN_LIST.filter((p) => (p.short_name || "").toLowerCase().includes(ft) || (p.name || "").toLowerCase().includes(ft))
    : DZ_PHEN_LIST;
  const items = shown.map((p) => {
    const i = DZ_PHEN_LIST.indexOf(p);
    const checked = !DZ_PHEN_SELECTED || DZ_PHEN_SELECTED.has(p.short_name);
    return `<label class="phen-row"><input type="checkbox" data-i="${i}" ${checked ? "checked" : ""} /> <b>${escapeHtml(p.short_name || "")}</b> <span class="muted">${escapeHtml(p.name || "")}</span></label>`;
  }).join("") || '<p class="muted" style="padding:4px">no match</p>';
  const aboveOn = DZ_PHEN_LAYOUT === "above" ? "active" : "";
  const sideOn  = DZ_PHEN_LAYOUT === "side"  ? "active" : "";
  phenEl.innerHTML = `<div class="phen-card">
    <div class="phen-head"><h4>Phenotype catalog (${shown.length}/${DZ_PHEN_LIST.length})</h4> <a href="#" id="dzPhenAll" class="flt-link">all</a> <a href="#" id="dzPhenNone" class="flt-link">none</a>
      <span class="phen-layout-toggle">layout: <a href="#" id="dzPhenLayoutAbove" class="${aboveOn}">above</a> <a href="#" id="dzPhenLayoutSide" class="${sideOn}">side</a></span>
    </div>
    <input id="dzPhenSearch" class="phen-search" type="search" placeholder="filter phenotype catalog…" value="${escapeHtml(DZ_PHEN_FILTER)}" />
    ${items}
  </div>`;
  const si = document.getElementById("dzPhenSearch");
  if (si) {
    si.addEventListener("input", () => {
      DZ_PHEN_FILTER = si.value;
      const ft2 = DZ_PHEN_FILTER.trim().toLowerCase();
      // Default to "everything within the filtered list" — but leave status filter untouched.
      if (ft2) {
        DZ_PHEN_SELECTED = new Set(
          DZ_PHEN_LIST
            .filter((p) => (p.short_name || "").toLowerCase().includes(ft2) || (p.name || "").toLowerCase().includes(ft2))
            .map((p) => p.short_name)
        );
      } else {
        DZ_PHEN_SELECTED = null; // empty filter = all
      }
      renderDzPhen();
      renderDzFilters();
      renderDzList();
      const focused = document.getElementById("dzPhenSearch");
      if (focused) { focused.focus(); focused.setSelectionRange(focused.value.length, focused.value.length); }
    });
  }
  phenEl.querySelectorAll("input[type=checkbox]").forEach((cb) => cb.addEventListener("change", () => {
    if (!DZ_PHEN_SELECTED) DZ_PHEN_SELECTED = new Set(DZ_PHEN_LIST.map((p) => p.short_name));
    const sn = DZ_PHEN_LIST[+cb.dataset.i].short_name;
    if (cb.checked) DZ_PHEN_SELECTED.add(sn); else DZ_PHEN_SELECTED.delete(sn);
    renderDzFilters();
    renderDzList();
  }));
  document.getElementById("dzPhenAll").addEventListener("click", (e) => { e.preventDefault(); DZ_PHEN_SELECTED = null; renderDzPhen(); renderDzFilters(); renderDzList(); });
  document.getElementById("dzPhenNone").addEventListener("click", (e) => { e.preventDefault(); DZ_PHEN_SELECTED = new Set(); renderDzPhen(); renderDzFilters(); renderDzList(); });
  const above = document.getElementById("dzPhenLayoutAbove");
  const side  = document.getElementById("dzPhenLayoutSide");
  const applyLayout = (which) => {
    DZ_PHEN_LAYOUT = which;
    document.getElementById("disease").classList.toggle("phen-above", which === "above");
    renderDzPhen();
  };
  if (above) above.addEventListener("click", (e) => { e.preventDefault(); applyLayout("above"); });
  if (side)  side .addEventListener("click", (e) => { e.preventDefault(); applyLayout("side"); });
}

function renderDzList() {
  const listEl = $("dzList");
  const filtered = DZ_MUT_LIST.map((m, i) => ({ m, i }))
    .filter(({ m }) => mutMatchesPhen(m, DZ_PHEN_SELECTED))
    .filter(({ m }) => !DZ_STATUS_SELECTED || DZ_STATUS_SELECTED.has(statusBucket(m.status)));
  const hdr = document.getElementById("dzListHeadText") || $("dzListHead");
  if (hdr) hdr.textContent = `Mutations (${filtered.length} / ${DZ_MUT_LIST.length})`;
  if (!filtered.length) {
    listEl.innerHTML = '<p class="muted" style="padding:12px">No mutations match the current filters.</p>';
    return;
  }
  listEl.innerHTML = filtered.map(({ m, i }) => {
    const allele = escapeHtml(m.allele || `${m.ref || ""}${m.position}${m.alt || ""}`);
    const active = i === DZ_SELECTED_IDX ? " active" : "";
    return `<div class="list-row${active}" data-idx="${i}">
      <span class="lr-main"><b>${allele}</b> <span class="muted">${escapeHtml(m.locus || "")}</span><br><span class="dz-text">${escapeHtml(m.dz || "")}</span></span>
      <span class="lr-meta">${statusPill(m.status, { short: true })}<br><span class="src-tag src-${m._src === "coding" ? "c" : "r"}">${m._src}</span> <span class="muted">pos ${m.position}</span></span>
    </div>`;
  }).join("");
  listEl.querySelectorAll(".list-row").forEach((row) => {
    row.addEventListener("click", () => {
      DZ_SELECTED_IDX = parseInt(row.dataset.idx, 10);
      listEl.querySelectorAll(".list-row").forEach((r) => r.classList.remove("active"));
      row.classList.add("active");
      renderDiseaseDetail(DZ_SELECTED_IDX);
    });
  });
  if (DZ_SELECTED_IDX < 0 || !DZ_MUT_LIST[DZ_SELECTED_IDX]) {
    const first = listEl.querySelector(".list-row");
    if (first) first.click();
  }
}

async function doDisease() {
  const q = ""; // catalog-driven view: always load full catalog, filter via phenotype checklist
  const phenEl = $("dzPhen");
  const phenTopEl = document.getElementById("dzPhenTop");
  const listEl = $("dzList");
  const detailEl = $("dzDetail");
  const filtEl = $("dzFilters");
  listEl.innerHTML = '<p class="muted" style="padding:12px">Loading…</p>';
  phenEl.innerHTML = "";
  if (phenTopEl) phenTopEl.innerHTML = "";
  if (filtEl) filtEl.innerHTML = "";
  detailEl.innerHTML = '<p class="muted" style="padding:12px">Pick a mutation in the middle pane.</p>';
  let d;
  try { d = await api(`/api/lookup/disease?q=${encodeURIComponent(q)}`); }
  catch (e) { listEl.innerHTML = `<p class="err" style="padding:12px">${escapeHtml(e.message)}</p>`; return; }

  DZ_PHEN_LIST = d.phenotypes || [];
  DZ_PHEN_SELECTED = null;
  DZ_PHEN_FILTER = "";
  DZ_STATUS_SELECTED = null;
  DZ_SELECTED_IDX = -1;
  DZ_MUT_LIST = [
    ...d.mmutation.map((m) => ({ ...m, _src: "coding", _extra: `aa ${m.aa || "·"}` })),
    ...d.rtmutation.map((m) => ({ ...m, _src: "RNA", _extra: `rna ${m.rna || "·"}` })),
  ].sort((a, b) => (a.position || 0) - (b.position || 0));

  renderDzPhen();
  renderDzFilters();
  renderDzList();
}

async function renderDiseaseDetail(idx) {
  const m = DZ_MUT_LIST[idx];
  if (!m) return;
  const out = $("dzDetail");
  const allele = m.allele || `${m.ref || ""}${m.position}${m.alt || ""}`;
  const change = (m.ref && m.alt)
    ? `<b>m.${m.position} ${escapeHtml(fmtAllele(m.ref, m.alt))}</b>`
    : `<b>position ${m.position}</b> <span class="muted">(exact change unspecified)</span>`;
  const titleHtml = `<span class="src-tag src-${m._src === "coding" ? "c" : "r"}">${m._src}</span> ${escapeHtml(allele)}`;
  const meta = [
    `change: ${change}`,
    `position <b>${m.position}</b> &middot; <a href="#" id="dzOpenPos">open in Position →</a>`,
    `status: ${statusPill(m.status)} <span class="muted">${escapeHtml(m.status || "")}</span>`,
    `source: ${m._src === "coding" ? "mmutation (coding)" : "rtmutation (rRNA/tRNA)"}`,
    `locus <b>${escapeHtml(m.locus || "—")}</b> · ${escapeHtml(m._extra)}`,
    `cons ${escapeHtml(String(m.cons ?? "—"))} · contr ${escapeHtml(String(m.contr ?? "—"))}`,
    `homo ${m.homo ?? "?"} · het ${m.hetero ?? "?"}`,
    `cfrm ${escapeHtml(m.cfrm_date || "—")}`,
  ].map((s) => `<li>${s}</li>`).join("");
  const headerCard = card(titleHtml,
    `<p><b>${escapeHtml(m.dz || "")}</b></p><ul class="bare meta-list">${meta}</ul>`,
    { titleHtml: true });
  out.innerHTML = headerCard + '<p class="muted" style="padding:8px 12px">Loading position-level details…</p>';
  const openLink = document.getElementById("dzOpenPos");
  if (openLink) openLink.addEventListener("click", (ev) => {
    ev.preventDefault();
    $("posInput").value = m.position;
    $("posRef").value = m.ref || "";
    $("posAlt").value = m.alt || "";
    switchTab("position");
    doPosition();
  });
  // Reuse the same card pipeline as the Position tab (minus the stage 1-3 graphs).
  try {
    const qs = new URLSearchParams({ pos: m.position });
    if (m.ref) qs.set("ref", m.ref);
    if (m.alt) qs.set("alt", m.alt);
    const d = await api(`/api/lookup/position?${qs}`);
    const cardsHtml = buildPositionCards(m.position, d, {
      ref: m.ref, alt: m.alt, includePositionCard: true, onlyAllele: true,
    });
    out.innerHTML = headerCard + cardsHtml;
    // Re-bind the open-in-Position link (innerHTML wipe destroyed listeners).
    const link = document.getElementById("dzOpenPos");
    if (link) link.addEventListener("click", (ev) => {
      ev.preventDefault();
      $("posInput").value = m.position;
      $("posRef").value = m.ref || "";
      $("posAlt").value = m.alt || "";
      switchTab("position");
      doPosition();
    });
  } catch (e) {
    out.innerHTML = headerCard + `<p class="err" style="padding:8px 12px">${escapeHtml(e.message)}</p>`;
  }
}

// ---------- Structural variants (deletion / mdeletion / insertion / rearrangement) ----------
let STR_TYPE = "deletion";
let STR_DATA = null; // last response { counts, deletion, mdeletion, insertion, rearrangement }

function strCollectFilters() {
  const s = parseInt($("strStart").value, 10);
  const e = parseInt($("strEnd").value, 10);
  const p = parseInt($("strPos").value, 10);
  const loc = $("strLocus").value || "";
  const qs = new URLSearchParams({ type: "all", limit: "5000" });
  if (Number.isFinite(s)) qs.set("start", s);
  if (Number.isFinite(e)) qs.set("end", e);
  if (Number.isFinite(p)) qs.set("pos", p);
  if (loc) qs.set("locus", loc);
  return qs;
}

function strRefsBlock(refs) {
  if (!refs || !refs.length) return '<span class="muted">no references</span>';
  const sorted = sortRefsByPmid(refs);
  return `<ul class="refs">${sorted.map(fmtRef).join("")}</ul>`;
}

function strRefsToggle(refs) {
  const n = (refs || []).length;
  if (!n) return '<span class="muted">—</span>';
  return `<button type="button" class="str-refs-tog">▸ ${n} ref${n === 1 ? "" : "s"}</button>`;
}

function strDataRow(cells, refs, colCount) {
  // A pair: the data row + a hidden full-width row that toggles the references.
  return `<tr class="str-data-row">${cells}<td class="refs-cell">${strRefsToggle(refs)}</td></tr>
    <tr class="str-refs-row hidden"><td colspan="${colCount}" class="str-refs-detail">${strRefsBlock(refs)}</td></tr>`;
}

function strRenderTable(type, rows) {
  if (!rows || !rows.length) {
    return '<p class="muted" style="padding:8px">No matching record.</p>';
  }
  let head = "", body = "", colCount = 0;
  if (type === "deletion") {
    head = `<tr><th class="num">id</th><th class="pos-cell">range</th><th class="num">size</th>
      <th>del</th><th>repeat</th><th>reploc</th><th>n</th><th class="refs-cell">references</th></tr>`;
    colCount = 8;
    body = rows.map((r) => strDataRow(`
      <td class="num">${r.id}</td>
      <td class="pos-cell">${r.startpos ?? "?"}–${r.endpos ?? "?"}</td>
      <td class="num">${escapeHtml(String(r.size ?? ""))}</td>
      <td>${escapeHtml(r.del || "")}</td>
      <td>${escapeHtml(r.repeat || "")}</td>
      <td>${escapeHtml(r.reploc || "")}</td>
      <td>${escapeHtml(String(r.n ?? ""))}</td>`, r.references, colCount)).join("");
  } else if (type === "mdeletion") {
    head = `<tr><th class="num">id</th><th class="pos-cell">ranges</th><th class="num">size</th>
      <th>del</th><th>repeat</th><th>reploc</th><th class="num">ptid</th><th class="refs-cell">references</th></tr>`;
    colCount = 8;
    body = rows.map((r) => {
      const rngs = (r.ranges || []).map((x) => `${x.startpos}–${x.endpos}`).join("<br>") || '<span class="muted">—</span>';
      return strDataRow(`
        <td class="num">${r.id}</td>
        <td class="pos-cell">${rngs}</td>
        <td class="num">${escapeHtml(String(r.size ?? ""))}</td>
        <td>${escapeHtml(r.del || "")}</td>
        <td>${escapeHtml(r.repeat || "")}</td>
        <td>${escapeHtml(r.reploc || "")}</td>
        <td class="num">${escapeHtml(String(r.ptid ?? ""))}</td>`, r.references, colCount);
    }).join("");
  } else if (type === "insertion") {
    head = `<tr><th class="num">id</th><th class="pos-cell">range</th><th class="num">size</th>
      <th>insert</th><th>insertpt</th><th>repeats</th><th>n</th><th>parentmol</th><th class="refs-cell">references</th></tr>`;
    colCount = 9;
    body = rows.map((r) => strDataRow(`
      <td class="num">${r.id}</td>
      <td class="pos-cell">${r.range_start != null ? `${r.range_start}–${r.range_end ?? "?"}` : '<span class="muted">—</span>'}</td>
      <td class="num">${escapeHtml(String(r.inssize ?? ""))}</td>
      <td>${escapeHtml(r.insert_seq || "")}</td>
      <td>${escapeHtml(r.insertpt || "")}</td>
      <td>${escapeHtml(r.repeats || "")}</td>
      <td>${escapeHtml(String(r.n ?? ""))}</td>
      <td>${escapeHtml(r.parentmol || "")}</td>`, r.references, colCount)).join("");
  } else if (type === "rearrangement") {
    head = `<tr><th class="num">id</th><th class="num">size</th><th>insert / junction</th>
      <th>repeats</th><th>species</th><th>parentmol</th><th>n</th><th class="refs-cell">references</th></tr>`;
    colCount = 8;
    body = rows.map((r) => strDataRow(`
      <td class="num">${r.id}</td>
      <td class="num">${escapeHtml(String(r.inssize ?? ""))}</td>
      <td>${escapeHtml(r.insert_seq || "")}</td>
      <td>${escapeHtml(r.repeats || "")}</td>
      <td>${escapeHtml(r.species || "")}</td>
      <td>${escapeHtml(r.parentmol || "")}</td>
      <td>${escapeHtml(String(r.n ?? ""))}</td>`, r.references, colCount)).join("");
  }
  return `<div class="grid-wrap"><table class="grid str-grid"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function strRender() {
  const out = $("strOut");
  if (!STR_DATA) { out.innerHTML = '<p class="muted" style="padding:12px">Loading…</p>'; return; }
  // Update count badges
  for (const t of ["deletion", "mdeletion", "insertion", "rearrangement"]) {
    const el = document.getElementById("strN-" + t);
    if (el) {
      const n = STR_DATA.counts?.[t] ?? 0;
      el.textContent = `(${n})`;
    }
  }
  const rows = STR_DATA[STR_TYPE] || [];
  const note = (STR_TYPE === "rearrangement" && STR_DATA.rearrangement_note)
    ? `<p class="muted" style="padding:8px 12px">${escapeHtml(STR_DATA.rearrangement_note)}</p>`
    : "";
  const filtSummary = (() => {
    const f = STR_DATA.filter || {};
    const parts = [];
    if (f.locus) parts.push(`locus <b>${escapeHtml(f.locus)}</b>`);
    if (f.start != null && f.end != null) parts.push(`range <b>${f.start}–${f.end}</b>`);
    if (f.pos != null) parts.push(`includes pos <b>${f.pos}</b>`);
    return parts.length ? `<p class="muted" style="padding:4px 0">filters: ${parts.join(" · ")}</p>` : "";
  })();
  out.innerHTML = card(
    `${STR_TYPE.charAt(0).toUpperCase() + STR_TYPE.slice(1)} — ${rows.length}`,
    filtSummary + note + strRenderTable(STR_TYPE, rows),
    { wide: true }
  );
  // Wire ref-toggle: clicking the button (or its data row) toggles the
  // following hidden full-width refs row.
  out.querySelectorAll("tr.str-data-row").forEach((row) => {
    const tog = row.querySelector(".str-refs-tog");
    if (!tog) return;
    const refsRow = row.nextElementSibling;
    if (!refsRow || !refsRow.classList.contains("str-refs-row")) return;
    const flip = (ev) => {
      ev.stopPropagation();
      const open = refsRow.classList.toggle("hidden") === false;
      tog.textContent = `${open ? "▾" : "▸"} ${tog.textContent.replace(/^[▸▾]\s*/, "")}`;
      row.classList.toggle("expanded", open);
    };
    tog.addEventListener("click", flip);
    row.addEventListener("click", (ev) => {
      // Avoid double-toggle when clicking the button itself.
      if (ev.target.closest(".str-refs-tog")) return;
      flip(ev);
    });
  });
}

async function strSearch() {
  STR_DATA = null;
  strRender();
  try {
    const qs = strCollectFilters();
    STR_DATA = await api(`/api/lookup/structural?${qs}`);
  } catch (e) {
    $("strOut").innerHTML = `<p class="err" style="padding:12px">${escapeHtml(e.message)}</p>`;
    return;
  }
  strRender();
}

function strInitOnce() {
  // Populate locus picker
  loadLoci().then(() => {
    const sel = $("strLocus");
    if (!sel || sel.options.length > 1) return;
    LOCI_CACHE.forEach((L) => {
      const o = document.createElement("option");
      o.value = L.name;
      o.textContent = `${L.name}${L.common_name && L.common_name !== "-" ? ` (${L.common_name})` : ""}`;
      sel.appendChild(o);
    });
  });
  document.querySelectorAll(".str-tab").forEach((b) => {
    b.addEventListener("click", () => {
      STR_TYPE = b.dataset.type;
      document.querySelectorAll(".str-tab").forEach((x) => x.classList.toggle("active", x === b));
      strRender();
    });
  });
  $("strSearchBtn").addEventListener("click", strSearch);
  $("strResetBtn").addEventListener("click", () => {
    $("strStart").value = ""; $("strEnd").value = ""; $("strPos").value = ""; $("strLocus").value = "";
    strSearch();
  });
  ["strStart", "strEnd", "strPos"].forEach((id) =>
    $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") strSearch(); })
  );
  $("strLocus").addEventListener("change", strSearch);
}

// ---------- Wiring ----------
$("posBtn").addEventListener("click", doPosition);
["posInput", "posRef", "posAlt"].forEach((id) =>
  $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") doPosition(); })
);
$("posPrev").addEventListener("click", () => navNeighbor("prev"));
$("posNext").addEventListener("click", () => navNeighbor("next"));

let locusSearchTimer = null;
$("locusSearch").addEventListener("input", () => {
  clearTimeout(locusSearchTimer);
  locusSearchTimer = setTimeout(renderLocusList, 150);
});
$("locusSearch").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const q = parseLocusSearch($("locusSearch").value);
    if (q.range) loadRegion({ start: Math.min(q.range[0], q.range[1]), end: Math.max(q.range[0], q.range[1]) });
  }
});
if ($("locusOnlyDz")) $("locusOnlyDz").addEventListener("change", renderLocusList);

const loaded = { position: false, region: false, disease: false, structural: false, report: false, about: false };
window.__onTabChange = (which) => {
  if (which === "position" && !loaded.position) { loaded.position = true; doPosition(); }
  if (which === "region" && !loaded.region) { loaded.region = true; renderLocusList(); }
  if (which === "disease" && !loaded.disease) { loaded.disease = true; doDisease(); }
  if (which === "structural" && !loaded.structural) { loaded.structural = true; strInitOnce(); strSearch(); }
  if (which === "report" && !loaded.report) { loaded.report = true; reportInitOnce(); }
  if (which === "about" && !loaded.about) { loaded.about = true; renderAbout(); }
};

async function renderAbout() {
  const dbEl = document.getElementById("aboutDb");
  const tblEl = document.getElementById("aboutTables");
  let info = window.__DB_INFO;
  if (!info) {
    try { info = await api("/api/db_info"); window.__DB_INFO = info; }
    catch (e) { if (dbEl) dbEl.innerHTML = `<span class="err">${escapeHtml(e.message)}</span>`; return; }
  }
  if (dbEl) {
    dbEl.innerHTML = `MITOMAP data last updated <b>${escapeHtml(info.latest_date || "—")}</b> · `
      + `${info.tables} tables · ${(info.rows_total || 0).toLocaleString()} rows`;
  }
  if (tblEl) {
    tblEl.innerHTML = table(["table_name", "date"], info.per_table || []);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const side = $("sidebar"); if (side) side.style.display = "none";
  document.body.classList.add("no-sidebar");
  loaded.position = true;
  doPosition();
});

// ===========================================================================
// Report tab: parse uploaded NextGENe-style tab-delimited mutation report,
// look every variant up via /api/lookup/variants, render an annotated table.
// ===========================================================================
function reportInitOnce() {
  const fi = document.getElementById("reportFile");
  const rb = document.getElementById("reportReset");
  const pb = document.getElementById("reportPdf");
  if (fi && !fi.dataset.bound) {
    fi.dataset.bound = "1";
    fi.addEventListener("change", () => {
      const f = fi.files && fi.files[0];
      if (f) reportLoadFile(f);
    });
  }
  if (rb && !rb.dataset.bound) {
    rb.dataset.bound = "1";
    rb.addEventListener("click", () => {
      if (fi) fi.value = "";
      document.getElementById("reportOut").innerHTML = "";
      document.getElementById("reportMsg").textContent =
        "Choose a file. Lines above the row starting with Index are ignored.";
      LAST_REPORT_FNAME = "";
      if (pb) pb.disabled = true;
    });
  }
  if (pb && !pb.dataset.bound) {
    pb.dataset.bound = "1";
    pb.addEventListener("click", () => downloadReportPdf());
  }
}

// Remember the most-recent report filename so the PDF button can title the export.
let LAST_REPORT_FNAME = "";

// Generate a PDF of the annotated variants table currently shown in #reportOut.
// Uses jsPDF + jspdf-autotable (loaded via CDN). Each page gets the source file
// name in the header and a "Page x/y" footer. The table head repeats per page.
function downloadReportPdf() {
  const tbl = document.querySelector("#reportOut table.report-grid");
  if (!tbl) return;
  const jsPDFCtor = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
  if (!jsPDFCtor) {
    alert("PDF library failed to load (jsPDF unavailable).");
    return;
  }
  const fname = LAST_REPORT_FNAME || "report";
  const doc = new jsPDFCtor({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const generated = new Date().toLocaleString();
  doc.autoTable({
    html: tbl,
    startY: 56,
    margin: { top: 56, right: 24, bottom: 36, left: 24 },
    styles: { fontSize: 7, cellPadding: 2, overflow: "linebreak", valign: "top" },
    headStyles: { fillColor: [37, 99, 235], textColor: 255, fontSize: 7 },
    showHead: "everyPage",
    // Header (file name) + footer (page x/y) drawn on every page.
    didDrawPage: (data) => {
      doc.setFontSize(10);
      doc.setTextColor(40);
      doc.text(`MITOMAP variant report — ${fname}`, data.settings.margin.left, 28);
      doc.setFontSize(8);
      doc.setTextColor(120);
      doc.text(generated, pageW - data.settings.margin.right, 28, { align: "right" });
      const total = doc.internal.getNumberOfPages();
      const cur = doc.internal.getCurrentPageInfo().pageNumber;
      doc.setFontSize(9);
      doc.setTextColor(80);
      doc.text(`Page ${cur} / ${total}`, pageW / 2, pageH - 14, { align: "center" });
    },
  });
  // autoTable's didDrawPage runs before final total is known on earlier pages;
  // rewrite footers now that the page count is final.
  const total = doc.internal.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    // Cover previous footer with white before re-drawing.
    doc.setFillColor(255, 255, 255);
    doc.rect(0, pageH - 26, pageW, 26, "F");
    doc.setFontSize(9);
    doc.setTextColor(80);
    doc.text(`Page ${i} / ${total}`, pageW / 2, pageH - 14, { align: "center" });
  }
  const safe = fname.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_.-]+/g, "_");
  doc.save(`${safe || "report"}_annotated.pdf`);
}

// Parse one HGVS coding cell such as `m.[16473C>T];[(16473C>T)]` or
// `m.3109delT` and return {pos, ref, alt}. Returns null if unrecognized.
function parseHgvsCoding(s) {
  const txt = String(s || "");
  // SNV: m.<pos><ref>><alt>
  let m = txt.match(/m\.(?:\[)?(\d+)([ACGTN])>([ACGTN])/i);
  if (m) return { pos: +m[1], ref: m[2].toUpperCase(), alt: m[3].toUpperCase() };
  // Deletion: m.<pos>del<ref?>
  m = txt.match(/m\.(?:\[)?(\d+)del([ACGTN]?)/i);
  if (m) return { pos: +m[1], ref: (m[2] || "").toUpperCase(), alt: ":" };
  // Insertion: m.<pos>ins<alt>
  m = txt.match(/m\.(?:\[)?(\d+)ins([ACGTN]+)/i);
  if (m) return { pos: +m[1], ref: ":", alt: m[2].toUpperCase() };
  return null;
}

// Parse a NextGENe mutation-report text. Returns
// {header: string[], rows: object[]} where each row's keys are the header
// names plus parsed pos/ref/alt.
function parseReportText(text) {
  const lines = text.split(/\r?\n/);
  let hdrIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const cells = lines[i].split("\t");
    if ((cells[0] || "").trim().toLowerCase() === "index") { hdrIdx = i; break; }
  }
  if (hdrIdx < 0) throw new Error('No header row found (looking for a line starting with "Index").');
  const header = lines[hdrIdx].split("\t").map((s) => s.trim());
  const rows = [];
  for (let i = hdrIdx + 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.trim()) continue;
    const cells = ln.split("\t");
    if (cells.length < 3) continue;
    const row = {};
    header.forEach((h, j) => { row[h] = (cells[j] || "").trim(); });
    // Best-effort allele extraction
    const hgvs = row["Mutation Call: HGVS Coding"] || row["HGVS Coding"] || "";
    const parsed = parseHgvsCoding(hgvs);
    if (parsed) {
      row._pos = parsed.pos; row._ref = parsed.ref; row._alt = parsed.alt;
    } else {
      const pos = parseInt(row["Pos"], 10);
      if (Number.isFinite(pos)) row._pos = pos;
      row._ref = (row["Ref"] || "").toUpperCase();
      row._alt = "";
    }
    rows.push(row);
  }
  return { header, rows };
}

async function reportLoadFile(file) {
  const msg = document.getElementById("reportMsg");
  const out = document.getElementById("reportOut");
  msg.textContent = `Reading ${file.name}…`;
  out.innerHTML = "";
  let text;
  try { text = await file.text(); }
  catch (e) { msg.innerHTML = `<span class="err">${escapeHtml(e.message)}</span>`; return; }
  let parsed;
  try { parsed = parseReportText(text); }
  catch (e) { msg.innerHTML = `<span class="err">${escapeHtml(e.message)}</span>`; return; }
  const rows = parsed.rows;
  const usable = rows.filter((r) => r._pos && r._ref && r._alt && r._alt !== ":");
  msg.textContent =
    `${file.name}: ${rows.length} variants in file, ${usable.length} annotatable substitutions; looking up…`;
  let res;
  try {
    res = await api("/api/lookup/variants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variants: rows.map((r) => ({ pos: r._pos, ref: r._ref, alt: r._alt })) }),
    });
  } catch (e) {
    msg.innerHTML = `<span class="err">${escapeHtml(e.message)}</span>`;
    return;
  }
  const ann = res.variants || [];
  renderReport(file.name, rows, ann);
}

function renderReport(fname, rows, ann) {
  const out = document.getElementById("reportOut");
  const msg = document.getElementById("reportMsg");
  LAST_REPORT_FNAME = fname || "";
  const pdfBtn = document.getElementById("reportPdf");
  if (pdfBtn) pdfBtn.disabled = !rows.length;
  const pct = (x, dp = 3) => (x == null ? "" : `${(+x * 100).toFixed(dp)}%`);
  const dzCount = ann.filter((a) => a && ((a.n_mmutation || 0) + (a.n_rtmutation || 0)) > 0).length;
  msg.textContent = `${fname}: ${rows.length} variants, ${dzCount} with disease annotation.`;
  // Parse "F;R" pair like "12;34" -> 46. Returns 0 if blank/invalid.
  const sumFR = (s) => {
    const m = String(s || "").match(/(\d+)\s*;\s*(\d+)/);
    return m ? (+m[1]) + (+m[2]) : 0;
  };
  const BASES = ["A", "C", "G", "T"];
  // Short Hom/Het label: "Heterozygous"->"Het", "Homozygous"->"Hom"; otherwise show as-is.
  const shortZyg = (z) => {
    const s = String(z || "").trim();
    if (/^hetero/i.test(s)) return "Het";
    if (/^homo/i.test(s)) return "Hom";
    return s;
  };
  // Format "<score> (<short>)" e.g. "0.04 (B)" or "2.4 (LP)". Returns "" if both missing.
  const fmtScore = (score, short, dp) => {
    const haveS = score != null && score !== "";
    const haveI = short != null && short !== "";
    if (!haveS && !haveI) return "";
    if (haveS && haveI) return `${(+score).toFixed(dp)} (${escapeHtml(short)})`;
    if (haveS) return (+score).toFixed(dp);
    return escapeHtml(short);
  };
  const trs = rows.map((r, i) => {
    const a = ann[i] || {};
    const dzN = (a.n_mmutation || 0) + (a.n_rtmutation || 0);
    const dzStatList = a.dz_statuses ? [...new Set(String(a.dz_statuses).split("|").filter(Boolean))] : [];
    const dzStat = dzStatList.map((s) => statusPill(s, { short: true })).join(" ");
    const dzText = a.dz_names ? `<div class="dz-text" title="${escapeHtml(a.dz_names)}">${escapeHtml(a.dz_names)}</div>` : "";
    // Merged Prediction column: APOGEE for protein-coding sites, MitoTIP for tRNA sites.
    // APOGEE status string is like "P" or "B"; we keep just the bracket abbreviation.
    const apoShort = (() => {
      const s = String(a.apogee_status || "");
      const m = s.match(/\[([^\]]+)\]/);
      return (m ? m[1] : s).trim();
    })();
    const apoLine = fmtScore(a.apogee_score, apoShort, 2);
    const mttIt = a.mitotip_quartile ? mitotipInterp(a.mitotip_quartile) : null;
    const mttLine = fmtScore(a.mitotip_score, mttIt ? mttIt.short : "", 1);
    const predParts = [];
    if (apoLine) predParts.push(`APOGEE: ${apoLine}`);
    if (mttLine) predParts.push(`MitoTIP: ${mttLine}`);
    const predHtml = predParts.join("<br>");
    const gn = (a.gnomad_af_hom != null || a.gnomad_af_het != null)
      ? [a.gnomad_af_hom != null ? `hom ${pct(a.gnomad_af_hom)}` : "",
         a.gnomad_af_het != null ? `het ${pct(a.gnomad_af_het)}` : ""].filter(Boolean).join("<br>")
      : "";
    const hx = (a.helix_af_hom != null || a.helix_af_het != null)
      ? [a.helix_af_hom != null ? `hom ${pct(a.helix_af_hom)}` : "",
         a.helix_af_het != null ? `het ${pct(a.helix_af_het)}` : ""].filter(Boolean).join("<br>")
      : "";
    const fl = a.fl_count != null ? (+a.fl_count).toLocaleString() : "";
    const cr = a.cr_count != null ? (+a.cr_count).toLocaleString() : "";
    const allele = r._ref && r._alt ? `${escapeHtml(r._ref)}&gt;${escapeHtml(r._alt)}` : "";
    const posClick = r._pos
      ? `<a href="#" class="rp-pos" data-pos="${r._pos}" data-ref="${escapeHtml(r._ref || "")}" data-alt="${escapeHtml(r._alt || "")}">${r._pos}</a>`
      : "";
    // Per-base F+R counts; flag the called alt with bold.
    const counts = {};
    for (const b of BASES) counts[b] = sumFR(r[`${b}#(F;R)`]);
    counts["ins"] = sumFR(r["Ins#(F;R)"]);
    counts["del"] = sumFR(r["Del#(F;R)"]);
    const cov = parseInt(r["Coverage"], 10);
    const totalReads = Number.isFinite(cov) && cov > 0
      ? cov
      : counts.A + counts.C + counts.G + counts.T + counts.ins + counts.del;
    // Mutant allele key: "ins", "del", or the alt base.
    let mutKey = null;
    if (r._alt === ":" || /del/i.test(r._alt)) mutKey = "del";
    else if (r._ref === ":" || /ins/i.test(r._ref)) mutKey = "ins";
    else if (BASES.includes(r._alt)) mutKey = r._alt;
    const baseCellsHtml = BASES.map((b) => {
      const v = counts[b];
      const cls = b === mutKey ? ' class="mut"' : "";
      return `<td class="num"${cls}>${v || ""}</td>`;
    }).join("");
    const indelCellHtml = (counts.ins || counts.del)
      ? `<td class="num${mutKey === "ins" || mutKey === "del" ? " mut" : ""}">${counts.ins ? `ins ${counts.ins}` : ""}${counts.ins && counts.del ? "<br>" : ""}${counts.del ? `del ${counts.del}` : ""}</td>`
      : `<td></td>`;
    const mutCount = mutKey ? (counts[mutKey] || 0) : 0;
    const mutPctStr = (totalReads > 0 && mutKey)
      ? `${((mutCount / totalReads) * 100).toFixed(1)}%`
      : "";
    return `<tr>
      <td class="num">${escapeHtml(r["Index"] || String(i + 1))}</td>
      <td class="num">${posClick}</td>
      <td>${allele}</td>
      <td>${escapeHtml(a.locus || r["Gene"] || "")}</td>
      <td>${escapeHtml(shortZyg(r["Zygosity"]))}</td>
      <td class="num">${Number.isFinite(cov) ? cov.toLocaleString() : ""}</td>
      ${baseCellsHtml}
      ${indelCellHtml}
      <td class="num">${mutPctStr}</td>
      <td>${predHtml}</td>
      <td class="num">${gn}</td>
      <td class="num">${hx}</td>
      <td class="num">${fl}</td>
      <td class="num">${cr}</td>
      <td class="dz-col">${dzN ? `${dzStat}${dzText}` : ""}</td>
    </tr>`;
  }).join("");
  const ths = ["#", "pos", "allele", "locus", "Hom/Het", "cov",
               "A", "C", "G", "T", "indel", "%mut",
               "Prediction", "gnomAD AF", "Helix AF", "FL", "CR", "disease"]
    .map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const hasMtt = ann.some((a) => a && (a.mitotip_quartile || a.mitotip_score != null));
  out.innerHTML = card("Annotated variants",
    `<div class="grid-wrap report-wrap"><table class="grid variants-grid report-grid"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>${hasMtt ? MITOTIP_NOTE : ""}`,
    { wide: true });
  out.querySelectorAll(".rp-pos").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      $("posInput").value = a.dataset.pos;
      $("posRef").value = a.dataset.ref || "";
      $("posAlt").value = a.dataset.alt || "";
      switchTab("position");
      doPosition();
    });
  });
}
