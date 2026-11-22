// Service worker probe for the diagnostics pages. It answers only requests under
// <scope>sw-probe/ and leaves every other request to the network. The page
// unregisters it when the check finishes.
const probe = new URL('sw-probe/', self.registration.scope).pathname;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(probe)) return;
  event.respondWith(
    (async () => {
      const body = url.pathname.endsWith('/echo') ? await event.request.text() : 'ping';
      return new Response(`intercepted:${body}`, {
        headers: { 'Content-Type': 'text/plain', 'Cross-Origin-Resource-Policy': 'same-origin' },
      });
    })(),
  );
});
