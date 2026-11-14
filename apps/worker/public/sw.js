// Installable shell (plan M7). Nothing is cached: every page and API call goes to the network,
// so a stale copy never shows stock that has changed.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
