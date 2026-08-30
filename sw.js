/* ═══════════════════════════════════════════════════════════════════════════
   sw.js — kiszolgáló a háttérben (service worker)

   Csak akkor számít, ha az appot böngészőből, weblapként használod (GitHub
   Pages). Az APK-ban a fájlok amúgy is a telefonon vannak.

   Dolga: az app saját fájljait eltenni, hogy net nélkül is elinduljon.

   AMIT SOHA NEM TESZ EL: a GitHub felé menő kéréseket. Ha a szinkron válaszait
   gyorsítótárazná, a telefon a régi feliratokat és a régi pozíciót látná —
   pontosan azt rontaná el, amiért az egész app készült.
   ═══════════════════════════════════════════════════════════════════════════ */

const CACHE = 'subcast-olvaso-v2';

const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/main.js',
  './js/store.js',
  './js/native.js',
  './js/library.js',
  './js/srt.js',
  './js/player.js',
  './js/reader.js',
  './js/cloud.js',
  './js/covers.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // A szinkron adatai SOHA nem jöhetnek gyorsítótárból.
  if (url.hostname.endsWith('github.com') || url.hostname.endsWith('githubusercontent.com')) {
    return;
  }
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(hit => {
      if (hit) {
        // Van gyorsítótárból, de a háttérben frissítsük is: legközelebb már az új jön.
        event.waitUntil(
          fetch(event.request)
            .then(res => res.ok && caches.open(CACHE).then(c => c.put(event.request, res)))
            .catch(() => {})
        );
        return hit;
      }
      return fetch(event.request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then(c => c.put(event.request, copy)));
        }
        return res;
      });
    })
  );
});
