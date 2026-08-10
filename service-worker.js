// ==========================================================================
// SERVICE WORKER — GDPM•LOG
// Strategi: NETWORK-FIRST untuk file aplikasi (index.html, script.js,
// style.css, data.js). Artinya kalau HP/laptop online, selalu ambil versi
// TERBARU dari server dulu — cache cuma dipakai kalau lagi offline.
//
// PENTING buat yang mau update file nanti: naikkan angka CACHE_VERSION di
// bawah ini setiap kali deploy perubahan, supaya cache lama otomatis
// dibersihkan dan tidak menumpuk.
//
// TAMBAHAN: begitu service worker BARU selesai ter-install dan siap
// menggantikan yang lama (activate), kita kirim pesan 'gudang-sw-updated'
// ke semua tab yang sedang terbuka. script.js akan menangkap pesan ini dan
// menampilkan banner "Versi baru tersedia — Muat ulang", supaya tab yang
// sudah lama terbuka TIDAK terus menjalankan JS versi lama (ini akar
// masalah error "Cannot read properties of null" yang sebelumnya muncul —
// tab lama tetap memakai script.js versi lama yang sudah ada di memori).
// ==========================================================================
const CACHE_VERSION = 'gdpm-log-v5';
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
    caches.keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clientsList) => {
        clientsList.forEach((client) => {
          client.postMessage({ type: 'gudang-sw-updated', version: CACHE_VERSION });
        });
      })
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
