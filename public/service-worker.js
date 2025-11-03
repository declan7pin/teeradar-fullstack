/* TeeRadar SW: cache app shell + assets; network-first for HTML, cache-first for static */
const VERSION = 'tr-v1';
const APP_SHELL = [
  '/', '/index.html', '/book.html', '/dashboard.html', '/faq.html',
  '/privacy.html', '/terms.html', '/refunds.html', '/offline.html',
  '/assets/hero_golf_bg.jpg',
  '/assets/providers.js', '/assets/config.js',
  '/manifest.webmanifest'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then(c => c.addAll(APP_SHELL)).then(()=> self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== VERSION).map(k => caches.delete(k))
    )).then(()=> self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // API: network-first (don’t cache dynamic bookings)
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(req).catch(() => new Response(JSON.stringify({ ok:false, offline:true }), {
        headers: { 'Content-Type': 'application/json' }
      }))
    );
    return;
  }

  // HTML pages: network-first, fallback to cache, then offline page
  if (req.destination === 'document' || req.headers.get('accept')?.includes('text/html')) {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(req, copy));
        return res;
      }).catch(async () => {
        const cached = await caches.match(req);
        return cached || caches.match('/offline.html');
      })
    );
    return;
  }

  // Static assets: cache-first
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(req, copy));
      return res;
    }))
  );
});
