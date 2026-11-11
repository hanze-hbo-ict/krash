# Krash — implementation plan for a coding agent

## 0. Mission

Build **Krash**, a small, focused **online PostgreSQL IDE for database examinations**, visually and philosophically related to **Klode** (https://klode.app) and **Kopje** (https://kopje.pages.dev).

Krash is a SQL workbench, **not** a learning platform, AI tutor, proctoring tool, or examination management system. It should be usable on institutional exam machines in a modern desktop browser, with no login and no per-student backend database. Students should be able to inspect a supplied schema, write and execute PostgreSQL SQL, inspect results/errors, and export their answer for submission to the institution's existing exam platform.

**Default product decisions for v1:**
- Static, client-only web application; no backend, accounts, telemetry, or cloud sync.
- Real PostgreSQL semantics via `@electric-sql/pglite` (the Electric SQL PGlite project), executed in a dedicated Web Worker.
- A **predefined exam dataset** bundled with the app; optionally support explicit import of a local `.sql` dataset, gated by configuration.
- Several named SQL answer tabs/documents; a single embedded PostgreSQL database shared by those tabs during the session.
- Automatic local recovery across accidental reloads **within the same browser tab/session**, plus explicit manual export and import of answers.
- No AI assistance, SQL autocomplete, query suggestions, inline error corrections, code generation, or automatic grading.
- Desktop-first, keyboard-accessible UI with a usable narrow-screen fallback, rather than treating mobile devices as the exam target.

If the repo is initially empty, implement this directly. Do not spend the first iteration building authentication, a backend, a complex plugin architecture, or a generic IDE framework.

## 1. Design references / visual language

Look at these **live sites** before implementing styling:
- Klode: https://klode.app — minimal Python workspace, editor and console, friendly `k.` branding, short tagline, explicit lack of code completion/AI assistance.
- Kopje: https://kopje.pages.dev — same visual family; multiple Java source files, editor and console, restrained import/export flows.
- Klode source, if useful: https://github.com/hanze-hbo-ict/klode

Do not blindly clone their code or assume access to their private assets. Reproduce the **design language**, not their exact internal implementation:
- Quiet, light, well-spaced workbench; simple typography, subtly distinguished regions, limited accent color, fine borders and restrained rounded corners.
- Small `k.` brand mark and a distinctive **Krash** wordmark. Suggested tagline: **“A little room for PostgreSQL.”**
- Calm and understated. Avoid dashboard cards, large illustrations, gradients, decorative charts, visual noise, terminal cosplay, and giant toolbars.
- Prominent *Run* control, visually clear workspace sections, compact status messages, accessible error display.
- Visual continuity with Klode/Kopje takes precedence over adding a conventional database-admin IDE aesthetic.
- Use CSS variables/tokens for color, typography, spacing and border radii. Respect OS light/dark preference if reasonable, but prioritize one polished reference-consistent default theme.
- Do not add Monaco-sized complexity unless justified. CodeMirror 6 with SQL syntax highlighting and line numbers is an appropriate default.

### Suggested desktop arrangement

```text
┌────────────────────────────────────────────────────────────────────┐
│ k.  Krash      A little room for PostgreSQL.     [Export] [Help]  │
├────────────────────────────────────────────────────────────────────┤
│ POSTGRESQL WORKSPACE                            ● Ready   [Run ▶] │
├────────────────┬───────────────────────────────────────────────────┤
│ Database       │ [Question 1] [Question 2] [+]                      │
│                ├───────────────────────────────────────────────────┤
│ ▾ public       │ SQL editor                                         │
│   ▾ customers  │ SELECT ...                                         │
│     id         │                                                   │
│     name       │                                                   │
│   ▸ orders     │                                                   │
│                ├───────────────────────────────────────────────────┤
│ [Reset DB]     │ Results [Messages]                                 │
│                │ ┌──────────┬────────┬────────────┐                 │
│                │ │ id       │ name   │ ...        │                 │
│                │ └──────────┴────────┴────────────┘                 │
└────────────────┴───────────────────────────────────────────────────┘
```

This is an information architecture sketch, not a pixel specification. Editor and results areas should be vertically resizable. Schema sidebar may collapse. Ensure the Run button and active tab remain visible. No horizontal full-page scrolling at the supported exam viewport.

## 2. Core student workflows

### 2.1 Open exam environment
1. Open the static site; it loads bundled local assets and initializes a fresh PGlite database if there is no valid workspace in this tab/session.
2. Apply the configured database schema and seed rows, exactly once, with clear loading/error states.
3. Show a schema tree (schemas → tables/views → columns, with data types and primary/foreign-key markers where practical).
4. Initialize one or more empty answer tabs (e.g. `Question 1`). Do not prefill answer SQL or teach query solutions.
5. Display PostgreSQL version, app version or dataset identifier in a discreet Help/About section.

### 2.2 Write and run SQL
1. Student edits SQL in the active answer tab.
2. `Ctrl+Enter` / `Cmd+Enter` or *Run* executes the selected SQL if a nonempty selection exists; otherwise it executes the entire active tab.
3. Execute multi-statement scripts as a unit via the appropriate PGlite API (`exec()`); do not naively split SQL on `;` (semicolons can occur inside functions, strings and dollar-quoted bodies).
4. Show tabular data for statements yielding rows, including column names **even for an empty result set**. Show affected-row counts / completion status for DDL and DML.
5. For multi-statement execution, present one result view per returned statement (compact tabs or list); select the last result by default. If execution fails, show the actual PostgreSQL error, with location/position where available, and preserve the SQL. Be honest if partial execution occurred.
6. Running SQL mutates the shared working database normally; answer tabs do not each create a separate database.
7. Refresh the schema browser after DDL, import, or reset, without making queries unresponsively slow.

**SQL behavior:** Support standard PostgreSQL teaching exercises including `CREATE TABLE`, constraints, `INSERT`, `UPDATE`, `DELETE`, `SELECT`, joins, grouping, subqueries, CTEs, views, window functions and transactions, insofar as supported by the pinned PGlite build. Do not claim complete parity with networked PostgreSQL, server administration, roles, arbitrary extensions, or filesystem access. Explicitly test the topics the actual exam uses.

### 2.3 Navigate and inspect
- Sidebar: read-only schema explorer with table/column names, data types, and keys. No inline table editing, query wizard, suggested SQL, or “fix query” action.
- Optional simple table preview: clicking a table can show **bounded** sample rows, but **should not** insert or generate a `SELECT` query automatically unless specifically required. Keep this off by default if exam rules disallow it.
- Results: correct `NULL` display, booleans, dates, numbers, and JSON/arrays; wide-column horizontal scrolling; result limits to protect UI responsiveness with explicit truncation notice. Prefer bounded data render / virtualization rather than unbounded DOM.
- Text-based messages distinguish initialization, success, SQL errors, and infrastructure failures. Avoid relying on color alone.

### 2.4 Work on multiple answers
- Students may create, rename, select and delete SQL tabs/documents, with a confirmation for delete.
- Tabs represent **answer scripts**, not databases or execution sessions; all use the same PGlite instance.
- Document names must be sanitized for display/export; never interpret them as paths.
- Automatically save editor contents and active tab in session-scoped state after every edit (debounced appropriately).
- Warn on destructive resets/imports, but do not interrupt ordinary tab switching.

### 2.5 Export answers / submit
- A clearly labeled **Export answers** action produces a UTF-8 `.sql` file (for example `krash-answers.sql`) containing all answer tabs with unambiguous SQL comment separators, preserving exact student code, ordering and line endings as far as practical.
- Allow copying one active answer or all answers as plain text.
- Support import of **Krash answer exports** back into answer tabs without automatically running the imported SQL.
- Include a file format header with `Krash`, export format version, and optional exam/dataset ID; never include personal identity unless explicitly entered by the student and needed by the exam procedure.
- Do **not** silently submit or upload anything. The exam platform remains the submission destination. Show a concise confirmation that downloading a file is not equivalent to submitting it.
- V1 does not need an entire database dump as the primary submission artifact; SQL answers are the examination deliverable. A full database-state export is a separate optional feature only if assessment design requires it.

## 3. Exam reliability and persistence

An accidental reload must not erase ongoing work. However, browsers can clear storage; **local recovery must never be described as guaranteed or as an official submission**.

Recommended implementation:
- Use `sessionStorage` for a **session identity**, answer tabs, active tab, UI preferences, and export-version metadata. It survives ordinary reloads in the same tab, but may behave differently after tab duplication/browser restore.
- Use a session-specific PGlite **IndexedDB filesystem** (e.g. a name derived from that session ID) to preserve database mutations across reloads. Choose IndexedDB rather than OPFS for Safari compatibility per PGlite documentation.
- Reopen the same database on reload, not re-seed it; store/check a dataset version marker inside the database to detect mismatches.
- Avoid a single global DB name shared between unrelated browser tabs. Do not allow concurrent instances to write the same store without a proper worker/leader strategy.
- Keep `relaxedDurability` disabled for exams unless performance tests demonstrate a compelling reason and the risk is explicitly accepted.
- Provide a visible `Saved locally` / `Saving…` / `Save failed` indicator for answer text; confirm durable storage success when possible. On quota or storage-denied errors, inform the user prominently and recommend immediate export.
- Provide a recovery-friendly error UI; never destroy answer text or existing storage on an initialization failure.
- Use `pagehide`/lifecycle cleanup only as best-effort; it cannot be trusted to delete session data reliably. Namespace records by session, and plan for explicit cleanup of stale orphaned datasets. Minimize retained exam content and document retention clearly.
- At exam start, offer **Start a fresh workspace** with confirmation that clears the current session; after the exam, offer **Clear this workspace**. These are distinct from **Reset database** (see below).
- If the exam policy is truly **nothing survives after a tab/session closes**, investigate memory-only PGlite plus a rigorously tested restore mechanism. Do not pretend IndexedDB is session-only; it is durable storage and can leave orphaned data without cleanup.
- Include repeated, prominent instructions to export periodically. For high-stakes exams, consider an institution-controlled submission/autosave service in a later, separately scoped version; it is not present in this architecture.

### Reset semantics (make them unambiguous)
- **Reset database**: restore the canonical exam dataset and remove student DB changes; keep all answer SQL and tabs. Confirm before proceeding.
- **Clear answers**: erase answer tabs only after explicit confirmation; do not reset DB unless requested.
- **Start fresh / Clear workspace**: remove both answer documents and the locally persisted database; confirm and explain implications.
- A failed reset must not leave the UI claiming the canonical dataset has been restored. Prefer creating a new database, validating seed success, and swapping it into place only when complete, if supported by the chosen persistence strategy.

## 4. Technical architecture

### Stack
- **TypeScript** in strict mode.
- **Vite** static build.
- **React** for UI (or a similarly small framework if there is a compelling project reason); keep components focused.
- **CodeMirror 6** SQL editor: syntax highlighting, line numbers, selection, normal keyboard editing and undo/redo; deliberately disable autocomplete, lint suggestions, automatic formatting, AI features and intrusive completion prompts.
- **`@electric-sql/pglite`** (Electric SQL's implementation), pinned to a tested exact version. There are similarly named projects; do not accidentally substitute a different `pglite` package.
- **Dedicated Web Worker** owning the single PGlite instance. All DB activity goes through a typed request/response protocol; the main thread must not block during query execution.
- Plain CSS / CSS modules with design tokens; avoid a heavy component library unless it genuinely saves work without changing the aesthetic.
- **Vitest** for unit/integration tests and **Playwright** for cross-browser end-to-end exams tests.

### Suggested files

```text
src/
  app/App.tsx
  components/Header.tsx
  components/SqlEditor.tsx
  components/AnswerTabs.tsx
  components/SchemaTree.tsx
  components/ResultsPanel.tsx
  components/StatusBar.tsx
  components/ConfirmDialog.tsx
  db/db.worker.ts
  db/dbClient.ts
  db/protocol.ts
  db/schemaIntrospection.ts
  db/datasetLoader.ts
  exam/examConfig.ts
  exam/seed.sql
  workspace/types.ts
  workspace/sessionStore.ts
  workspace/exportAnswers.ts
  styles/tokens.css
  styles/layout.css
  main.tsx
public/
tests/unit/
tests/e2e/
README.md
```

Favor understandable boundaries over copying this tree literally.

### Worker protocol

Suggested typed messages:
- `init({ sessionId, datasetId })` → status and metadata
- `execute({ requestId, sql })` → result set(s) and duration or structured Postgres error
- `getSchema()` → namespaces/tables/views/columns/keys
- `previewTable({ schema, table, limit })` → optional bounded rows, with safely quoted identifiers
- `resetDatabase({ datasetId })` → success or error
- `destroySession()` → complete cleanup when possible
- `health()` → ready/busy/error state

Every request has a unique ID; errors travel back as serializable structured values, not arbitrary objects with lost properties. UI updates use only the matching response and the relevant active editor state. Serialize database operations in the worker where needed to prevent unexpected reordering.

### Query execution nuances
- PGlite `.query()` handles **one** parameterizable statement; `.exec()` handles **multiple** statements and returns a result object for each. Use these deliberately.
- Do not implement a homegrown SQL splitter to count statements or associate error positions. PGlite's result list can drive result tabs. If a robust parser is later required, use a well-tested PostgreSQL-aware parser.
- An error during a multi-statement script may prevent subsequent execution; report the actual DB outcome rather than promising atomicity. Do not automatically wrap student SQL in a transaction (that changes the meaning of `BEGIN`, `COMMIT`, savepoints and some commands).
- Provide a clear “running” state and prevent repeated Run submissions while a request is outstanding.
- A JS-side timeout cannot necessarily cancel a query inside synchronous WASM. For potential infinite/very costly queries, research whether a DB-side `statement_timeout` works in the pinned build; test it, and if unreliable implement a controlled worker-restart/recovery strategy and document its effects on in-flight work. Never promise cancellation that does not work.
- Results must be bounded on both the worker→UI transfer and rendering paths; avoid accidentally pulling/rendering millions of rows. Establish a tested maximum or pagination strategy and tell the user clearly when output is truncated. Test semantics carefully so limiting results does **not** secretly mutate the student's SQL or hide side effects.
- Use an explicit dataset loader process and validation queries; avoid re-seeding on every page load.

### Exam configuration (static)
Create a typed `ExamConfig` with:
- exam/workspace title and identifier;
- dataset identifier/version and URL/import of immutable bundled `seed.sql`;
- initial answer tab names;
- allowed/hidden UI features (e.g. table preview, manual dataset import, export, schema browser);
- optional max visible results and supported PostgreSQL version display;
- optional downloadable instructions text.

Do not build a teacher-facing graphical authoring interface in v1. An exam organizer can edit the config and seed file before deployment. Avoid distributing model solutions or hidden assessment material with static assets: **every file in a client-only app is accessible to students**.

## 5. Security, assessment integrity and accessibility

- Browser-only apps are **not tamper-proof**. A student controls their browser, can view shipped assets, run arbitrary JS, and bypass UI limits. Do not pitch this as a secure locked-down exam solution.
- No AI APIs or external query execution; no telemetry or analytics; no accounts; no automatic answer uploads.
- If exam rules need to block other sites, inspect activity, enforce timers or centrally protect grading material, this requires institutional exam infrastructure / managed devices and is out of scope.
- Student SQL is intentionally arbitrary *inside the local sandbox*. Never send it to an institutional shared PostgreSQL server. Treat local-import text as untrusted; avoid `innerHTML`; use safe DOM text rendering and robust filename handling.
- Restrict external network dependencies at runtime: self-host the JS/CSS/WASM/data assets; test deployment under a restrictive content security policy, and support offline use after assets are cached if desired.
- Use `navigator.storage` information only as a diagnostic; browser storage persistence is not a guarantee against data loss or all institutional cleanup policies.
- Accessibility: navigable tab order, visible keyboard focus, semantic controls and labels, buttons with readable names, adequate contrast, errors announced via ARIA live region, resizable panes usable without dragging, and keyboard-driven tab switching. Do not use color as the sole indicator.
- Do not require personal details, and avoid putting personal data in exported filenames by default.

## 6. Intended scope

### MVP (must ship)
- Recognizable Krash design coherent with Klode/Kopje.
- PostgreSQL initializes locally from pinned PGlite/WASM assets.
- Load and validate one configured SQL schema/dataset.
- SQL editor: highlighting, selection, line numbers, keyboard Run.
- Execute arbitrary supported PostgreSQL SQL and multi-statement scripts; show accurate results/errors.
- Read-only schema tree.
- Several named answer tabs; create/rename/delete.
- Session-scoped answer recovery and per-session database recovery on reload.
- Explicit answer export (`.sql`), copy, and import.
- Safe, clear database reset, answer-clear and full-workspace-clear flows.
- Clean, accessible desktop UX; cross-browser smoke tests.

### Later, only if justified
- CSV/JSON result export.
- Import an externally supplied dataset `.sql` during a session.
- Database snapshot export/import, with strict PGlite version compatibility warning.
- Optional table-data preview.
- Result pane virtualization / smarter paging for larger exams.
- Explicit query execution history **only if policy allows**; avoid making copying past query fragments easier than intended by default.
- Alternative visual theme.
- Institution-hosted autosave/submission (requires backend and a separate privacy/security design).

### Out of scope
- AI, autocomplete, snippets, SQL hints, auto-fixing, auto-grading, SQL tutorial, ERD drawing, role administration, connection strings/remote Postgres, collaboration, cloud storage, proctoring, timers, identity management, and teacher dashboard.

## 7. Delivery phases and verifiable acceptance tests

### Phase A — technical spike
Build a tiny PGlite + Web Worker proof of concept first, before significant UI work:
1. Boot a pinned PGlite version in Chrome, Firefox and Safari.
2. Load sample seed tables and query them.
3. Execute `CREATE TABLE`, `INSERT`, `SELECT`, `JOIN`, an intentional syntax error, and a multi-statement script using `.exec()`.
4. Verify result column headers and `NULL`, and accurate errors.
5. Mutate DB, reload and verify it is still mutated under the same tab/session.
6. Open a new unrelated tab/session and verify its dataset is fresh and isolated.
7. Test database reset and clearing session storage.
8. Test failure cases (blocked storage, corrupt/incompatible DB, absent WASM file).

**Go/no-go:** If any exam-required PostgreSQL feature is unsupported or a target browser cannot reliably run the chosen version, stop and report the incompatibility before building more UI. The fallback would be a real, isolated per-student Postgres service, which is a different deployment architecture.

### Phase B — workbench MVP
Implement the visual layout, SQL editor, shared worker, loading states, schema tree, tab management and result/message panels. Polish typography and spacing against the two reference sites. Confirm normal keyboard workflow without needing a mouse.

### Phase C — exam hardening
Implement session recovery, database reset, clear workspace, import/export, corruption handling, result-size protection, failure messages, focus management, and accessiblity checks. Test with realistic exam datasets and sample scripts; do not rely only on toy tables.

### Phase D — release quality
- Unit tests for serialization, tab state, export/import, file naming and configuration validation.
- Worker integration tests for SQL execution, schema introspection, seed idempotency, reset and errors.
- Browser E2E tests for Chrome, Firefox and WebKit/Safari (especially persistence).
- Manual institutional exam-machine test for startup, keyboard shortcuts, locked-down browser policies, downloads and offline/no-network conditions.
- Production static build, deployment instructions and a concise README describing limitations and answer recovery.
- Explicit credits/licenses for dependencies.

### Critical end-to-end acceptance scenarios

1. **Fresh workspace:** Open Krash → seeded tables appear → `SELECT` returns correct rows.
2. **DDL:** Create table → it appears in schema tree; insert data → select data.
3. **Multiple statements:** A script with comments, string semicolons and dollar-quoted code is passed intact to PostgreSQL and behaves correctly.
4. **Error:** Invalid SQL yields readable genuine Postgres error; all code remains intact; student can edit and run again.
5. **Selection:** Selecting one query and pressing Ctrl/Cmd+Enter executes only the selected text.
6. **Answer tabs:** Editing three named tabs preserves each script and does not isolate their database state.
7. **Reload:** Reload in the same tab → both SQL answers and database mutations remain available without re-seeding.
8. **Independent tabs:** Open separate new tab → no accidental sharing of a previous exam database; document any browser tab cloning edge cases.
9. **Reset:** Reset DB restores original seed data but preserves answer documents.
10. **Export/import:** Export three tabs, clear answers, import export → original text and names return in the right order and nothing executes automatically.
11. **Result sizes:** Huge query produces a bounded view or clear deliberate error, never freezes the browser indefinitely in normal test conditions.
12. **Failure:** Offline after initial asset caching (if supported), blocked storage, failed seed, and missing WASM produce comprehensible states, not empty silent screens.
13. **No assistance:** No inline solutions, SQL recommendations, completion popups, AI hooks, hidden answer bundles, or automatic grading.
14. **Cross-browser:** Pass relevant flows in institution-supported versions of Chrome, Firefox and Safari.

## 8. Operational / pedagogical decisions to verify before an actual exam

The first release may be built with the defaults above, but before students rely on it the exam owner must answer:
1. Is **exported SQL text** the graded artifact, or must graders reproduce the **final mutated database state**? If the latter, add a validated database export or a controlled submission workflow.
2. Is the seed database fixed for all students, and is its presence in publicly delivered assets acceptable? Nothing shipped to the browser can be genuinely secret.
3. Are DDL/DML/transactions/PLpgSQL needed? Test those specifically, and pin the appropriate Postgres compatibility level.
4. Are student files expected to survive a browser restart, or only a same-tab reload? Those have different persistence/privacy implications.
5. Which browser versions, network restrictions and exam-platform download/upload procedures are in scope?
6. What is the institutional fallback if the computer crashes or local browser storage is cleared before submission? Do not represent local persistence as equivalent to a supervised backup.

## 9. Directions for the coding agent

1. Inspect Klode and Kopje to identify their **visible** design conventions. Summarize your design tokens/layout choices in the README rather than trying to copy source code blindly.
2. **Build and test the PGlite worker spike first.** Consult current official PGlite docs for exact APIs and verify the pinned package's browser support. Prefer `PGlite.create`, `exec`, IndexedDB persistence and worker ownership where appropriate.
3. Establish types and executable tests before adding UI polish. Do not replace genuine PostgreSQL with SQLite or an approximate SQL parser.
4. Implement the MVP in small vertical slices, running tests after each slice.
5. Avoid adding features not named in MVP; ask only if a truly blocking requirement cannot be resolved by the defaults here.
6. Document every known exam-relevant limitation, especially local storage reliability, unsupported Postgres features, query cancellation, data retention, and the lack of real proctoring/tamper resistance.
7. Deliver a functioning static production build, clear local development/deployment instructions, and the test suite. Do not describe incomplete placeholders as finished.

## References / sources

- Klode: https://klode.app
- Kopje: https://kopje.pages.dev
- Klode repository: https://github.com/hanze-hbo-ict/klode
- Electric PGlite overview: https://pglite.dev/docs/about
- Electric PGlite API (`query` versus `exec`): https://pglite.dev/docs/api
- Electric PGlite filesystem/browser compatibility: https://pglite.dev/docs/filesystems
- Electric PGlite REPL (for optional implementation inspiration, not as a feature mandate): https://pglite.dev/docs/repl
