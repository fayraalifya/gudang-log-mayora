// ==========================================================================
// SERVICE WORKER — GDPM•LOG
// Strategi: NETWORK-FIRST untuk file aplikasi (index.html, script.js,
// style.css, data.js). Artinya kalau HP/laptop online, selalu ambil versi
// TERBARU dari server dulu — cache cuma dipakai kalau lagi offline. Jadi
// tidak akan terjadi lagi kasus "sudah update tapi kelihatannya nggak
// berubah" gara-gara cache lama.
//
// PENTING buat yang mau update file nanti: naikkan angka CACHE_VERSION di
// bawah ini setiap kali deploy perubahan, supaya cache lama otomatis
// dibersihkan dan tidak menumpuk.
// ==========================================================================
const CACHE_VERSION = 'gdpm-log-v2';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './data.js',
  './firebase-config.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
  }
});