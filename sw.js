// ══════════════════════════════════════════════════════════════════
//  Service Worker – Tesserine CAA
//  ⚙️  Aggiorna CACHE_NAME ad ogni deploy per forzare il refresh
// ══════════════════════════════════════════════════════════════════

const CACHE_NAME = 'caartella-v4.1';

const STATIC_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/dictionary.js',
  './js/drive.js',
  './js/parser.js',
  './js/arasaac.js',
  './js/lemmatizer.js',
  './js/custom-images.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  // jsPDF viene caricato da CDN – non cachato qui (troppo grande)
];

// ── Install: pre-cacha i file statici ─────────────────────────────
self.addEventListener('install', event => {
  self.skipWaiting();   // prende controllo immediatamente
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
});

// ── Activate: elimina cache vecchie ──────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: cache-first per asset locali, network-first per ARASAAC
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Le API ARASAAC vanno sempre in rete (immagini dinamiche)
  if (url.hostname.includes('arasaac.org')) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  // Asset locali: cache-first
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
