// ==========================================================================
// CLOUD FUNCTIONS — GUDANG•LOG
// ==========================================================================
// keluarkanBarang: satu-satunya cara sah untuk menulis dokumen laporan
// jenis 'keluar' tipe 'transaksi' ke Firestore. firestore.rules melarang
// client menulis langsung dokumen jenis ini (lihat firestore.rules) —
// jadi jalur INI (lewat Admin SDK, yang otomatis melewati security rules)
// menjadi satu-satunya pintu masuk. Itu sebabnya validasi stok di sini
// tidak bisa dibypass dari browser/DevTools/API call manual.
//
// Kenapa pakai runTransaction(): supaya "baca stok terkini -> validasi ->
// tulis dokumen baru" jadi SATU operasi atomic. Kalau dua operator submit
// barang keluar dari kombinasi yang sama nyaris bersamaan, Firestore akan
// otomatis me-retry transaksi yang datanya berubah duluan, jadi race
// condition (stok jadi minus) tidak mungkin terjadi.
//
// KONSEKUENSI PENTING: karena ini Cloud Function (bukan tulis langsung ke
// Firestore), fungsi ini WAJIB koneksi internet aktif. Transaksi keluar
// TIDAK bisa di-queue offline seperti transaksi masuk. Ini keputusan yang
// sudah disepakati (operator selalu online saat input keluar).
// ==========================================================================

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();
const LAPORAN_COLLECTION = "laporan";

function asTrimmedString(v) {
  return typeof v === "string" ? v.trim() : "";
}

exports.keluarkanBarang = onCall(
  {
    region: "asia-southeast2", // Jakarta — sesuaikan kalau region project beda
  },
  async (request) => {
    // Auth anonim tetap wajib ada (sama seperti syarat request.auth != null
    // di firestore.rules untuk koleksi lain).
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sesi Firebase belum siap. Muat ulang halaman lalu coba lagi.");
    }

    const data = request.data || {};
    const operator = asTrimmedString(data.operator);
    const kodeBarang = asTrimmedString(data.kodeBarang);
    const namaBarang = asTrimmedString(data.namaBarang);
    const supplier = asTrimmedString(data.supplier);
    const pemilik = asTrimmedString(data.pemilik);
    const lokasi = asTrimmedString(data.lokasi);
    const tanggal = asTrimmedString(data.tanggal);
    const jumlah = Math.trunc(Number(data.jumlah));
    const qtyPerPallet = data.qtyPerPallet != null && data.qtyPerPallet !== "" ? Number(data.qtyPerPallet) : null;
    const jumlahPallet = data.jumlahPallet != null && data.jumlahPallet !== "" ? Number(data.jumlahPallet) : null;

    // ---- Validasi input dasar (mirror dari validasi form di script.js) ----
    if (!operator) throw new HttpsError("invalid-argument", "Nama operator wajib diisi.");
    if (!kodeBarang) throw new HttpsError("invalid-argument", "Barang belum dipilih.");
    if (!namaBarang) throw new HttpsError("invalid-argument", "Nama barang tidak valid.");
    if (!supplier) throw new HttpsError("invalid-argument", "Supplier wajib diisi.");
    if (!pemilik) throw new HttpsError("invalid-argument", "Pemilik barang wajib diisi.");
    if (!lokasi) throw new HttpsError("invalid-argument", "Lokasi wajib discan/diisi.");
    if (!tanggal) throw new HttpsError("invalid-argument", "Tanggal wajib diisi.");
    if (!Number.isFinite(jumlah) || jumlah <= 0) {
      throw new HttpsError("invalid-argument", "Jumlah barang harus angka lebih dari 0.");
    }
    if (jumlah >= 1000000) {
      throw new HttpsError("invalid-argument", "Jumlah barang terlalu besar.");
    }

    const laporanCol = db.collection(LAPORAN_COLLECTION);

    const result = await db.runTransaction(async (tx) => {
      // Ambil SEMUA transaksi (masuk & keluar, tipe apa pun) untuk
      // kombinasi kodeBarang+supplier+pemilik+lokasi yang persis sama —
      // sama persis dengan logika getStokKombinasi() di script.js, cuma
      // dijalankan di server jadi tidak bisa dibohongi client.
      const q = laporanCol
        .where("kodeBarang", "==", kodeBarang)
        .where("supplier", "==", supplier)
        .where("pemilik", "==", pemilik)
        .where("lokasi", "==", lokasi);

      const snap = await tx.get(q);

      let stok = 0;
      snap.forEach((docSnap) => {
        const d = docSnap.data();
        const j = Number(d.jumlah) || 0;
        if (d.jenis === "masuk") stok += j;
        else if (d.jenis === "keluar") stok -= j;
      });

      if (jumlah > stok) {
        throw new HttpsError(
          "failed-precondition",
          `Jumlah keluar (${jumlah.toLocaleString("id-ID")} pcs) melebihi stok kombinasi ini ` +
            `(supplier ${supplier}, pemilik ${pemilik}, lokasi ${lokasi}): ${stok.toLocaleString("id-ID")} pcs.`
        );
      }

      const now = Date.now();
      const newDocRef = laporanCol.doc();
      const entryData = {
        jenis: "keluar",
        tipe: "transaksi",
        operator,
        kodeBarang,
        namaBarang,
        supplier,
        pemilik,
        lokasi,
        jumlah,
        qtyPerPallet,
        jumlahPallet,
        keterangan: "",
        tanggal,
        createdAt: now,
        updatedAt: now,
      };
      tx.set(newDocRef, entryData);

      return { id: newDocRef.id, sisaStokSetelah: stok - jumlah };
    });

    return result;
  }
);
