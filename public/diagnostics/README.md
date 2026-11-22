# Browser diagnostics

A static diagnostics page for environments where a browser app does not start,
for example an exam shell that is not cross-origin isolated. Someone opens
`/diagnostics/` in that environment, presses **Run all variants**, and sends
back the JSON report (**Copy results** or **Download report**).

It was written for Klode (hanze-hbo-ict/klode#56) and is meant to be copied into
sibling apps. Each copy belongs to the app it is copied into: change it as that
app needs. There is no shared package and nothing to keep in sync.

## What it measures

- Browser identity: user agent, Electron and Chromium version, platform.
- Secure context, cross-origin isolation, framing, opener, navigation protocol.
- Response headers as they actually arrive for this page, for the app root and
  for any resources listed in `config.json` (shows a proxy stripping headers).
- Storage, WebAssembly (including shared memory and JSPI), module and classic
  workers, `SharedArrayBuffer` in a worker, and a blocking `Atomics.wait` that
  the page wakes up.
- A service worker answering a synchronous request from a worker: the known way
  to block a worker for input without `SharedArrayBuffer`.
- Optionally an app-specific check, such as starting the app's runtime.
- Content-Security-Policy violations during the run.

The page runs under the app's own headers, including its CSP, so the results
describe the app's real situation. It uses no inline script or style, no
`blob:` worker and no external resources, so `default-src 'self'` is enough. A
CSP without `'wasm-unsafe-eval'` makes the WebAssembly checks fail; the report
then shows a CSP violation.

## Files

| File | Purpose |
|---|---|
| `index.html` | Default page: the app's own headers |
| `isolated/`, `credentialless/`, `no-isolation/` | Comparison pages that differ only in headers. Each also holds one-line worker stubs that import the shared worker, so a worker gets its page's headers: a page with COEP blocks a worker served without it |
| `diagnostics.js`, `diagnostics.css` | Page logic and style |
| `probe-worker.js` | Worker for the worker and service worker checks |
| `sw.js` | Service worker; answers only `sw-probe/` requests in its scope and is unregistered afterwards |
| `config.json` | Per-app settings |
| `app-check-worker.js` | Optional, app-specific (Klode: starts Python). Without an `appCheck`, delete it and its stubs |

All URLs are relative, so the directory may live under any path. Copy the
directory into the app's static output, for example `public/diagnostics/`.

## config.json

```json
{
  "app": "Klode",
  "appURL": "../",
  "headers": {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp"
  },
  "resources": [
    { "label": "Python runtime", "url": "../runtime/314.0.7/pyodide.asm.wasm", "contentType": "application/wasm" }
  ],
  "appCheck": {
    "label": "Python runtime in worker",
    "worker": "app-check-worker.js",
    "timeoutSeconds": 120,
    "options": { "runtime": "../runtime/314.0.7/" }
  }
}
```

- `app`: name shown on the page and in the report.
- `appURL`: the app's start page, relative to this directory.
- `headers`: the isolation headers the app itself sends (an empty object if
  none). Used to check what arrives, and to skip a comparison page that would
  equal the app's own headers.
- `resources` (optional): files whose headers are checked with a `HEAD` request.
- `appCheck` (optional): a module worker in this directory, with a stub of the
  same name in each comparison directory, that receives
  `{ type: 'run', options }` and answers `{ ok: true, pass, value }` or
  `{ ok: false, error }`. Option values starting with `./` or `../` are resolved
  to absolute URLs against this directory first.

## Comparison headers

The comparison pages only make sense when the host sends them different
headers. A comparison page that equals the app's own headers is skipped, so it
needs no rule. For the other ones, add rules to the host's `_headers` file
(Cloudflare Pages; `!` removes a header set by an earlier rule):

```
/diagnostics/isolated/*
  ! Cross-Origin-Opener-Policy
  ! Cross-Origin-Embedder-Policy
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp

/diagnostics/credentialless/*
  ! Cross-Origin-Opener-Policy
  ! Cross-Origin-Embedder-Policy
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless

/diagnostics/no-isolation/*
  ! Cross-Origin-Opener-Policy
  ! Cross-Origin-Embedder-Policy
```

Leave out the detach lines for headers the app does not set, and the rule for
a comparison that equals the app's headers. Each page reports when the headers
it receives differ from the ones it expects, so a missing or wrong rule is
visible in the report. Check the live headers after deploying, for example
with `curl -sI https://<host>/diagnostics/credentialless/`.

Under `Cross-Origin-Embedder-Policy: require-corp`, all files here are
same-origin, so they need no `Cross-Origin-Resource-Policy` header.

## Report format

```json
{
  "tool": "browser-diagnostics",
  "version": "1.0.0",
  "app": "Klode",
  "time": "…",
  "variants": {
    "app": { "time": "…", "url": "…", "results": { "<check>": { "status": "pass|fail|info", "value": {} } }, "cspViolations": [] }
  }
}
```

A single page and a full run use the same format; a full run has one entry per
variant. The run keeps finished results in `localStorage` (key
`diagnostics-run`) and removes them when the last page has finished. If storage
is blocked, the page says so and each variant must be copied separately.
