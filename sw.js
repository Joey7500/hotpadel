/* HotPadel service worker – aplikace se otevře i bez signálu. Data řeší app.js (cache + fronta). */
const CACHE = 'hotpadel-v7';
const SHELL = [
  './', 'index.html', 'style.css?v=7', 'app.js?v=7', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/apple-touch-icon.png',
  'avatars/honza.jpg?v=1', 'avatars/martin.jpg?v=1', 'avatars/pepa.jpg?v=1', 'avatars/matous.jpg?v=1',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.58.0/dist/umd/supabase.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co')) return; // data vždy živě

  if (url.origin === self.location.origin) {
    // vlastní soubory: síť (max 4 s), jinak uložená kopie
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; });
      try {
        return await Promise.race([net, timeout(4000)]);
      } catch (err) {
        const hit = await cache.match(req) || await cache.match(req, { ignoreSearch: true })
          || (req.mode === 'navigate' ? await cache.match('index.html') || await cache.match('./') : null);
        if (hit) return hit;
        return net; // nic v cache → počkáme na síť
      }
    })());
    return;
  }

  // knihovny a fonty z CDN (verze se nemění): cache, na pozadí aktualizace
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const net = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  })());
});
