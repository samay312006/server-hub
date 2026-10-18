// Minimal PWA service worker: cache-first for hashed assets, network-first for the shell.
// API and streaming routes are never intercepted.
const CACHE = 'hub-v1'

self.addEventListener('install', (e) => self.skipWaiting())
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return
  if (url.pathname.startsWith('/api/')) return

  if (url.pathname.startsWith('/assets/')) {
    // immutable hashed assets: cache-first
    e.respondWith(
      caches.open(CACHE).then((c) =>
        c.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r }))
      )
    )
    return
  }

  // shell: network-first with cache fallback (offline shows last UI)
  e.respondWith(
    fetch(e.request)
      .then((r) => { if (r.ok) caches.open(CACHE).then((c) => c.put(e.request, r.clone())); return r })
      .catch(() => caches.match(e.request))
  )
})
