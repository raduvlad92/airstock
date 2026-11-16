// The installed app's service worker (plan D13, ADR for scanning). It keeps a copy of the app
// shell only — the dashboard script and stylesheet, the barcode decoder, and the icons — so the
// installed app starts fast on a slow connection. It never stores pages, API responses, or shop
// data: every page and /api call goes to the network, so stock on screen is never a stale copy,
// and nothing works offline.
const CACHE = 'airstock-shell-v1';

// Network first, so a deploy reaches the phone at once; the copy answers when the network is
// slow (over two seconds) or gone, so the app still opens and shows its sign-in or error page.
const SHELL = ['/app/assets/app.js', '/app/assets/app.css', '/manifest.webmanifest'];
const SHELL_TIMEOUT_MS = 2000;
// Versioned paths never change, so a cached copy is always right.
const IMMUTABLE = [
  '/assets/vendor/zxing-wasm-3.1.6/zxing-reader.js',
  '/assets/vendor/zxing-wasm-3.1.6/zxing_reader.wasm',
];
const ICONS = ['/assets/icon.svg', '/assets/icon-180.png', '/assets/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([...SHELL, ...IMMUTABLE, ...ICONS]))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function networkFirst(request) {
  return caches.open(CACHE).then((cache) => {
    const network = fetch(request).then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    });
    const fallback = new Promise((resolve) => {
      setTimeout(() => cache.match(request).then((hit) => hit && resolve(hit)), SHELL_TIMEOUT_MS);
      network.catch(() => cache.match(request).then((hit) => resolve(hit || Response.error())));
    });
    return Promise.race([network.catch(() => fallback), fallback]);
  });
}

function cached(request, refresh) {
  return caches.open(CACHE).then((cache) =>
    cache.match(request).then((hit) => {
      const network = fetch(request).then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      });
      if (hit) {
        if (refresh) network.catch(() => {});
        return hit;
      }
      return network;
    }),
  );
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (SHELL.includes(path)) {
    event.respondWith(networkFirst(request));
  } else if (ICONS.includes(path)) {
    event.respondWith(cached(request, true));
  } else if (IMMUTABLE.includes(path) || /^\/app\/assets\/[\w.-]+-[\w-]{8,}\.js$/.test(path)) {
    // Lazy chunks have a content hash in their name.
    event.respondWith(cached(request, false));
  }
  // Everything else, including /app pages and /api, goes to the network as usual.
});
