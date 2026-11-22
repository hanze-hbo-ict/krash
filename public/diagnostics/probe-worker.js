// Probe worker for the diagnostics pages (module worker). It lives inside the
// service worker scope, so the service worker check can reach it.
const describe = (error) => `${error?.name ?? 'Error'}: ${error?.message ?? error}`;

function capabilities() {
  const result = {
    crossOriginIsolated: self.crossOriginIsolated,
    isSecureContext: self.isSecureContext,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    atomics: typeof Atomics !== 'undefined',
    webAssembly: typeof WebAssembly !== 'undefined',
    jspi: typeof WebAssembly !== 'undefined' && 'Suspending' in WebAssembly,
    controlledByServiceWorker: Boolean(self.navigator.serviceWorker?.controller),
  };
  try {
    // A short timed wait proves that this thread may block.
    const view = new Int32Array(new SharedArrayBuffer(4));
    result.atomicsWaitTimeout = Atomics.wait(view, 0, 0, 20);
  } catch (error) {
    result.atomicsWaitTimeout = describe(error);
  }
  return result;
}

function syncRequest(url) {
  // A synchronous request answered by a service worker is the known way to
  // block a worker for input without SharedArrayBuffer.
  const request = new XMLHttpRequest();
  request.open('POST', url, false);
  request.send('worker');
  return { status: request.status, body: request.responseText.slice(0, 80) };
}

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'capabilities') {
      postMessage({ ok: true, value: capabilities() });
    } else if (data.type === 'wait') {
      // The page notifies this shared cell after a delay.
      const view = new Int32Array(data.buffer);
      const started = performance.now();
      const outcome = Atomics.wait(view, 0, 0, 5000);
      postMessage({
        ok: true,
        value: { outcome, value: Atomics.load(view, 0), waitedMs: Math.round(performance.now() - started) },
      });
    } else if (data.type === 'sync-request') {
      postMessage({ ok: true, value: syncRequest(data.url) });
    }
  } catch (error) {
    postMessage({ ok: false, error: describe(error) });
  }
};
