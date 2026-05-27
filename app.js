"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  tables: [],
  current: null,         // table name
  offset: 0,
  limit: 50,
  search: "",
  orderBy: null,
  orderDir: "asc",
  total: 0,
};

// api() is supplied by static_api.js (window.__api) so the same call sites work
// without a backend server.  We keep the same signature: api(path, opts?).
async function api(path, opts) {
  if (!window.__api) throw new Error("static_api.js not ready");
  return window.__api(path, opts);
}

function fmtCell(v) {
  if (v === null || v === undefined) return '<span class="null">NULL</span>';
  const s = String(v);
  return s.length > 200 ? escapeHtml(s.slice(0, 200)) + "…" : escapeHtml(s);
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderGrid(targetEl, columns, rows, opts = {}) {
  if (!rows.length) {
    targetEl.innerHTML = '<p class="muted" style="padding:12px">No rows.</p>';
    return;
  }
  const headHtml = columns.map((c) => {
    const sortable = opts.sortable;
    const arrow = state.orderBy === c ? (state.orderDir === "asc" ? " ▲" : " ▼") : "";
    return `<th data-col="${escapeHtml(c)}" ${sortable ? 'class="sortable"' : ""}>${escapeHtml(c)}${arrow}</th>`;
  }).join("");
  const bodyHtml = rows.map((r) =>
    "<tr>" + columns.map((c) => `<td>${fmtCell(r[c])}</td>`).join("") + "</tr>"
  ).join("");
  targetEl.innerHTML = `<table class="grid"><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
  if (opts.sortable) {
    targetEl.querySelectorAll("th").forEach((th) => {
      th.addEventListener("click", () => {
        const col = th.dataset.col;
        if (state.orderBy === col) state.orderDir = state.orderDir === "asc" ? "desc" : "asc";
        else { state.orderBy = col; state.orderDir = "asc"; }
        state.offset = 0;
        loadRows();
      });
    });
  }
}

// ---------- Tables sidebar ----------
async function loadTables() {
  state.tables = await api("/api/tables");
  renderTableList();
  let dateLabel = "";
  try {
    const info = await api("/api/db_info");
    if (info.latest_date) dateLabel = ` · MITOMAP data updated ${info.latest_date}`;
    window.__DB_INFO = info;
  } catch (_) {}
  $("status").textContent = dateLabel ? dateLabel.replace(/^ \u00b7 /, "") : "";
}
function renderTableList() {
  const q = $("tableFilter").value.toLowerCase();
  const ul = $("tableList");
  ul.innerHTML = "";
  for (const t of state.tables) {
    if (q && !t.name.toLowerCase().includes(q)) continue;
    const li = document.createElement("li");
    if (t.name === state.current) li.classList.add("active");
    li.innerHTML = `<span>${escapeHtml(t.name)}</span><span class="count">${t.rows.toLocaleString()}</span>`;
    li.addEventListener("click", () => selectTable(t.name));
    ul.appendChild(li);
  }
}

function selectTable(name) {
  state.current = name;
  state.offset = 0;
  state.search = "";
  state.orderBy = null;
  state.orderDir = "asc";
  $("searchBox").value = "";
  $("browseTitle").textContent = name;
  renderTableList();
  loadRows();
}

async function loadRows() {
  if (!state.current) return;
  const params = new URLSearchParams({
    limit: state.limit, offset: state.offset,
  });
  if (state.search) params.set("search", state.search);
  if (state.orderBy) { params.set("order_by", state.orderBy); params.set("order_dir", state.orderDir); }
  const grid = $("grid");
  grid.innerHTML = '<p class="muted" style="padding:12px">Loading…</p>';
  try {
    const data = await api(`/api/tables/${encodeURIComponent(state.current)}/rows?${params}`);
    state.total = data.total;
    renderGrid(grid, data.columns, data.rows, { sortable: true });
    const last = Math.min(state.offset + data.rows.length, state.total);
    $("pageInfo").textContent = `${state.offset + 1}–${last} of ${state.total.toLocaleString()}`;
  } catch (e) {
    grid.innerHTML = `<p class="muted" style="padding:12px;color:#b91c1c">${escapeHtml(e.message)}</p>`;
  }
}

// ---------- Pagination + search ----------
$("prevBtn").addEventListener("click", () => { state.offset = Math.max(0, state.offset - state.limit); loadRows(); });
$("nextBtn").addEventListener("click", () => {
  if (state.offset + state.limit < state.total) { state.offset += state.limit; loadRows(); }
});
$("pageSize").addEventListener("change", (e) => { state.limit = parseInt(e.target.value, 10); state.offset = 0; loadRows(); });
let searchTimer = null;
$("searchBox").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.search = e.target.value.trim(); state.offset = 0; loadRows(); }, 250);
});
$("tableFilter").addEventListener("input", renderTableList);

// ---------- Tabs ----------
const TABS = ["position", "region", "disease", "structural", "report", "about"];
TABS.forEach((t) => {
  const el = $(`tab-${t}`);
  if (el) el.addEventListener("click", () => switchTab(t));
});
function switchTab(which) {
  for (const t of TABS) {
    const btn = $(`tab-${t}`);
    if (btn) btn.classList.toggle("active", t === which);
    const sec = $(t);
    if (sec) sec.classList.toggle("hidden", t !== which);
  }
  // Sidebar no longer used.
  const showSidebar = false;
  const side = $("sidebar");
  if (side) side.style.display = showSidebar ? "" : "none";
  document.body.classList.toggle("no-sidebar", !showSidebar);
  if (window.__onTabChange) window.__onTabChange(which);
}

// ---------- SQL ----------
$("runSqlBtn").addEventListener("click", runSql);
$("sqlInput").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runSql(); }
});
async function runSql() {
  const sql = $("sqlInput").value.trim();
  const limit = parseInt($("sqlLimit").value, 10);
  const msg = $("sqlMsg");
  const grid = $("sqlGrid");
  msg.classList.remove("err"); msg.textContent = "Running…"; grid.innerHTML = "";
  if (!sql) { msg.textContent = ""; return; }
  try {
    const t0 = performance.now();
    const data = await api("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql, limit }),
    });
    const dt = ((performance.now() - t0) / 1000).toFixed(2);
    msg.textContent = `${data.row_count.toLocaleString()} rows (cap ${data.limit}) in ${dt}s`;
    renderGrid(grid, data.columns, data.rows);
  } catch (e) {
    msg.classList.add("err"); msg.textContent = e.message;
  }
}

// ---------- Boot ----------
// In static mode boot is deferred until static_api.js has the sqlite worker
// ready.  Expose loadTables so the shim can invoke it.
window.loadTables = loadTables;
