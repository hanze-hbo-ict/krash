# Krash

**A little room for PostgreSQL.** Krash is a small, static, client-only PostgreSQL workbench in the same family as
[Klode](https://klode.app) (Python) and [Kopje](https://kopje.pages.dev) (Java).

A real PostgreSQL engine ([PGlite](https://pglite.dev)) runs inside the browser tab. You write SQL in a few query tabs,
run it, and inspect results, errors and the schema. You can paste a SQL script to import it as the database to work on. There is
no backend, no login, no telemetry, no code completion and no AI assistance.

Live: <https://krash.pages.dev>

---

## Quick start

Requires Node.js 20+ and npm.

```sh
npm ci
npm run dev          # http://localhost:5173
npm test             # unit + integration tests (Vitest, real PGlite in Node)
npm run build        # production build in dist/ (also regenerates THIRD_PARTY_NOTICES.txt)
npm run preview      # serve dist/ with the production security headers
```

End-to-end tests (Playwright; first run `npx playwright install chromium firefox webkit`):

```sh
npm run test:e2e                         # builds, serves with `vite preview`, runs all browsers
npx playwright test --project=firefox    # a single browser
KRASH_E2E_DEV=1 npx playwright test tests/e2e/spike.spec.ts   # PGlite spike, against the dev server
```

## Using Krash

- **One query editor.** Keep several statements in it and run them one at a time by selecting them.
- **Run.** Ctrl/⌘ + Enter or **Run** runs the selection, or the whole query if nothing is selected.
- **Database pane.** A read-only tree of databases, schemas, tables and columns, plus three actions in its header:
  - **Reset** restores the last imported database. Until something is imported, that is the default database.
  - **Clear** clears the whole workspace: it deletes the query and this tab's database and starts fresh with the default
    database.
  - **Import** takes a pasted SQL script: the current database is cleared and the script is run on an empty database.
- **Default database.** It is deliberately tiny: one table, `people`, with three rows (`src/db/default.sql`). Import a script to replace it.
- **Databases in an import.** An import script can define its own databases, as with `psql -f` and a `\c` after every
  `CREATE DATABASE`:
  - statements before the first `CREATE DATABASE` run in `postgres`;
  - each `CREATE DATABASE name;` creates that database and connects to it, so the statements after it run there;
  - when the import finishes, you are connected to the last database the script used.
- **Which databases are shown.** The pane lists the databases the import touched, plus those you create from the
  editor. `postgres` is listed only if the script ran statements in it. A `CREATE DATABASE` from the editor must be a
  Run of its own (a PostgreSQL rule); it does not connect automatically.
- **Switching.** With two or more databases listed, click one to connect to it. Krash has one connection, so only the
  connected database shows its schemas. Switching reopens the engine, like psql's `\c`: committed data stays, and an
  open transaction is discarded (Krash asks first). Krash remembers the connected database across reloads.

## Deployment

`npm run build` produces a fully static `dist/` folder with relative paths (`base: './'`), so it can be hosted on any
static server or sub-path. All JavaScript, CSS, WebAssembly and data files are self-hosted; the app makes no requests
to other origins (an E2E test checks this).

- **GitHub Actions → Cloudflare Pages.** `.github/workflows/deploy.yml` runs the unit and integration tests, builds,
  and deploys with wrangler. Pushes to `main` go to production; pull requests from this repository get a preview. It
  needs the repository secrets `CLOUDFLARE_API_TOKEN` (Cloudflare Pages: Edit) and `CLOUDFLARE_ACCOUNT_ID`.
- **Security headers.** `public/_headers` (Netlify / Cloudflare Pages format) sets a strict Content-Security-Policy,
  `nosniff`, `no-referrer` and COOP. Configure the equivalent headers on other servers. The `<meta>` CSP that the build
  injects into `index.html` protects only the page; **the database worker is only covered by the HTTP header.**
  The policy needs `'wasm-unsafe-eval'` (WebAssembly) and `style-src 'unsafe-inline'` (CodeMirror injects style
  elements); it does not need `'unsafe-eval'`. `vite preview` sends the same headers, so the E2E suite runs under them.
- **MIME types.** Serve `.wasm` as `application/wasm`.
- **Size.** The first load is about 16 MB (9 MB WASM, 6 MB data, about 1 MB JS/CSS). `/assets/*` files are
  content-hashed and cached as immutable.
- **Offline.** No service worker is included.

## Architecture

```text
 UI thread (React)                                   Dedicated worker (one per browser tab)
 ┌──────────────────────────────┐   typed requests   ┌─────────────────────────────────────────┐
 │ App · SqlEditor (CodeMirror) │ ─────────────────▶ │ db.worker.ts  (serial request queue)    │
 │ SchemaTree · ResultsPanel    │   id-matched       │  └ engine.ts: execute / introspect /    │
 │ Dialogs · Splitter           │ ◀───────────────── │     seed / dataset marker               │
 │ workspace/* (sessionStorage) │   responses        │  └ PGlite 0.5.13 (PostgreSQL 18, WASM)  │
 └──────────────────────────────┘                    │     └ IndexedDB  /pglite/krash-<s>-<g>  │
                                                     └─────────────────────────────────────────┘
```

| Path | Role |
| --- | --- |
| `src/db/protocol.ts` | Typed request/response messages; errors travel as serialisable `WorkerFailure`/`PgError` values. |
| `src/db/dbClient.ts` | Main-thread client: unique request ids, crash detection, hard **Stop** (terminate worker). |
| `src/db/db.worker.ts` | Owns the single PGlite instance; processes requests strictly in order. |
| `src/db/engine.ts` | Script execution, type-name resolution, schema introspection, seeding and validation. |
| `src/db/wire.ts` | Streaming PostgreSQL protocol reader with row/cell/result limits. |
| `src/db/sqlLexer.ts` | Tiny lexer used to refuse `COPY … FROM STDIN` and to split imports at `CREATE DATABASE`, plus position → line/column helpers. |
| `src/db/default.sql` | The default database. |
| `src/workspace/*` | Session persistence, base dataset (default or imported), session lock. |
| `src/components/*` | Focused UI components. `src/styles/tokens.css` holds all design tokens. |

### Key decisions

These were validated in the PGlite spike (`spike/`, `tests/e2e/spike.spec.ts`) before the UI was built.

1. **PGlite in a dedicated worker, pinned to `@electric-sql/pglite@0.5.13`** (PostgreSQL 18.6). It boots in about
   1 s. All database work goes through the worker, so the UI never blocks.
2. **Scripts run through the simple-query protocol and are decoded by our own streaming reader**, not `exec()`.
   `exec()` throws on the first error and discards the results of statements that already completed, and it turns
   every row into a JS object. Krash sends the text unchanged as one simple-query message (what `psql -c` and
   pgAdmin's query tool send), and PostgreSQL does the statement splitting. The reader in `wire.ts`:
   - keeps up to 1000 rows per statement and counts the rest without decoding them, so huge results never freeze the
     page and the true row count is always shown;
   - reports the results of statements that completed before an error, the failing statement number, notices and
     `COPY … TO STDOUT` output;
   - shows values **exactly as PostgreSQL formats them as text**, like psql does. JavaScript never re-interprets
     booleans (`t`/`f`), `numeric` scale, dates, JSON, arrays, intervals or 64-bit integers. `NULL` looks different
     from the string `'NULL'`.

   The SQL is never rewritten, wrapped in a transaction or given a `LIMIT`.
3. **Transaction semantics are PostgreSQL's own.** A multi-statement Run is one implicit transaction: if statement 3
   fails, statements 1–2 are rolled back unless the script used `BEGIN`/`COMMIT`. A syntax error anywhere means
   nothing ran, because PostgreSQL parses the whole text first. Explicit transactions stay open across Runs, as in one
   psql session. The status shows *transaction open* or *transaction failed · ROLLBACK*.
4. **Cancellation restarts the worker.** `statement_timeout` does **not** fire in the single-threaded WASM build
   (verified), and a running query cannot be interrupted from JavaScript. **Stop** terminates the worker and reopens
   the same IndexedDB database in a new one. The interrupted Run and any open transaction are lost; committed data
   survives (E2E-tested). An unexpected engine crash is handled the same way.
5. **`COPY … FROM STDIN` is refused before execution.** In PGlite it hangs or aborts the engine (verified). A minimal
   lexer that skips strings, comments, quoted identifiers and dollar-quoted bodies detects it. The same lexer splits an
   import at top-level `CREATE DATABASE` statements. That is all the SQL analysis Krash does.
6. **Several databases, one connection.** PGlite has one connection per instance, and it can't start with a new
   database name or rename the current one (verified). An import therefore runs each `CREATE DATABASE` on its own,
   finds the new database in `pg_database`, and reopens the same storage connected to it, like psql's `\c`. A temporary
   in-memory cluster is copied to the new instance with `dumpDataDir`/`loadDataDir`. The dataset marker is a comment on
   `postgres`; database comments are cluster-wide, so it can be read from any database.
7. **Persistence.**
   - *The query text and UI preferences* live in `sessionStorage`, written about 400 ms after the last edit and read back to
     confirm. They survive a reload of the same tab, not a closed tab. The workspace heading shows *Saving…*,
     *Saved in this tab* or *Save failed*. Closing the tab while the editor contains SQL triggers the browser's
     leave-page warning.
   - *An imported script* is also kept in `sessionStorage`, up to 2 MB, so Reset and reload can rebuild it.
   - *The database* lives in IndexedDB under a per-session name `krash-<sessionId>-<generation>` (PGlite stores it as
     `/pglite/<name>`). IndexedDB was chosen over OPFS for Safari compatibility, and `relaxedDurability` stays off.
     On reload the same storage is reopened, connected to the last connected database, not re-seeded. The dataset
     marker detects a mismatch with the expected base. The shown databases and the connected one are kept in
     `sessionStorage`.
   - *Duplicated tabs* copy `sessionStorage`. A Web Lock per session detects the second tab. That tab gets its own new
     database and keeps a copy of the query. Two PGlite instances never write the same store.
   - *Cleanup.* IndexedDB is durable, not session-scoped. Each tab writes a heartbeat to `localStorage` once a minute.
     On startup Krash deletes old generations of its own session and the databases of sessions that have been silent
     for more than 12 hours.
8. **Reset and import swap only after validation.** Both build the next database generation from scratch and verify
   the dataset marker. Only then do they switch to it and delete the old one. Databases created from the editor are not
   part of the import, so Reset removes them. A failed reset or import (for example a
   script with an error) leaves the previous database in use; an import error is shown in the Import dialog so the script
   can be fixed.
9. **No assistance by construction.** The CodeMirror 6 editor has highlighting, line numbers, selection, undo/redo and
   bracket matching. There is no autocompletion, linting, auto-closing brackets or formatting (E2E-tested). The schema
   tree is read-only and never generates SQL.

## Design language

Krash reproduces the visible conventions of Klode and Kopje rather than their code. Header, footer, spacing and
breakpoints use Kopje's values:
- a quiet light workbench with an `k.` brand mark;
- Inter or the system sans for UI, and Cascadia Code or SF Mono for code;
- fine `#dfe4ec` borders and a 12 px panel radius;
- one blue accent (`#315ac6`), and a green **Run** that becomes a red **Stop** while running;
- icon actions with tooltips;
- status as a small coloured dot *plus* text.

Light and dark themes follow the OS, with a three-state override (system → light → dark). All values are CSS
variables in `src/styles/tokens.css`.

## Accessibility

- Semantic landmarks and headings, a skip link, and visible focus everywhere.
- ARIA tabs with arrow-key navigation for statement results.
- A splitter between editor and results that works from the keyboard (`↑`/`↓`).
- Native `<dialog>` with focus return.
- Live-region announcements for run results and errors, and text next to every colour cue.
- axe-core reports no WCAG 2.1 AA violations in light or dark mode (E2E-tested).
- In the editor, Tab indents; press Esc and then Tab to leave it.

## Testing

| Suite | What |
| --- | --- |
| `tests/unit` | Wire protocol reader (chunking, limits, errors), lexer, names, session persistence and orphan detection, base dataset storage. |
| `tests/integration` | Real PGlite in Node against a realistic fixture (`tests/fixtures/webshop.sql`): seeding and marker, value formatting, multi-statement scripts, syntax and runtime errors, implicit and explicit transactions, joins/grouping/subqueries/CTEs/windows/views/DDL/DML, result bounding, `COPY` guard, notices, introspection. |
| `tests/e2e/app.spec.ts` | Fresh workspace, DDL, multi-statement scripts, errors, selection, reload persistence, isolation between browser tabs, duplicated tab, reset, import (including a failing import), huge results, Stop, no completion, `COPY`, transactions, no foreign requests, missing WASM, blocked storage. |
| `tests/e2e/a11y.spec.ts` | axe (light/dark), keyboard-only workflow, Clear workspace. |
| `tests/e2e/spike.spec.ts` | PGlite spike (dev server only). |

All suites pass in Chromium and WebKit. Firefox has not been run in the development environment; run
`npx playwright test --project=firefox`.

## Known limitations

- **Local storage is not a backup.** The query survives a reload of the same browser tab only; closing the tab loses it.
  Browsers and private windows can clear `sessionStorage` and IndexedDB at any time.
- **Cancellation** works only by restarting the engine (decision 4).
- **PostgreSQL coverage.** This is real PostgreSQL 18.6, single user and single connection, in WASM. Not available:
  - `COPY … FROM STDIN` and psql meta-commands (`\d`, `\copy`);
  - extensions (none are loaded);
  - server administration, and file-system or network access.

  `statement_timeout` has no effect.
- **Result limits.** At most 1000 rows per statement and 50 statement results per Run are kept, and cells are cut at
  10,000 characters. All of this is reported explicitly.
- **Imports** are limited to 2 MB.
- **First load** downloads about 16 MB.
- **Not tamper-proof.** Every shipped file is readable, and users control their browser.

## Repository layout

```text
src/app/          App orchestration, run records, message descriptions
src/components/   SqlEditor, SchemaTree, ResultsPanel, Splitter, Modal, Dialogs, Icon
src/db/           worker, client, protocol, engine, wire reader, lexer, storage names, default database
src/workspace/    types, sessionStore, sessionLock, baseDataset, names, ids
src/styles/       tokens.css, layout.css
tests/            unit/, integration/, e2e/, fixtures/
spike/            PGlite proof-of-concept scripts and page (not part of the build)
scripts/          licenses.mjs (generates public/THIRD_PARTY_NOTICES.txt)
```

## Credits and licenses

Built with [PGlite](https://pglite.dev) by Electric SQL (Apache-2.0, includes PostgreSQL under the PostgreSQL
License), [CodeMirror 6](https://codemirror.net) (MIT) and [React](https://react.dev) (MIT). `npm run build`
regenerates the full list in `public/THIRD_PARTY_NOTICES.txt`, which the app links from its footer. The visual
language is inspired by [Klode](https://github.com/hanze-hbo-ict/klode) and Kopje; no code or assets were copied.
