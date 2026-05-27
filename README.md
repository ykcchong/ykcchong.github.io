# MITOMAP Explorer — purely static build

This directory is a **server-less** mirror of `app/static/` plus a JavaScript
shim (`static_api.js`) that re-implements every endpoint normally served by
FastAPI (`app/views.py` + `app/main.py`).

The whole app runs inside the browser:

```
index.html ─► static_api.js ─► sql.js-httpvfs (Web Worker + WASM)
                                     │
                                     └─► HTTP Range requests
                                         to mitomap.sqlite
```

`sql.js-httpvfs` only fetches the SQLite pages it actually needs to answer the
current query, so the 465 MB database does **not** have to be downloaded in
full — typically a few hundred KB per page view.

## Endpoints reimplemented

Every URL the existing `app.js` / `views.js` call has a JS handler:

| Path                                  | Handler in static_api.js |
|---------------------------------------|--------------------------|
| `GET  /api/lookup/loci`               | `ep_loci`                |
| `GET  /api/lookup/region`             | `ep_region`              |
| `GET  /api/lookup/position`           | `ep_position`            |
| `GET  /api/lookup/position/neighbors` | `ep_position_neighbors`  |
| `GET  /api/lookup/phenotypes`         | `ep_phenotypes`          |
| `GET  /api/lookup/disease`            | `ep_disease`             |
| `GET  /api/lookup/structural`         | `ep_structural`          |
| `POST /api/lookup/variants`           | `ep_variants` (Report)   |
| `GET  /api/db_info`                   | `ep_db_info`             |
| `GET  /api/tables`                    | `ep_tables`              |
| `GET  /api/tables/{name}/rows`        | `ep_table_rows`          |
| `POST /api/query`                     | `ep_query`               |

## Quick start (local test)

The page **must** be served over HTTP (not `file://`) because the worker uses
`fetch()` + `Range:` headers.

```powershell
# 1) place the sqlite db next to index.html (or set window.__MITOMAP_STATIC_CFG__.dbUrl)
copy ..\db\mitomap.sqlite .\mitomap.sqlite

# 2) serve the folder
python -m http.server 8080
```

Then open <http://localhost:8080/>.

> The `requestChunkSize` (default **4096 bytes** = one SQLite page) keeps memory
> low and lets you point at the raw file without any pre-processing.  Any
> static host that supports HTTP `Range` works (GitHub Pages, S3, Netlify,
> Cloudflare R2, plain nginx).

## Deploying to a static host

1. Upload **everything in this directory** plus **`mitomap.sqlite`** to the
   host.
2. Verify Range support — `curl -I -H "Range: bytes=0-3" https://host/mitomap.sqlite`
   should return `HTTP/1.1 206 Partial Content`.
3. (Optional) tune `requestChunkSize` / `maxBytesToRead` by uncommenting the
   `window.__MITOMAP_STATIC_CFG__` block at the top of `index.html`.

## Optional: pre-split the database for slow networks

For very large DBs or strict CDNs you can split the sqlite into fixed-size
chunks using the upstream `create-db` helper.  That mode is not enabled here
(we use single-file `serverMode: "full"`).  See
<https://github.com/phiresky/sql.js-httpvfs> if you need it.

## Files

| File              | Notes                                                 |
|-------------------|-------------------------------------------------------|
| `index.html`      | Identical layout to `app/static/index.html` with relative URLs and the static shim wired in. |
| `style.css`       | Verbatim copy of `app/static/style.css`.              |
| `app.js`          | Copy of `app/static/app.js` with two patches: `api()` delegates to `window.__api`; auto-boot of `loadTables()` is deferred until the worker is ready. |
| `views.js`        | Verbatim copy of `app/static/views.js`.               |
| `static_api.js`   | The ES-module shim. Boots sql.js-httpvfs, registers `window.__api`, then calls `loadTables()`. |
| `sqlite.worker.js`| Vendored copy of `sql.js-httpvfs` worker — **must be same-origin** (browsers refuse cross-origin Web Workers). |
| `sql-wasm.wasm`   | Vendored copy of the SQLite WASM binary, loaded by the worker. |

### Deploying to GitHub Pages

Everything in this folder (including `sqlite.worker.js`, `sql-wasm.wasm`, and
`mitomap.sqlite`) must be pushed to the `gh-pages` branch / `docs/` folder and
sit at the **same origin** as `index.html`.  The library imports of
`sql.js-httpvfs` itself use jsdelivr's `+esm` redirect (which returns a real ES
module), but the worker and wasm cannot be loaded cross-origin and so are
vendored here.

## Re-syncing after backend changes

When you edit `app/static/style.css` or `app/static/views.js` upstream, just
re-copy them into this folder:

```powershell
Copy-Item ..\app\static\style.css .\style.css -Force
Copy-Item ..\app\static\views.js  .\views.js  -Force
```

`app.js` is intentionally divergent (see patches above), so re-apply them by
hand if you change it upstream.  `static_api.js` mirrors `app/views.py`; any
backend SQL change must be reflected here too.

## Caveats

- The Browse and SQL tabs are hidden by default (same as the FastAPI build),
  but their handlers are implemented and can be exposed by removing the
  `hidden` attribute on the corresponding `<button id="tab-browse" ...>` and
  `<button id="tab-sql" ...>` elements.
- `ep_db_info` counts tables via `sqlite_master` and reads `edit_date` if the
  table exists; `rows_total` is reported as 0 (was sourced from the build-time
  MANIFEST in the FastAPI build).
- `ep_tables` reports `rows: 0` to avoid 87 expensive `COUNT(*)` round-trips at
  page load; the Browse-tab sidebar will show `0` next to each table name.
- All SQL is read-only (`/api/query` rejects writes via the same regex used by
  the FastAPI backend).
