/* MotoRoutes Greece — service worker
 *
 * Offline: κρατά το shell (HTML + hashed assets + icons) ώστε η εφαρμογή να ανοίγει
 * χωρίς δίκτυο. Δεν αγγίζει Firebase, OSM tiles ή Google Fonts — αυτά μένουν network-only
 * (τα tiles του OSM δεν επιτρέπεται να κατεβαίνουν μαζικά, βλ. tile usage policy).
 *
 * Στρατηγική:
 *   - navigation  -> network-first, fallback στο cached index.html
 *   - /assets/*   -> cache-first (τα ονόματα έχουν hash, άρα immutable)
 *   - icons/favicon -> cache-first
 *   - manifest    -> stale-while-revalidate
 */

const CACHE = 'moto-shell-v2';

/* ΣΗΜΕΙΩΣΗ: το ./index.html ΔΕΝ μπαίνει εδώ. Το Cloudflare μπορεί να κάνει redirect /index.html -> /,
   και ένα redirected response δεν επιτρέπεται να σερβιριστεί σε navigation. Το index.html
   αποθηκεύεται καθαρό (new Response) στο precache() παρακάτω. */
const CORE = [
  './',
  './favicon.svg',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

/* Τα hashed assets τα ανακαλύπτουμε από το ίδιο το index.html, ώστε να μη χρειάζεται
   χειροκίνητη ενημέρωση της λίστας μετά από κάθε build. */
function assetUrlsFrom(html) {
  const re = /(?:src|href)="(\.\/assets\/[^"]+)"/g;
  const urls = [];
  let match;
  while ((match = re.exec(html))) urls.push(match[1]);
  return urls;
}

async function precache() {
  const cache = await caches.open(CACHE);
  let assets = [];

  try {
    const res = await fetch('./index.html', { cache: 'no-cache' });
    if (res.ok) {
      const html = await res.text();
      assets = assetUrlsFrom(html);
      await cache.put(
        './index.html',
        new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      );
    }
  } catch (e) {
    /* Πρώτη εγκατάσταση χωρίς δίκτυο: κρατάμε μόνο ό,τι μπορούμε. */
  }

  const urls = CORE.concat(assets);
  await Promise.all(urls.map((url) => cache.add(url).catch(() => {})));

  /* Καθαρίζουμε παλιά hashed assets από προηγούμενα builds. */
  const keep = new Set(urls.map((url) => new URL(url, self.registration.scope).href));
  for (const request of await cache.keys()) {
    if (!keep.has(request.url)) await cache.delete(request);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('moto-shell-') && name !== CACHE)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Firebase, fonts, tiles: network μόνο

  /* Πλοήγηση: φρέσκο HTML όταν υπάρχει δίκτυο, αλλιώς το cached shell. */
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const type = fresh.headers.get('content-type') || '';
          if (fresh.ok && type.includes('text/html')) {
            const cache = await caches.open(CACHE);
            cache.put('./index.html', fresh.clone());
          }
          return fresh;
        } catch (e) {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match('./index.html')) ||
            (await cache.match('./')) ||
            new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
          );
        }
      })()
    );
    return;
  }

  /* Hashed assets + icons: cache-first. */
  const isStatic =
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.endsWith('/favicon.svg');

  if (isStatic) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      })()
    );
    return;
  }

  /* Manifest: δείξε το cached αμέσως, ανανέωσε στο background. */
  if (url.pathname.endsWith('/manifest.json')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(request);
        const network = fetch(request)
          .then((res) => {
            if (res.ok) cache.put(request, res.clone());
            return res;
          })
          .catch(() => null);
        return hit || (await network) || new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      })()
    );
  }
});
