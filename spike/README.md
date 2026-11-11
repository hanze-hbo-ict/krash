# Phase A spike

Proof-of-concept used to validate PGlite before building the UI (PLAN.md §7, Phase A). Not part of the build.

| File | Finding |
| --- | --- |
| `node-spike.mjs` | Boot time, `exec()` results (column headers for empty results), syntax-error behaviour, `statement_timeout` **does not fire** in WASM, open transactions persist across calls. |
| `stream.mjs` | `execProtocolRawStream` delivers ~8 KB chunks; 3 M rows can be counted without materialising them. |
| `one.mjs` | Runs one statement via the raw protocol: `node spike/one.mjs "copy (select 1) to stdout"`. |
| `copy.mjs` | **Aborts the process**: `COPY … FROM STDIN` kills/hangs PGlite, hence the guard in `src/db/sqlLexer.ts`. |
| `index.html` + `spike.ts` | Browser page driving the real worker; exercised by `tests/e2e/spike.spec.ts` (`KRASH_E2E_DEV=1`). Verified: boot, seed, query, persistence across reload, isolation between tabs, IndexedDB naming `/pglite/<name>`, terminate-and-reopen. |
