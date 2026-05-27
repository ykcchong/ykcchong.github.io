/* MITOMAP Explorer — server-less static API shim.
 *
 * Loads the read-only sqlite database via sql.js-httpvfs (HTTP Range requests,
 * SQLite WASM in a Web Worker) and re-implements every endpoint that the
 * frontend (app.js / views.js) calls.  No FastAPI / Python server is required.
 *
 * The shim installs `window.__api(path, opts)` which has the same signature as
 * the original `api()` used everywhere in the UI.  app.js (the static copy)
 * delegates to it, so all existing call sites work unchanged.
 *
 * Endpoints implemented (parity with app/views.py + app/main.py):
 *   GET  /api/db_info
 *   GET  /api/tables
 *   GET  /api/tables/{name}/rows
 *   POST /api/query
 *   GET  /api/lookup/loci
 *   GET  /api/lookup/region
 *   GET  /api/lookup/position
 *   GET  /api/lookup/position/neighbors
 *   GET  /api/lookup/phenotypes
 *   GET  /api/lookup/disease
 *   GET  /api/lookup/structural
 *   POST /api/lookup/variants
 */
// jsDelivr currently exposes createDbWorker on the default export for +esm.
// Import the namespace via default so the shim survives CDN export-shape changes.
import sqlJsHttpVfs from "https://cdn.jsdelivr.net/npm/sql.js-httpvfs@0.8.12/+esm";

const createDbWorker = sqlJsHttpVfs?.createDbWorker;
if (typeof createDbWorker !== "function") {
  throw new Error("sql.js-httpvfs did not expose createDbWorker");
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const CFG = window.__MITOMAP_STATIC_CFG__ || {};
const DB_URL          = CFG.dbUrl          || "./mitomap.sqlite";
// Worker + wasm MUST be same-origin: browsers refuse to instantiate Web Workers
// from a different origin (CORS).  Vendored copies live alongside this file.
const WORKER_URL      = CFG.workerUrl      || "./sqlite.worker.js";
const WASM_URL        = CFG.wasmUrl        || "./sql-wasm.wasm";
const REQUEST_CHUNK   = CFG.requestChunkSize || 4096;
const CACHE_PAGES     = CFG.maxBytesToRead   || 50 * 1024 * 1024;
const DB_FILE_SIZE    = CFG.fileLength ?? CFG.fileSize ?? 19943424;

let _workerPromise = null;
function getWorker() {
  if (_workerPromise) return _workerPromise;
  _workerPromise = createDbWorker(
    [{
      from: "inline",
      config: {
        serverMode: "full",
        url: DB_URL,
        requestChunkSize: REQUEST_CHUNK,
        fileLength: DB_FILE_SIZE,
      },
    }],
    WORKER_URL,
    WASM_URL,
    CACHE_PAGES,
  );
  return _workerPromise;
}

// Convenience wrappers — sql.js-httpvfs returns arrays of objects.
async function q(sql, params = []) {
  const w = await getWorker();
  return w.db.query(sql, params);
}
async function q1(sql, params = []) {
  const rows = await q(sql, params);
  return rows.length ? rows[0] : null;
}
async function scalar(sql, params = []) {
  const row = await q1(sql, params);
  if (!row) return null;
  const k = Object.keys(row)[0];
  return row ? row[k] : null;
}

// ---------------------------------------------------------------------------
// Helpers shared by lookup endpoints
// ---------------------------------------------------------------------------
const TYPE_LABEL = { t: "tRNA", r: "rRNA", p: "protein-coding", d: "D-loop / control", i: "intergenic", n: "non-coding" };

async function _resolve_locus(name) {
  return q1(
    "SELECT id, name, common_name, starting, ending, strand, type, product " +
    "FROM locus WHERE name = ? OR common_name = ? LIMIT 1",
    [name, name],
  );
}

function _placeholders(n) { return Array(n).fill("?").join(","); }

async function _refs_for(linkTable, fkCol, ids) {
  if (!ids.length) return {};
  const rows = await q(
    `SELECT lt.${fkCol} AS mid, r.id, r.authors, r.title, r.publication,
            r.volume, r.pages, r.date, r.nlmid
       FROM ${linkTable} lt
       JOIN reference r ON r.id = lt.reference_id
      WHERE lt.${fkCol} IN (${_placeholders(ids.length)})
      ORDER BY r.date DESC, r.id`,
    ids,
  );
  const out = {};
  for (const r of rows) {
    const k = r.mid;
    if (!out[k]) out[k] = [];
    out[k].push({
      id: r.id, authors: r.authors, title: r.title, publication: r.publication,
      volume: r.volume, pages: r.pages, date: r.date, nlmid: r.nlmid,
    });
  }
  return out;
}
const _refs_for_mmut_ids  = (ids) => _refs_for("mmutation_reference",  "mmutation_id",  ids);
const _refs_for_rtmut_ids = (ids) => _refs_for("rtmutation_reference", "rtmutation_id", ids);

function _overlap(aS, aE, bS, bE) {
  if (aS == null || aE == null) return false;
  return !(aE < bS || aS > bE);
}

// ---------------------------------------------------------------------------
// /api/lookup/loci
// ---------------------------------------------------------------------------
async function ep_loci() {
  const loci = await q(
    "SELECT id, name, common_name, starting, ending, strand, type, product " +
    "FROM locus ORDER BY starting"
  );
  for (const L of loci) {
    const s = L.starting, e = L.ending;
    L.length     = (s != null && e != null) ? (e - s + 1) : null;
    L.type_label = TYPE_LABEL[String(L.type || "").toLowerCase()] || L.type;
    if (s == null || e == null) {
      L.n_variants = L.n_mmutation = L.n_rtmutation = 0;
      continue;
    }
    L.n_variants   = await scalar("SELECT COUNT(*) FROM polymorphism WHERE position BETWEEN ? AND ?", [s, e]);
    L.n_mmutation  = await scalar("SELECT COUNT(*) FROM mmutation    WHERE position BETWEEN ? AND ?", [s, e]);
    L.n_rtmutation = await scalar("SELECT COUNT(*) FROM rtmutation   WHERE position BETWEEN ? AND ?", [s, e]);
  }
  return loci;
}

// ---------------------------------------------------------------------------
// /api/lookup/region
// ---------------------------------------------------------------------------
async function ep_region(params) {
  let start = params.start != null ? +params.start : null;
  let end   = params.end   != null ? +params.end   : null;
  const locusName = params.locus || null;
  const include_variants = params.include_variants !== "false";
  const variants_limit   = Math.max(1, Math.min(20000, +(params.variants_limit || 500)));
  const dz_only          = params.dz_only === "1" || params.dz_only === "true";

  let resolved_locus = null;
  if (locusName) {
    resolved_locus = await _resolve_locus(locusName);
    if (!resolved_locus) throw httpErr(404, `Unknown locus: ${locusName}`);
    if (start == null) start = resolved_locus.starting;
    if (end   == null) end   = resolved_locus.ending;
  }
  if (start == null || end == null) throw httpErr(400, "Provide start+end or locus");
  if (start > end) [start, end] = [end, start];

  const overlap_loci = await q(
    "SELECT name, common_name, type, product, starting, ending, strand " +
    "FROM locus WHERE NOT (ending < ? OR starting > ?) ORDER BY starting",
    [start, end],
  );

  const out = { start, end, length: end - start + 1, locus: resolved_locus, overlap_loci };

  if (include_variants) {
    const cte = dz_only
      ? "WITH all_alleles AS (" +
        "  SELECT position, refna, regna FROM mmutation  WHERE position BETWEEN ? AND ?" +
        "  UNION" +
        "  SELECT position, refna, regna FROM rtmutation WHERE position BETWEEN ? AND ?" +
        ")"
      : "WITH all_alleles AS (" +
        "  SELECT position, refna, regna FROM polymorphism WHERE position BETWEEN ? AND ?" +
        "  UNION" +
        "  SELECT position, refna, regna FROM mmutation    WHERE position BETWEEN ? AND ?" +
        "  UNION" +
        "  SELECT position, refna, regna FROM rtmutation   WHERE position BETWEEN ? AND ?" +
        ")";
    const cteParams = dz_only ? [start, end, start, end] : [start, end, start, end, start, end];

    const variants = await q(
      cte +
      `\nSELECT  p.position    AS position,
               p.refna       AS ref,
               p.regna       AS alt,
               COALESCE(poly.aachange, mt.alt) AS aachange,
               a.score       AS apogee_score,
               a.status      AS apogee_status,
               mt.mitotip_score AS mitotip_score,
               mt.quartile      AS mitotip_quartile,
               mt.mitomap_status AS mitotip_mitomap_status,
               g.af_hom      AS gnomad_af_hom,
               g.af_het      AS gnomad_af_het,
               g.ac_hom      AS gnomad_ac_hom,
               g.ac_het      AS gnomad_ac_het,
               g.an          AS gnomad_an,
               g.filters     AS gnomad_filters,
               h.af_hom      AS helix_af_hom,
               h.af_het      AS helix_af_het,
               vc.fl_count   AS fl_count,
               vc.cr_count   AS cr_count,
               (SELECT COUNT(*) FROM mmutation  m WHERE m.position=p.position AND m.refna=p.refna AND m.regna=p.regna) AS n_mmutation,
               (SELECT COUNT(*) FROM rtmutation r WHERE r.position=p.position AND r.refna=p.refna AND r.regna=p.regna) AS n_rtmutation,
               (SELECT GROUP_CONCAT(status, '|') FROM (
                   SELECT status FROM mmutation  WHERE position=p.position AND refna=p.refna AND regna=p.regna
                   UNION ALL
                   SELECT status FROM rtmutation WHERE position=p.position AND refna=p.refna AND regna=p.regna
               )) AS dz_statuses,
               (SELECT GROUP_CONCAT(dz, ' | ') FROM (
                   SELECT dz FROM mmutation  WHERE position=p.position AND refna=p.refna AND regna=p.regna
                   UNION ALL
                   SELECT dz FROM rtmutation WHERE position=p.position AND refna=p.refna AND regna=p.regna
               )) AS dz_names
       FROM all_alleles p
       LEFT JOIN polymorphism   poly ON poly.position=p.position AND poly.refna=p.refna AND poly.regna=p.regna
       LEFT JOIN apogee         a  ON a.position=p.position AND a.refna=p.refna AND a.regna=p.regna
       LEFT JOIN mitotip_scores mt ON mt.position=p.position AND mt.rcrs =p.refna AND mt.alt =p.regna
       LEFT JOIN gnomad         g  ON g.position=p.position AND g.refna=p.refna AND g.regna=p.regna
       LEFT JOIN helix          h  ON h.position=p.position AND h.refna=p.refna AND h.regna=p.regna
       LEFT JOIN variants_count vc ON vc.tpos=p.position    AND vc.tnt =p.refna AND vc.qnt=p.regna
       ORDER BY p.position, p.refna, p.regna
       LIMIT ?`,
      [...cteParams, variants_limit],
    );
    out.variants = variants;
    out.variants_count_returned = variants.length;

    const totalSql = dz_only
      ? "SELECT COUNT(*) AS n FROM (" +
        "  SELECT position, refna, regna FROM mmutation  WHERE position BETWEEN ? AND ?" +
        "  UNION" +
        "  SELECT position, refna, regna FROM rtmutation WHERE position BETWEEN ? AND ?" +
        ")"
      : "SELECT COUNT(*) AS n FROM (" +
        "  SELECT position, refna, regna FROM polymorphism WHERE position BETWEEN ? AND ?" +
        "  UNION" +
        "  SELECT position, refna, regna FROM mmutation    WHERE position BETWEEN ? AND ?" +
        "  UNION" +
        "  SELECT position, refna, regna FROM rtmutation   WHERE position BETWEEN ? AND ?" +
        ")";
    out.variants_count_total = await scalar(totalSql, cteParams);
  }
  return out;
}

// ---------------------------------------------------------------------------
// /api/lookup/position
// ---------------------------------------------------------------------------
async function ep_position(params) {
  const pos = +params.pos;
  if (!(pos >= 1 && pos <= 16569)) throw httpErr(400, "pos out of range");
  const ref = params.ref || null;
  const alt = params.alt || null;
  const out = { position: pos, ref_filter: ref, alt_filter: alt };

  out.loci = await q(
    "SELECT name, common_name, type, product, starting, ending, strand " +
    "FROM locus WHERE starting <= ? AND ending >= ? ORDER BY (ending - starting)",
    [pos, pos],
  );
  out.codons = await q(
    "SELECT genename, geneid, codon, codonpos FROM codon WHERE pos = ?",
    [pos],
  );

  const wc = ["position = ?"];
  const wp = [pos];
  if (ref) { wc.push("refna = ?"); wp.push(ref); }
  if (alt) { wc.push("regna = ?"); wp.push(alt); }
  const w = wc.join(" AND ");

  out.polymorphism = await q(
    `SELECT id, position, refna AS ref, regna AS alt, aachange FROM polymorphism WHERE ${w} ORDER BY refna, regna`, wp);

  const mmut = await q(
    `SELECT id, locus, dz, allele, position, refna AS ref, regna AS alt, aa, cons, contr, homo, hetero, status, cfrm_date
       FROM mmutation WHERE ${w} ORDER BY id`, wp);
  const rtmut = await q(
    `SELECT id, locus, dz, allele, position, refna AS ref, regna AS alt, rna, cons, contr, homo, hetero, status, cfrm_date
       FROM rtmutation WHERE ${w} ORDER BY id`, wp);
  const mrefs = await _refs_for_mmut_ids(mmut.map(r => r.id));
  const rrefs = await _refs_for_rtmut_ids(rtmut.map(r => r.id));
  for (const m of mmut)  m.references = mrefs[m.id]  || [];
  for (const m of rtmut) m.references = rrefs[m.id] || [];
  out.mmutation = mmut;
  out.rtmutation = rtmut;

  out.apogee = await q(
    `SELECT position, refna AS ref, regna AS alt, score, status FROM apogee WHERE ${w} ORDER BY refna, regna`, wp);

  const wm = ["position = ?"]; const pm = [pos];
  if (ref) { wm.push("rcrs = ?"); pm.push(ref); }
  if (alt) { wm.push("alt = ?");  pm.push(alt); }
  out.mitotip = await q(
    `SELECT position, rcrs AS ref, alt, mitotip_score, quartile, count, percentage, mitomap_status
       FROM mitotip_scores WHERE ${wm.join(" AND ")} ORDER BY rcrs, alt`, pm);

  out.gnomad = await q(
    `SELECT position, refna AS ref, regna AS alt, filters, ac_hom, ac_het, af_hom, af_het, an, max_observed_heteroplasmy
       FROM gnomad WHERE ${w}`, wp);
  out.helix = await q(
    `SELECT position, refna AS ref, regna AS alt, feature, gene, counts_hom, af_hom, counts_het, af_het, mean_arf, max_arf
       FROM helix WHERE ${w}`, wp);

  const wcc = ["pos = ?"]; const pc = [pos];
  if (ref) { wcc.push("ref = ?"); pc.push(ref); }
  if (alt) { wcc.push("alt = ?"); pc.push(alt); }
  const wcSql = wcc.join(" AND ");

  // variants_count uses tpos/tnt/qnt (not pos/ref/alt)
  let vcSql = "SELECT tpos AS pos, tnt AS ref, qnt AS alt, ntchange, fl_count, cr_count FROM variants_count WHERE tpos = ?";
  const vcParams = [pos];
  if (ref) { vcSql += " AND tnt = ?"; vcParams.push(ref); }
  if (alt) { vcSql += " AND qnt = ?"; vcParams.push(alt); }
  out.variants_count = await q(vcSql, vcParams);

  const gb_total = await scalar(`SELECT COALESCE(SUM(cnt),0) FROM genbank_count   WHERE ${wcSql}`, pc) || 0;
  const gc_total = await scalar(`SELECT COALESCE(SUM(cnt),0) FROM gbcontrol_count WHERE ${wcSql}`, pc) || 0;
  const gb_top = await q(
    `SELECT haplogroup, SUM(cnt) AS cnt FROM genbank_count   WHERE ${wcSql} GROUP BY haplogroup ORDER BY cnt DESC LIMIT 20`, pc);
  const gc_top = await q(
    `SELECT haplogroup, SUM(cnt) AS cnt FROM gbcontrol_count WHERE ${wcSql} GROUP BY haplogroup ORDER BY cnt DESC LIMIT 20`, pc);
  out.haplogroup_counts = {
    genbank:   { total: gb_total, top: gb_top },
    gbcontrol: { total: gc_total, top: gc_top },
  };

  const unpW = ["position = ?"]; const unpP = [pos];
  if (ref) { unpW.push("UPPER(refna) = ?"); unpP.push(ref.toUpperCase()); }
  if (alt) { unpW.push("UPPER(regna) = ?"); unpP.push(alt.toUpperCase()); }
  out.unpublished = await q(
    `SELECT locus, refna, regna, aa, method, heteroplasmic, sample_id,
            patient, ethnicity, origin, haplogroup, tissue, note
       FROM unpublished WHERE ${unpW.join(" AND ")}
      ORDER BY locus, refna, regna LIMIT 200`, unpP);

  return out;
}

// ---------------------------------------------------------------------------
// /api/lookup/position/neighbors
// ---------------------------------------------------------------------------
async function ep_position_neighbors(params) {
  const pos = +params.pos;
  const prev = await scalar("SELECT MAX(position) FROM polymorphism WHERE position < ?", [pos]);
  const next = await scalar("SELECT MIN(position) FROM polymorphism WHERE position > ?", [pos]);
  return { prev, next };
}

// ---------------------------------------------------------------------------
// /api/lookup/phenotypes
// ---------------------------------------------------------------------------
async function ep_phenotypes() {
  return q("SELECT id, short_name, name, url, note FROM phenotype ORDER BY short_name");
}

// ---------------------------------------------------------------------------
// /api/lookup/disease
// ---------------------------------------------------------------------------
async function ep_disease(params) {
  const q_clean = (params.q || "").trim();
  const limit = Math.max(1, Math.min(2000, +(params.limit || 200)));

  let phen, mmut, rtmut;
  if (!q_clean) {
    phen  = await q("SELECT id, short_name, name, url FROM phenotype ORDER BY short_name");
    mmut  = await q(
      "SELECT id, locus, dz, allele, position, refna AS ref, regna AS alt, aa, homo, hetero, status, cfrm_date " +
      "FROM mmutation ORDER BY position");
    rtmut = await q(
      "SELECT id, locus, dz, allele, position, refna AS ref, regna AS alt, rna, homo, hetero, status, cfrm_date " +
      "FROM rtmutation ORDER BY position");
  } else {
    const like = `%${q_clean}%`;
    phen = await q(
      "SELECT id, short_name, name, url FROM phenotype " +
      "WHERE name LIKE ? OR short_name LIKE ? OR note LIKE ? ORDER BY short_name",
      [like, like, like]);
    mmut = await q(
      "SELECT id, locus, dz, allele, position, refna AS ref, regna AS alt, aa, homo, hetero, status, cfrm_date " +
      "FROM mmutation WHERE dz LIKE ? ORDER BY position LIMIT ?", [like, limit]);
    rtmut = await q(
      "SELECT id, locus, dz, allele, position, refna AS ref, regna AS alt, rna, homo, hetero, status, cfrm_date " +
      "FROM rtmutation WHERE dz LIKE ? ORDER BY position LIMIT ?", [like, limit]);
  }
  const mrefs = await _refs_for_mmut_ids(mmut.map(r => r.id));
  const rrefs = await _refs_for_rtmut_ids(rtmut.map(r => r.id));
  for (const m of mmut)  m.references = mrefs[m.id]  || [];
  for (const m of rtmut) m.references = rrefs[m.id] || [];
  return { query: q_clean, phenotypes: phen, mmutation: mmut, rtmutation: rtmut };
}

// ---------------------------------------------------------------------------
// /api/lookup/structural
// ---------------------------------------------------------------------------
async function ep_structural(params) {
  const want = (params.type || "all").toLowerCase();
  let start = params.start != null && params.start !== "" ? +params.start : null;
  let end   = params.end   != null && params.end   !== "" ? +params.end   : null;
  const pos = params.pos   != null && params.pos   !== "" ? +params.pos   : null;
  const locusName = params.locus || null;
  const limit = Math.max(1, Math.min(5000, +(params.limit || 500)));

  if (locusName && (start == null || end == null)) {
    const L = await _resolve_locus(locusName);
    if (!L) throw httpErr(404, `Unknown locus: ${locusName}`);
    if (start == null) start = L.starting;
    if (end   == null) end   = L.ending;
  }
  if (start != null && end != null && start > end) [start, end] = [end, start];

  const result = { filter: { type: want, start, end, pos, locus: locusName }, counts: {} };

  // deletion
  if (want === "deletion" || want === "all") {
    const rows = await q(
      "SELECT id, del, size, repeat, reploc, n, repeat2, reploc2, repeat3, reploc3, " +
      "repeat4, reploc4, startpos, endpos FROM deletion ORDER BY startpos");
    const filt = [];
    for (const r of rows) {
      const s = r.startpos, e = r.endpos;
      if (start != null && end != null && !_overlap(s, e, start, end)) continue;
      if (pos   != null && (s == null || e == null || !(s <= pos && pos <= e))) continue;
      filt.push(r);
    }
    const ids = filt.slice(0, limit).map(r => r.id);
    const refs = await _refs_for("deletion_reference", "deletion_id", ids);
    for (const r of filt.slice(0, limit)) r.references = refs[r.id] || [];
    result.deletion = filt.slice(0, limit);
    result.counts.deletion = filt.length;
  }

  // mdeletion
  if (want === "mdeletion" || want === "all") {
    const rows = await q(
      "SELECT id, size, del, repeat, reploc, ptid, repeat2, reploc2, " +
      "repeat3, reploc3, repeat4, reploc4 FROM mdeletion ORDER BY id");
    const sr = await q(
      "SELECT ms.mdeletion_id AS mid, s.startpos, s.endpos " +
      "FROM mdeletion_seqrange ms JOIN seqrange s ON s.id = ms.seqrange_id");
    const ranges = {};
    for (const row of sr) {
      if (!ranges[row.mid]) ranges[row.mid] = [];
      ranges[row.mid].push({ startpos: row.startpos, endpos: row.endpos });
    }
    const filt = [];
    for (const r of rows) {
      const rngs = ranges[r.id] || [];
      r.ranges = rngs;
      if (start != null && end != null) {
        if (!rngs.some(x => _overlap(x.startpos, x.endpos, start, end))) continue;
      }
      if (pos != null) {
        if (!rngs.some(x => x.startpos != null && x.endpos != null && x.startpos <= pos && pos <= x.endpos)) continue;
      }
      filt.push(r);
    }
    const ids = filt.slice(0, limit).map(r => r.id);
    const refs = await _refs_for("mdeletion_reference", "mdeletion_id", ids);
    for (const r of filt.slice(0, limit)) r.references = refs[r.id] || [];
    result.mdeletion = filt.slice(0, limit);
    result.counts.mdeletion = filt.length;
  }

  // insertion
  if (want === "insertion" || want === "all") {
    const rows = await q(
      'SELECT id, parentmol, inssize, "insert" AS insert_seq, insertpt, repeats, n, ' +
      'range_start, range_end FROM insertion ORDER BY id');
    const filt = [];
    for (const r of rows) {
      const s = r.range_start, e = r.range_end;
      if (start != null && end != null) {
        if (s == null || e == null || !_overlap(s, e, start, end)) continue;
      }
      if (pos != null) {
        if (s == null || e == null || !(s <= pos && pos <= e)) continue;
      }
      filt.push(r);
    }
    const ids = filt.slice(0, limit).map(r => r.id);
    const refs = await _refs_for("insertion_reference", "insertion_id", ids);
    for (const r of filt.slice(0, limit)) r.references = refs[r.id] || [];
    result.insertion = filt.slice(0, limit);
    result.counts.insertion = filt.length;
  }

  // rearrangement
  if (want === "rearrangement" || want === "all") {
    const hasPosFilter = (start != null && end != null) || pos != null;
    if (hasPosFilter) {
      result.rearrangement = [];
      result.counts.rearrangement = 0;
      result.rearrangement_note =
        "rearrangements have no structured positional coordinates; " +
        "remove start/end/pos/locus filters to view them";
    } else {
      const rows = await q(
        'SELECT id, parentmol, inssize, species, "insert" AS insert_seq, repeats, n ' +
        'FROM rearrangement ORDER BY id');
      const ids = rows.slice(0, limit).map(r => r.id);
      const refs = await _refs_for("rearrangement_reference", "rearrangement_id", ids);
      for (const r of rows.slice(0, limit)) r.references = refs[r.id] || [];
      result.rearrangement = rows.slice(0, limit);
      result.counts.rearrangement = rows.length;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// POST /api/lookup/variants
// ---------------------------------------------------------------------------
async function ep_variants(body) {
  const raw = (body && body.variants) || [];
  if (!Array.isArray(raw)) throw httpErr(400, "variants must be a list");
  if (raw.length > 5000)   throw httpErr(400, "too many variants (max 5000)");

  const keys = raw.map(v => {
    try {
      const p = parseInt(v.pos, 10);
      const r = String(v.ref || "").toUpperCase().trim();
      const a = String(v.alt || "").toUpperCase().trim();
      return (p >= 1 && p <= 16569 && r && a) ? [p, r, a] : null;
    } catch { return null; }
  });
  if (!keys.some(Boolean)) return { variants: keys.map(() => null) };

  const uniqMap = new Map();
  for (const k of keys) if (k) uniqMap.set(k.join("|"), k);
  const unique = [...uniqMap.values()].sort((a, b) =>
    a[0] - b[0] || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]));

  const rowsByKey = new Map();
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "(?, ?, ?)").join(",");
    const params = [];
    for (const [p, r, a] of chunk) params.push(p, r, a);
    const sql =
      `WITH q(position, ref, alt) AS (VALUES ${placeholders})\n` +
      `SELECT  q.position    AS position,
               q.ref         AS ref,
               q.alt         AS alt,
               poly.aachange AS aachange,
               a.score       AS apogee_score,
               a.status      AS apogee_status,
               mt.mitotip_score AS mitotip_score,
               mt.quartile      AS mitotip_quartile,
               mt.mitomap_status AS mitotip_mitomap_status,
               g.af_hom      AS gnomad_af_hom,
               g.af_het      AS gnomad_af_het,
               g.ac_hom      AS gnomad_ac_hom,
               g.ac_het      AS gnomad_ac_het,
               g.an          AS gnomad_an,
               g.filters     AS gnomad_filters,
               h.af_hom      AS helix_af_hom,
               h.af_het      AS helix_af_het,
               vc.fl_count   AS fl_count,
               vc.cr_count   AS cr_count,
               (SELECT COUNT(*) FROM mmutation  m WHERE m.position=q.position AND m.refna=q.ref AND m.regna=q.alt) AS n_mmutation,
               (SELECT COUNT(*) FROM rtmutation r WHERE r.position=q.position AND r.refna=q.ref AND r.regna=q.alt) AS n_rtmutation,
               (SELECT GROUP_CONCAT(status, '|') FROM (
                   SELECT status FROM mmutation  WHERE position=q.position AND refna=q.ref AND regna=q.alt
                   UNION ALL
                   SELECT status FROM rtmutation WHERE position=q.position AND refna=q.ref AND regna=q.alt
               )) AS dz_statuses,
               (SELECT GROUP_CONCAT(dz, ' | ') FROM (
                   SELECT dz FROM mmutation  WHERE position=q.position AND refna=q.ref AND regna=q.alt
                   UNION ALL
                   SELECT dz FROM rtmutation WHERE position=q.position AND refna=q.ref AND regna=q.alt
               )) AS dz_names,
               (SELECT name FROM locus
                 WHERE starting <= q.position AND ending >= q.position
                 ORDER BY (ending - starting) LIMIT 1) AS locus
       FROM q
       LEFT JOIN polymorphism   poly ON poly.position=q.position AND poly.refna=q.ref AND poly.regna=q.alt
       LEFT JOIN apogee         a  ON a.position=q.position    AND a.refna=q.ref    AND a.regna=q.alt
       LEFT JOIN mitotip_scores mt ON mt.position=q.position   AND mt.rcrs =q.ref   AND mt.alt =q.alt
       LEFT JOIN gnomad         g  ON g.position=q.position    AND g.refna=q.ref    AND g.regna=q.alt
       LEFT JOIN helix          h  ON h.position=q.position    AND h.refna=q.ref    AND h.regna=q.alt
       LEFT JOIN variants_count vc ON vc.tpos=q.position       AND vc.tnt =q.ref    AND vc.qnt =q.alt`;
    const rows = await q(sql, params);
    for (const r of rows) rowsByKey.set(`${r.position}|${r.ref}|${r.alt}`, r);
  }
  return { variants: keys.map(k => k ? (rowsByKey.get(k.join("|")) || null) : null) };
}

// ---------------------------------------------------------------------------
// Admin / dev endpoints (Browse, SQL, About)
// ---------------------------------------------------------------------------
async function ep_db_info() {
  let latest = null, per_table = [];
  try {
    latest    = await scalar("SELECT MAX(date) FROM edit_date");
    per_table = await q("SELECT table_name, MAX(date) AS date FROM edit_date GROUP BY table_name ORDER BY 2 DESC");
  } catch { /* edit_date table may be absent in some db builds */ }
  const tables = await q("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  return { latest_date: latest, tables: tables[0]?.n || 0, rows_total: 0, per_table };
}

async function ep_tables() {
  const tables = await q(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  // rows count is expensive; report 0 to keep startup fast (sidebar shows N/A)
  return tables.map(t => ({ name: t.name, rows: 0, n_columns: 0 }));
}

function _qident(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }
const _DISALLOWED = /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i;

async function ep_table_rows(name, params) {
  const limit  = Math.max(1, Math.min(1000, +(params.limit  || 50)));
  const offset = Math.max(0, +(params.offset || 0));
  const search = params.search || null;
  const orderBy = params.order_by || null;
  const orderDir = (params.order_dir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

  const cols = (await q(`PRAGMA table_info(${_qident(name)})`)).map(r => r.name);
  if (!cols.length) throw httpErr(404, `Unknown table: ${name}`);

  let where = "";
  const args = [];
  if (search) {
    where = " WHERE " + cols.map(c => `CAST(${_qident(c)} AS TEXT) LIKE ?`).join(" OR ");
    for (const _ of cols) args.push(`%${search}%`);
  }
  let order = "";
  if (orderBy && cols.includes(orderBy)) order = ` ORDER BY ${_qident(orderBy)} ${orderDir}`;

  const total = await scalar(`SELECT COUNT(*) FROM ${_qident(name)}${where}`, args);
  const rows  = await q(`SELECT * FROM ${_qident(name)}${where}${order} LIMIT ? OFFSET ?`, [...args, limit, offset]);
  return { table: name, total, limit, offset, columns: cols, rows };
}

async function ep_query(body) {
  let sql = String(body.sql || "").trim().replace(/;+\s*$/, "").trim();
  const limit = Math.max(1, Math.min(5000, +(body.limit || 500)));
  if (!sql) throw httpErr(400, "Empty query");
  if (sql.includes(";")) throw httpErr(400, "Multiple statements not allowed");
  if (_DISALLOWED.test(sql)) throw httpErr(400, "Only read-only SELECT/WITH queries are allowed");
  const head = sql.split(/\s+/, 1)[0].toUpperCase();
  if (head !== "SELECT" && head !== "WITH") throw httpErr(400, "Query must start with SELECT or WITH");
  const wrapped = `SELECT * FROM (${sql}) LIMIT ${limit}`;
  const rows = await q(wrapped);
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { columns, rows, row_count: rows.length, limit };
}

// ---------------------------------------------------------------------------
// Dispatcher (window.__api)
// ---------------------------------------------------------------------------
function httpErr(status, msg) { const e = new Error(`${status}: ${msg}`); e.status = status; return e; }

function parsePath(path) {
  const i = path.indexOf("?");
  const base = i >= 0 ? path.slice(0, i) : path;
  const qs = i >= 0 ? path.slice(i + 1) : "";
  const params = {};
  if (qs) for (const [k, v] of new URLSearchParams(qs)) params[k] = v;
  return { base, params };
}

async function dispatch(path, opts) {
  const { base, params } = parsePath(path);
  const method = (opts && opts.method ? opts.method : "GET").toUpperCase();
  let body = null;
  if (opts && opts.body) {
    try { body = typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body; }
    catch { body = null; }
  }

  // Lookup endpoints
  if (base === "/api/lookup/loci")              return ep_loci();
  if (base === "/api/lookup/region")            return ep_region(params);
  if (base === "/api/lookup/position")          return ep_position(params);
  if (base === "/api/lookup/position/neighbors")return ep_position_neighbors(params);
  if (base === "/api/lookup/phenotypes")        return ep_phenotypes();
  if (base === "/api/lookup/disease")           return ep_disease(params);
  if (base === "/api/lookup/structural")        return ep_structural(params);
  if (base === "/api/lookup/variants" && method === "POST") return ep_variants(body || {});

  // Admin / Browse / SQL
  if (base === "/api/db_info") return ep_db_info();
  if (base === "/api/tables")  return ep_tables();
  if (base === "/api/query" && method === "POST") return ep_query(body || {});
  const mTbl = base.match(/^\/api\/tables\/([^/]+)\/rows$/);
  if (mTbl) return ep_table_rows(decodeURIComponent(mTbl[1]), params);

  throw httpErr(404, `No static handler for ${method} ${base}`);
}

window.__api = dispatch;

// ---------------------------------------------------------------------------
// Boot the UI once the worker is ready.
// ---------------------------------------------------------------------------
async function bootUi() {
  // Warm the worker (downloads the db header + first pages).
  const status = document.getElementById("status");
  if (status) status.textContent = "loading database…";
  try {
    await getWorker();
  } catch (e) {
    if (status) status.textContent = "DB load failed: " + e.message;
    throw e;
  }
  if (window.loadTables) {
    try { await window.loadTables(); }
    catch (e) { if (status) status.textContent = "Error: " + e.message; }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { bootUi(); });
} else {
  bootUi();
}
