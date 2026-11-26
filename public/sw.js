'use strict';
// Service worker: face aplicația instalabilă. Totul vine întâi de la server; copiile din cache se folosesc
// doar fără conexiune. API-ul nu se pune niciodată în cache, ca previziunile să fie mereu cele actuale.

const VERSION = 'nostra-v11';
const SHELL = ['/', '/style.css', '/client-state.js', '/app.js', '/icon.svg', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('nostra-v') && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (['/api/', '/admin', '/og/', '/p/', '/pay/'].some(prefix => url.pathname.startsWith(prefix))) return;

  // Pagini: întâi rețeaua (titlul și previzualizarea sunt puse de server), apoi cache-ul.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }

  // Fișierele interfeței: tot întâi rețeaua (ca pagina și scriptul să fie mereu din aceeași versiune),
  // iar copia din cache doar când nu e conexiune.
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && !/\b(?:private|no-store)\b/i.test(res.headers.get('Cache-Control') || '')) {
      const copy = res.clone();
      caches.open(VERSION).then((cache) => cache.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }))); // fără rețea: orice versiune salvată
});
