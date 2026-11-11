# Krash

**A little room for PostgreSQL.** Krash is a small, static, client-only PostgreSQL workbench for database
examinations, in the same family as [Klode](https://klode.app) (Python) and [Kopje](https://kopje.pages.dev) (Java).

Students inspect a supplied schema, write and run real PostgreSQL SQL in a few named answer tabs, read results and
errors, and export their answers as one `.sql` file to upload to the institution's exam platform.

Krash is a SQL workbench, **not** a learning platform, AI tutor, proctoring tool, or exam management system.
There is no backend, no login, no telemetry, no code completion and no AI assistance.

---

## Quick start

Requires Node.js 20+ (tested with Node 25) and npm.

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
KRASH_E2E_DEV=1 npx playwright test tests/e2e/spike.spec.ts   # Phase A spike, against the dev server
```

## Configuring an exam

An exam organiser edits two files before building. There is deliberately no authoring UI.

| File | What |
| --- | --- |
| `src/exam/examConfig.ts` | Title, `examId`, dataset id/version, expected tables, initial tab names, feature flags (`schemaBrowser`, `tablePreview`, `answerImport`, `answerExport`), `maxRows`, optional instructions text. `validateExamConfig()` is unit-tested. |
| `src/exam/seed.sql` | The canonical dataset: plain PostgreSQL DDL + data, applied once per fresh database. |

Change `dataset.id` whenever `seed.sql` changes: databases persisted under an older id are detected and the student
is offered **Reset database** (nothing is destroyed silently).

> **Everything shipped to the browser is readable by students**: the seed, the config, and every bundled file.
> Never put model answers or hidden assessment material in this repository's build.

## Deployment

`npm run build` produces a fully static `dist/` folder with relative paths (`base: './'`): host it on any static
web server or sub-path. All JavaScript, CSS, WebAssembly and data files are self-hosted; the app makes no requests
to other origins (an E2E test checks this).

- **Security headers.** `public/_headers` (Netlify / Cloudflare Pages format) sets a strict Content-Security-Policy,
  `nosniff`, `no-referrer` and COOP. Configure the equivalent headers on other servers. The `<meta>` CSP that the build
  injects into `index.html` protects only the page; **the database worker is only covered by the HTTP header.**
  The policy needs `'wasm-unsafe-eval'` (WebAssembly) and `style-src 'unsafe-inline'` (CodeMirror injects style
  elements); it does not need `'unsafe-eval'`. `vite preview` serves the same headers, so the E2E suite runs under them.
- **MIME types.** `.wasm` must be served as `application/wasm`. The `.data` file (PostgreSQL's file system, ~6 MB) can
  be served as `application/octet-stream`.
- **Size.** The first load is about 16 MB (9 MB WASM + 6 MB data + ~1 MB JS/CSS) and is cached by the browser
  afterwards (`/assets/*` are content-hashed and marked immutable).
- **Offline.** No service worker is included. After a first load, assets usually come from the HTTP cache, but this is
  not guaranteed. Run the institutional exam-machine test (below) under the actual network policy.

## Architecture

```text
 UI thread (React)                                   Dedicated worker (one per browser tab)
 ┌──────────────────────────────┐   typed requests   ┌─────────────────────────────────────────┐
 │ App · SqlEditor (CodeMirror) │ ─────────────────▶ │ db.worker.ts  (serial request queue)    │
 │ AnswerTabs · SchemaTree      │   id-matched       │  └ engine.ts: execute / introspect /    │
 │ ResultsPanel · Dialogs       │ ◀───────────────── │     seed / dataset marker               │
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
| `src/db/sqlLexer.ts` | Tiny lexer used **only** to refuse `COPY … FROM STDIN`, plus position → line/column helpers. |
| `src/workspace/*` | Answer documents, session persistence, export/import format, names, session lock. |
| `src/components/*` | Focused UI components. `src/styles/tokens.css` holds all design tokens. |

### Key decisions

These were validated in the Phase A spike (`spike/`, `tests/e2e/spike.spec.ts`) before the UI was built.

1. **PGlite in a dedicated worker, pinned to `@electric-sql/pglite@0.5.13`** (PostgreSQL 18.6). It boots in about 1 s
   and seeds the dataset in well under a second. All database work goes through the worker; the UI never blocks.
2. **Scripts run through the simple-query protocol, decoded by our own streaming reader**, not `exec()`. The spike
   showed that `exec()` throws on the first error and discards the results of statements that already completed, and
   that it turns every row into a JS object. Krash sends the student's text unchanged as one simple-query message
   (exactly what `psql -c` or pgAdmin's query tool send); PostgreSQL does the statement splitting. The reader in
   `wire.ts` then:
   - keeps up to `maxRows` (default 1000) rows per statement and counts the rest without decoding them, so huge results
     never freeze the page and the true row count is always shown;
   - reports results of statements that completed before an error, the failing statement number, notices and
     `COPY … TO STDOUT` output;
   - shows values **exactly as PostgreSQL formats them as text** (like psql): `t`/`f`, `numeric` scale, dates, JSON,
     arrays, intervals and 64-bit integers are never re-interpreted by JavaScript. `NULL` is visually distinct from
     the string `'NULL'`.

   The SQL is never rewritten, wrapped in a transaction or given a `LIMIT`.
3. **Transaction semantics are PostgreSQL's own.** A multi-statement Run is one implicit transaction: if statement 3
   fails, statements 1–2 are rolled back unless the script used `BEGIN`/`COMMIT`. A syntax error anywhere means nothing
   ran, because PostgreSQL parses the whole text first. Explicit transactions stay open across Runs, like one psql
   session, and the status shows *transaction open* or *transaction failed · ROLLBACK*. Krash explains partial
   execution honestly in the error box.
4. **Cancellation means restarting the worker.** `statement_timeout` does **not** fire in the single-threaded WASM
   build (verified: a 60-second query ignored a 500 ms timeout), and a running query cannot be interrupted from
   JavaScript. **Stop** therefore terminates the worker and reopens the same IndexedDB database in a new one. The
   interrupted Run and any open transaction are lost; committed data survives (E2E-tested). An unexpected engine
   crash is handled the same way. Krash promises no other cancellation.
5. **`COPY … FROM STDIN` is refused before execution.** In PGlite it hangs or aborts the engine (verified). A minimal
   lexer that skips strings, comments, quoted identifiers and dollar-quoted bodies detects it and shows a clear message.
   It is the only SQL analysis Krash does.
6. **Persistence.**
   - *Answers, tabs and UI preferences* live in `sessionStorage` (debounced ~400 ms and read back after writing).
     They survive a reload of the same tab, not a closed tab. The header shows *Saving…*, *Saved in this tab* or
     *Save failed: export now*.
   - *The database* lives in IndexedDB under a per-session name `krash-<sessionId>-<generation>` (PGlite stores it as
     `/pglite/<name>`). IndexedDB was chosen over OPFS for Safari compatibility, and `relaxedDurability` stays off.
     On reload the same database is reopened, not re-seeded. A dataset marker (a comment on the database) detects
     mismatches.
   - *Duplicated tabs* copy `sessionStorage`. A Web Lock per session detects the second tab, which then gets its own new
     database (its answers are copied) and is told so. Two PGlite instances never write the same store.
   - *Retention and cleanup.* IndexedDB is durable, not session-scoped. Each tab writes a heartbeat to `localStorage`
     once a minute. On startup Krash deletes old generations of its own session and databases of sessions silent for
     more than 12 hours. **Clear workspace** deletes the current database and answers immediately. Use it after
     submitting.
7. **Reset swaps only after validation.** **Reset database** builds and seeds the next generation, checks the dataset
   marker and expected tables, and only then switches to it and deletes the old one. A failed reset leaves the previous
   database in use and says so.
8. **No assistance by construction.** CodeMirror 6 has highlighting, line numbers, selection, undo/redo and bracket
   matching. There is no autocompletion extension, no linting, no auto-closing brackets and no formatting (E2E-tested).
   The schema tree is read-only and never generates SQL. Table preview exists behind a flag that is off by default.

### Answer export format (version 1)

```sql
-- Krash answers
-- krash-format: 1
-- exam: dbs-practice
-- dataset: webshop-v1
-- exported: 2026-11-11T10:00:00.000Z
-- answers: 2
--
-- Downloading this file is not the same as submitting it.
-- Upload it via your exam platform.

-- ==== krash:answer 1 of 2 | lines: 2 | name: "Question 1" ====
select *
from customers;
-- ==== krash:end 1 ====
```

Each block states its exact line count and the name is a JSON string, so student code that happens to contain
separator-like lines is restored exactly. Import validates the structure, accepts CRLF/BOM, sanitises names, can
*replace* or *add* tabs, and never runs anything. Filenames are ASCII-only and contain no personal data:
`krash-answers-<examId>-<yyyymmdd-hhmm>.sql`.

## Design language

Krash reproduces the visible conventions of Klode and Kopje rather than their code: a quiet light workbench, an
`k.` brand mark, Inter/system sans for UI, Cascadia Code/SF Mono for code, fine `#dfe4ec` borders, 12 px panel radius,
one blue accent (`#315ac6`) and a green **Run** that becomes a red **Stop** while running. Status uses a small coloured dot
*plus* text. Light and dark themes follow the OS, with a three-state override (system → light → dark) like Klode's.
All values are CSS variables in `src/styles/tokens.css`. Layout: header with brand and tagline; a *POSTGRESQL WORKSPACE*
eyebrow; a collapsible *Database* sidebar; an editor panel with answer tabs and Run; a keyboard-resizable splitter;
results; a one-line motto and a quiet footer.

## Accessibility

Semantic landmarks and headings, a skip link, visible focus everywhere, ARIA tabs with arrow-key navigation for answers
and results, F2 to rename and Delete to remove a tab, a keyboard-operable splitter (`↑`/`↓`), native `<dialog>` with
focus return, live-region announcements for run results and errors, and text alongside every colour cue. axe-core
reports no WCAG 2.1 AA violations in light or dark mode (E2E-tested). In the editor, Tab indents; press Esc and then Tab to
leave it.

## Testing

| Suite | Count | What |
| --- | --- | --- |
| `tests/unit` | 29 | Wire protocol reader (chunking, limits, errors), lexer, export/import round trips, names and filenames, session persistence and orphan detection, config validation. |
| `tests/integration` | 15 | Real PGlite in Node: seeding, idempotent marker, value formatting, multi-statement scripts, syntax and runtime errors, implicit transactions, explicit transactions, exam topics (joins, grouping, subqueries, CTEs, windows, views, DDL/DML), result bounding, `COPY` guard, notices, introspection. |
| `tests/e2e/app.spec.ts` | 17 per browser | The plan's acceptance scenarios 1–13, plus duplicated tab, `COPY`, transaction state, no foreign requests, missing WASM and blocked storage. |
| `tests/e2e/a11y.spec.ts` | 4 per browser | axe (light/dark), keyboard-only workflow, Clear workspace. |
| `tests/e2e/spike.spec.ts` | 2 per browser | Phase A spike (dev server only). |

**Status on the build machine:** all unit, integration and E2E suites pass in **Chromium and WebKit**. **Firefox
has not been run yet:** the development sandbox could not launch Playwright's Firefox. Run
`npx playwright test --project=firefox` before relying on Krash in Firefox.

## Known limitations (read before using in an exam)

- **Local storage is not a backup.** Answers survive a reload of the same tab only. Closing the tab loses them; a
  `beforeunload` prompt warns when there are unexported changes. Browsers, profiles, private windows and
  institutional cleanup policies can remove `sessionStorage`/IndexedDB at any time. Students must **export regularly**
  and submit through the exam platform. Krash never submits anything.
- **Not tamper-proof.** A student controls their browser: they can read every shipped file, run JavaScript and
  bypass UI limits. Krash provides no lockdown, proctoring or timer; use managed devices for that.
- **Cancellation** works only by restarting the engine (see decision 4). Effects of the interrupted Run and any open
  transaction are lost.
- **PostgreSQL coverage.** It is real PostgreSQL 18.6, single user and single connection, in WASM. Not available:
  `COPY … FROM STDIN`, psql meta-commands (`\d`, `\copy`), extensions (none are loaded), roles/`GRANT` meaningfully,
  `LISTEN`/`NOTIFY` across sessions, server administration, and file system or network access. `statement_timeout` has no
  effect. Test the exact topics of your exam with the integration tests as a template.
- **Result limits.** At most `maxRows` rows per statement and 50 statement results per Run are kept. Cells are cut at
  10,000 characters. All of this is reported explicitly, and side effects are never hidden.
- **First load** downloads about 16 MB.
- **Data retention.** Databases of abandoned sessions stay in IndexedDB until a later Krash visit on that browser
  profile has seen no heartbeat for 12 hours and deletes them, or until the browser clears site data. Use
  **Workspace → Clear workspace** after submitting.
- **Duplicated-tab detection** needs the Web Locks API (all current browsers). Without it, a duplicated tab could
  open the same database as the original.

## Before using Krash in a real exam

The exam owner should decide (PLAN.md §8):

1. Is the exported SQL text the graded artifact, or must graders reproduce the final database state?
2. Is it acceptable that the seed dataset is publicly readable by students?
3. Which DDL/DML/transaction/PL/pgSQL topics are needed? Extend `tests/integration/engine.test.ts` with them.
4. Must work survive a browser restart, or only a same-tab reload? (Krash: same-tab reload only.)
5. Which browsers and versions, network restrictions and download/upload procedures apply? Run a **manual test on an
   institutional exam machine**: startup, keyboard shortcuts, locked-down policies, downloads, and behaviour without
   network after the first load.
6. What is the fallback if the computer crashes or storage is cleared before submission?

## Repository layout

```text
src/app/          App orchestration, run records, message descriptions
src/components/   SqlEditor, AnswerTabs, SchemaTree, ResultsPanel, Splitter, Modal, Dialogs, Icon
src/db/           worker, client, protocol, engine, wire reader, lexer, storage names
src/exam/         examConfig.ts, seed.sql
src/workspace/    types, sessionStore, sessionLock, exportAnswers, names, ids
src/styles/       tokens.css, layout.css
tests/            unit/, integration/, e2e/
spike/            Phase A proof-of-concept scripts and page (not part of the build)
scripts/          licenses.mjs (generates public/THIRD_PARTY_NOTICES.txt)
```

## Credits and licenses

Built with [PGlite](https://pglite.dev) by Electric SQL (Apache-2.0, includes PostgreSQL under the PostgreSQL
License), [CodeMirror 6](https://codemirror.net) (MIT) and [React](https://react.dev) (MIT). `npm run build`
regenerates the full list in `public/THIRD_PARTY_NOTICES.txt`, which the app links from its footer. The visual
language is inspired by [Klode](https://github.com/hanze-hbo-ict/klode) and Kopje; no code or assets were copied from them.
