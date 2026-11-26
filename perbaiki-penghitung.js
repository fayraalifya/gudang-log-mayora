// Cara pakai: login sebagai ADMIN di aplikasi, buka console browser (F12),
// paste seluruh isi file ini lalu Enter. Menghitung ulang penghitung
// kapasitasLokasi & stokLokasi dari laporan yang ada (yang tidak dihapus).
(async () => {
  const fb = window.gudangFirebase;
  const snap = await fb.getDocs(fb.laporanCol);
  const kap = new Map(), stok = new Map(), lokasiAneh = [];
  snap.docs.forEach(d => {
    const t = d.data();
    if (t.dihapus) return;
    if (t.lokasi && t.lokasi !== normalizeLokasi(t.lokasi)) lokasiAneh.push(d.id + ' -> "' + t.lokasi + '"');
    const k = kontribusiPalletEntry(t);
    if (k) kap.set(k.lokasi, (kap.get(k.lokasi) || 0) + k.delta);
    const s = kontribusiStokEntry(t);
    if (s) stok.set(s.key, (stok.get(s.key) || 0) + s.delta);
  });
  const [kapOld, stokOld] = await Promise.all([
    fb.getDocs(fb.kapasitasLokasiCol),
    fb.getDocs(fb.collection(fb.db, 'stokLokasi')),
  ]);
  kapOld.docs.forEach(d => { if (!kap.has(d.id)) kap.set(d.id, 0); });
  stokOld.docs.forEach(d => { if (!stok.has(d.id)) stok.set(d.id, 0); });

  const tulis = [];
  kap.forEach((v, id) => tulis.push([fb.doc(fb.db, 'kapasitasLokasi', id), { pallet: v, updatedAt: Date.now() }]));
  stok.forEach((v, id) => tulis.push([fb.doc(fb.db, 'stokLokasi', id), { pcs: v, updatedAt: Date.now() }]));
  for (let i = 0; i < tulis.length; i += 400) {
    const b = fb.writeBatch(fb.db);
    tulis.slice(i, i + 400).forEach(([ref, data]) => b.set(ref, data, { merge: true }));
    await b.commit();
  }
  console.log('Selesai. Penghitung ditulis ulang:', tulis.length);
  console.log('Laporan dengan lokasi tidak ternormalisasi (perbaiki lewat Edit Laporan):', lokasiAneh);
})();
