// Browser diagnostics for environments where an app does not start, for example
// an exam shell that is not cross-origin isolated. Self-contained static files:
// no build step, no dependencies, relative URLs only, and no inline script,
// inline style or blob: worker, so it runs under a strict Content-Security-Policy.
// Per-app settings live in config.json next to this file; see README.md.
const KIT_VERSION = '1.0.0';
const base = new URL('./', import.meta.url);
const variant = document.documentElement.dataset.variant;

const describe = (error) => `${error?.name ?? 'Error'}: ${error?.message ?? error}`;
const pass = (condition) => (condition ? 'pass' : 'fail');
const lower = (headers) =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
const ISOLATION = ['cross-origin-opener-policy', 'cross-origin-embedder-policy'];

function timeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Content-Security-Policy violations explain checks that fail under an app's policy.
const violations = [];
document.addEventListener('securitypolicyviolation', (event) => {
  violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI, source: event.sourceFile });
});

let config;
try {
  const response = await fetch(new URL('config.json', base), { cache: 'no-store' });
  if (!response.ok) throw new Error(`config.json: HTTP ${response.status}`);
  config = await response.json();
} catch (error) {
  config = { app: 'Unknown app', configError: describe(error) };
}
const appHeaders = lower(config.headers ?? {});
const appURL = new URL(config.appURL ?? '../', base).href;
// Relative option values ("./…", "../…") are resolved against this directory.
const resolveOptions = (options = {}) =>
  Object.fromEntries(
    Object.entries(options).map(([key, value]) => [
      key,
      typeof value === 'string' && /^\.\.?\//.test(value) ? new URL(value, base).href : value,
    ]),
  );

const isolationOf = (headers) => ISOLATION.map((name) => headers[name] ?? null).join(' / ');
const allVariants = {
  app: { path: './', label: `${config.app}'s own headers`, headers: appHeaders },
  isolated: {
    path: 'isolated/',
    label: 'Comparison: COOP same-origin, COEP require-corp',
    headers: { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' },
  },
  credentialless: {
    path: 'credentialless/',
    label: 'Comparison: COOP same-origin, COEP credentialless',
    headers: { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'credentialless' },
  },
  'no-isolation': { path: 'no-isolation/', label: 'Comparison: no isolation headers', headers: {} },
};
// A comparison that equals the app's own isolation headers adds nothing.
const variants = Object.fromEntries(
  Object.entries(allVariants).filter(
    ([name, { headers }]) => name === 'app' || isolationOf(headers) !== isolationOf(appHeaders),
  ),
);
const current = allVariants[variant];
const order = Object.keys(variants);

// Runs one request/response exchange with a worker and always terminates it.
async function ask(worker, message, ms, what) {
  try {
    const reply = new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => (data.ok ? resolve(data) : reject(new Error(data.error)));
      worker.onerror = (event) => {
        event.preventDefault();
        reject(new Error(event.message || 'Worker failed to load'));
      };
    });
    worker.postMessage(message);
    return await timeout(reply, ms, what);
  } finally {
    worker.terminate();
  }
}
// Workers start from this page's own directory, so they get this page's headers;
// each comparison directory has a one-line stub that imports the shared worker.
const ownWorker = (file) => new Worker(new URL(current.path + file, base), { type: 'module' });
const askProbe = async (message) => (await ask(ownWorker('probe-worker.js'), message, 10000, 'Worker')).value;

async function headersOf(url, method = 'GET') {
  const response = await fetch(url, { method, cache: 'no-store' });
  return { url, status: response.status, headers: Object.fromEntries(response.headers) };
}

function framing() {
  const result = { top: window.top === window, opener: window.opener !== null };
  try {
    result.frameElement = window.frameElement ? window.frameElement.tagName : null;
  } catch (error) {
    result.frameElement = describe(error);
  }
  result.ancestorOrigins = location.ancestorOrigins ? [...location.ancestorOrigins] : 'unsupported';
  return result;
}

async function identity() {
  const result = {
    userAgent: navigator.userAgent,
    electron: navigator.userAgent.match(/Electron\/([\d.]+)/)?.[1] ?? null,
    chrome: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? null,
    language: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hardwareConcurrency: navigator.hardwareConcurrency,
    webdriver: navigator.webdriver,
  };
  if (navigator.userAgentData) {
    result.brands = navigator.userAgentData.brands;
    try {
      result.highEntropy = await navigator.userAgentData.getHighEntropyValues([
        'architecture', 'fullVersionList', 'model', 'platform', 'platformVersion',
      ]);
    } catch (error) {
      result.highEntropy = describe(error);
    }
  }
  return result;
}

function context() {
  const entry = performance.getEntriesByType('navigation')[0];
  return {
    url: location.href,
    isSecureContext: window.isSecureContext,
    crossOriginIsolated: window.crossOriginIsolated,
    referrer: document.referrer,
    navigation: entry
      ? {
          type: entry.type,
          nextHopProtocol: entry.nextHopProtocol,
          transferSize: entry.transferSize,
          serverTiming: entry.serverTiming?.map(({ name, description }) => ({ name, description })),
        }
      : 'unavailable',
  };
}

function storage() {
  const result = {};
  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      window[name].setItem('diagnostics-probe', '1');
      window[name].removeItem('diagnostics-probe');
      result[name] = true;
    } catch (error) {
      result[name] = describe(error);
    }
  }
  result.indexedDB = typeof indexedDB !== 'undefined';
  result.storageManager = typeof navigator.storage?.getDirectory === 'function';
  return result;
}

function pageFeatures() {
  const wasm = typeof WebAssembly !== 'undefined';
  const result = {
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    atomics: typeof Atomics !== 'undefined',
    atomicsWaitAsync: typeof Atomics?.waitAsync === 'function',
    webAssembly: wasm,
    jspi: wasm && 'Suspending' in WebAssembly,
    worker: typeof Worker !== 'undefined',
    serviceWorker: 'serviceWorker' in navigator,
    clipboardWrite: typeof navigator.clipboard?.writeText === 'function',
  };
  if (wasm) {
    // The smallest valid module: magic number and version.
    const module = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    result.wasmValidate = WebAssembly.validate(module);
    try {
      new WebAssembly.Instance(new WebAssembly.Module(module));
      result.wasmInstantiate = true;
    } catch (error) {
      result.wasmInstantiate = describe(error);
    }
    try {
      const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
      result.wasmSharedMemory = memory.buffer.constructor.name;
    } catch (error) {
      result.wasmSharedMemory = describe(error);
    }
  }
  return result;
}

// The page wakes a blocked worker through shared memory, as interactive input does.
async function crossThreadWait() {
  if (typeof SharedArrayBuffer === 'undefined') throw new Error('SharedArrayBuffer is unavailable');
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  setTimeout(() => {
    Atomics.store(view, 0, 1);
    Atomics.notify(view, 0);
  }, 200);
  return askProbe({ type: 'wait', buffer });
}

async function serviceWorker() {
  if (!('serviceWorker' in navigator)) return { available: false };
  const result = { available: true };
  let registration;
  try {
    registration = await timeout(
      navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname }),
      10000,
      'Registration',
    );
    result.registered = true;
    if (!navigator.serviceWorker.controller) {
      await timeout(
        new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })),
        10000,
        'Taking control',
      );
    }
    result.controlsPage = true;
    const probe = new URL('sw-probe/', base).href;
    const response = await fetch(`${probe}ping`, { cache: 'no-store' });
    result.fetch = { status: response.status, body: (await response.text()).slice(0, 80) };
    // Main-thread sync requests bypass service workers in Chromium; only the worker path counts.
    try {
      result.syncRequestFromWorker = await askProbe({ type: 'sync-request', url: `${probe}echo` });
    } catch (error) {
      result.syncRequestFromWorker = describe(error);
    }
  } catch (error) {
    result.error = describe(error);
  } finally {
    try {
      result.unregistered = registration ? await registration.unregister() : null;
    } catch (error) {
      result.unregistered = describe(error);
    }
  }
  return result;
}

async function appCheck() {
  const { worker, timeoutSeconds = 60, options } = config.appCheck;
  const reply = await ask(
    ownWorker(worker),
    { type: 'run', options: resolveOptions(options) },
    timeoutSeconds * 1000,
    config.appCheck.label,
  );
  return { passed: reply.pass === true, ...reply.value };
}

const sameIsolation = (headers) => ISOLATION.every((name) => (headers[name] ?? null) === (current.headers[name] ?? null));

const checks = [
  { key: 'identity', label: 'Browser identity', run: identity, assess: () => 'info' },
  { key: 'context', label: 'Page context', run: context, assess: (value) => pass(value.isSecureContext) },
  { key: 'framing', label: 'Framing', run: framing, assess: (value) => pass(value.top) },
  {
    key: 'pageHeaders',
    label: 'Headers received for this page',
    run: () => headersOf(location.href),
    assess: (value) => pass(sameIsolation(value.headers)),
  },
  {
    key: 'appHeaders',
    label: `Headers received for ${config.app}`,
    run: () => headersOf(appURL),
    assess: (value) =>
      pass(value.status === 200 && Object.entries(appHeaders).every(([name, expected]) => value.headers[name] === expected)),
  },
  ...(config.resources ?? []).map((resource, index) => ({
    key: `resource${index + 1}`,
    label: `Headers received for ${resource.label}`,
    run: () => headersOf(new URL(resource.url, base).href, 'HEAD'),
    assess: (value) =>
      pass(value.status === 200 && (!resource.contentType || value.headers['content-type'] === resource.contentType)),
  })),
  { key: 'storage', label: 'Storage', run: storage, assess: (value) => pass(value.localStorage === true) },
  {
    key: 'pageFeatures',
    label: 'Page features',
    run: pageFeatures,
    assess: (value) => pass(value.sharedArrayBuffer && value.wasmInstantiate === true && value.worker),
  },
  {
    key: 'worker',
    label: 'Module worker',
    run: () => askProbe({ type: 'capabilities' }),
    assess: (value) => pass(value.crossOriginIsolated && value.sharedArrayBuffer),
  },
  {
    key: 'blockingWait',
    label: 'Blocking wait in worker',
    run: crossThreadWait,
    assess: (value) => pass(value.outcome === 'ok' && value.value === 1),
  },
  {
    key: 'serviceWorker',
    label: 'Service worker',
    run: serviceWorker,
    assess: (value) =>
      pass(value.fetch?.body === 'intercepted:ping' && value.syncRequestFromWorker?.body === 'intercepted:worker'),
  },
  ...(config.appCheck
    ? [{ key: 'appCheck', label: config.appCheck.label, run: appCheck, assess: (value) => pass(value.passed) }]
    : []),
];

// Headline answers; derived from the checks above.
const summary = [
  ['Secure context', (r) => r.context?.value?.isSecureContext],
  ['Cross-origin isolated', (r) => r.context?.value?.crossOriginIsolated],
  ['Isolation headers as expected', (r) => r.pageHeaders?.status === 'pass'],
  ['Worker can block (SharedArrayBuffer)', (r) => r.blockingWait?.status === 'pass'],
  ['Service worker answers worker sync requests', (r) => r.serviceWorker?.status === 'pass'],
  ['WebAssembly runs', (r) => r.pageFeatures?.value?.wasmInstantiate === true],
  ['WebAssembly stack switching (JSPI)', (r) => r.pageFeatures?.value?.jspi],
  ...(config.appCheck ? [[config.appCheck.label, (r) => r.appCheck?.status === 'pass']] : []),
];

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, attributes);
  node.append(...children);
  return node;
}

// "Run all variants" visits each variant page in this tab and keeps the
// finished results in localStorage until the last page shows the combined report.
const RUN_KEY = 'diagnostics-run';
const RUN_MAX_AGE_MS = 15 * 60 * 1000;
const runStore = {
  read() {
    try {
      const run = JSON.parse(localStorage.getItem(RUN_KEY));
      if (run && Date.now() - run.started < RUN_MAX_AGE_MS) return run;
      localStorage.removeItem(RUN_KEY);
    } catch {
      // Unavailable storage means no run in progress; starting one reports the error.
    }
    return null;
  },
  write(run) {
    localStorage.setItem(RUN_KEY, JSON.stringify(run));
  },
  clear() {
    try {
      localStorage.removeItem(RUN_KEY);
    } catch {
      // Nothing was stored.
    }
  },
};
let run = runStore.read();

const results = {};
const thisVariant = () => ({
  time: new Date().toISOString(),
  url: location.href,
  results,
  cspViolations: violations,
});
// One format for a single page and for all variants: reports keyed by variant.
let reported = { [variant]: thisVariant() };
const report = () =>
  JSON.stringify(
    {
      tool: 'browser-diagnostics',
      version: KIT_VERSION,
      app: config.app,
      ...(config.configError ? { configError: config.configError } : {}),
      time: new Date().toISOString(),
      variants: reported,
    },
    null,
    2,
  );

const status = element('p', { id: 'status', role: 'status', textContent: 'Running checks…' });
const summaryTable = element('table', { className: 'summary' });
const table = element('div', { className: 'checks' });
const output = element('textarea', { id: 'report', readOnly: true, rows: 12, spellcheck: false });
const runAll = element('button', { type: 'button', textContent: 'Run all variants', disabled: true });
const copy = element('button', { type: 'button', textContent: 'Copy results', disabled: true });
const download = element('button', { type: 'button', textContent: 'Download report', disabled: true });
const notice = element('span', { className: 'notice', role: 'status' });
output.setAttribute('aria-label', 'Diagnostic results as JSON');
const setButtons = (enabled) => {
  for (const button of [runAll, copy, download]) button.disabled = !enabled;
};

copy.addEventListener('click', async () => {
  output.value = report();
  try {
    await navigator.clipboard.writeText(output.value);
    notice.textContent = 'Copied.';
  } catch {
    output.focus();
    output.select();
    notice.textContent = document.execCommand('copy')
      ? 'Copied.'
      : 'Copying is blocked here. Select the text below and copy it manually.';
  }
});

download.addEventListener('click', () => {
  output.value = report();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scope = Object.keys(reported).length > 1 ? 'all' : variant;
  const app = config.app.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const url = URL.createObjectURL(new Blob([output.value], { type: 'application/json' }));
  element('a', { href: url, download: `${app}-diagnostics-${scope}-${stamp}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  notice.textContent = 'Download started. If no file appears, use Copy results instead.';
});

function continueRun() {
  const next = order.find((name) => !(name in run.reports));
  if (next) {
    status.textContent = `Continuing with ${variants[next].label}…`;
    location.assign(new URL(variants[next].path, base));
    return;
  }
  reported = run.reports;
  runStore.clear();
  run = null;
  showSummary();
  status.textContent = 'All variants finished. Copy or download the combined report.';
}

runAll.addEventListener('click', () => {
  run = { started: Date.now(), reports: { [variant]: thisVariant() } };
  try {
    runStore.write(run);
  } catch (error) {
    run = null;
    results.runAll = { status: 'fail', error: `Cannot keep results between pages: ${describe(error)}` };
    output.value = report();
    notice.textContent =
      'This browser cannot keep results between pages. Open each variant and copy its results separately.';
    return;
  }
  setButtons(false);
  continueRun();
});

function showSummary() {
  const names = Object.keys(allVariants).filter((name) => name in reported);
  const head = element('tr', {}, element('th', { scope: 'col', textContent: 'Question' }));
  for (const name of names) head.append(element('th', { scope: 'col', textContent: name }));
  const body = summary.map(([label, answer]) => {
    const row = element('tr', {}, element('th', { scope: 'row', textContent: label }));
    for (const name of names) {
      const value = Boolean(answer(reported[name].results));
      row.append(element('td', { textContent: value ? 'yes' : 'no', className: value ? 'yes' : 'no' }));
    }
    return row;
  });
  summaryTable.replaceChildren(element('thead', {}, head), element('tbody', {}, ...body));
  output.value = report();
}

document.title = `${config.app} diagnostics`;
document.body.append(
  element(
    'main',
    {},
    element('h1', { textContent: `${config.app} diagnostics` }),
    element('p', { className: 'variant', textContent: current.label }),
    ...(config.configError ? [element('p', { className: 'no', textContent: config.configError })] : []),
    element('p', {
      textContent:
        `This page checks whether this browser can run ${config.app}. Wait until the checks have finished and ` +
        'press Run all variants: the page then opens the comparison variants in this tab. When the last one ' +
        'has finished, press Copy results or Download report and send the result to the app team.',
    }),
    element(
      'nav',
      {},
      ...Object.entries(variants).map(([name, { path, label }]) =>
        element('a', { href: new URL(path, base).href, textContent: label, ariaCurrent: name === variant ? 'page' : null }),
      ),
    ),
    status,
    element('div', { className: 'actions' }, runAll, copy, download, notice),
    element('h2', { textContent: 'Summary' }),
    summaryTable,
    output,
    element('h2', { textContent: 'Details' }),
    table,
  ),
);

const show = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

if (run) status.textContent = `Running all variants: ${Object.keys(run.reports).length + 1} of ${order.length}…`;
for (const [index, check] of checks.entries()) {
  if (!run) status.textContent = `Running check ${index + 1} of ${checks.length}: ${check.label}…`;
  const row = element('details', { className: 'check' });
  const badge = element('span', { className: 'badge', textContent: 'running' });
  row.append(element('summary', {}, badge, ` ${check.label}`));
  table.append(row);
  let entry;
  try {
    const value = await check.run();
    entry = { status: check.assess(value), value };
  } catch (error) {
    entry = { status: 'fail', error: describe(error) };
  }
  results[check.key] = entry;
  badge.textContent = entry.status;
  badge.dataset.status = entry.status;
  row.append(element('pre', { textContent: show(entry.value ?? entry.error) }));
  output.value = report();
}

if (run) {
  run.reports[variant] = thisVariant();
  try {
    runStore.write(run);
    continueRun();
  } catch (error) {
    // Show what was collected so far rather than losing it.
    reported = run.reports;
    results.runAll = { status: 'fail', error: `Cannot keep results between pages: ${describe(error)}` };
    runStore.clear();
    run = null;
    showSummary();
    status.textContent = 'Stopped: results could not be kept between pages. Copy or download what was collected.';
  }
} else {
  showSummary();
  status.textContent = 'All checks finished.';
}
if (!run) {
  setButtons(true);
  document.documentElement.dataset.done = 'true';
}
