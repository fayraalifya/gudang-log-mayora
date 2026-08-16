// ==========================================================================
// CLOUD FUNCTIONS — GUDANG•LOG
//
// KENAPA FILE INI ADA:
// Sebelumnya, pendaftaran & login operator/admin dilakukan LANGSUNG dari
// browser ke Firestore: password di-hash (SHA-256 tanpa salt) di sisi
// client, lalu hash-nya disimpan di dokumen yang bisa DIBACA oleh siapa
// saja yang membuka aplikasi (karena Firestore Rules cuma mensyaratkan
// "request.auth != null", dan auth yang dipakai adalah Anonymous Sign-In —
// yang otomatis didapat siapa pun begitu halaman dimuat, TANPA kredensial
// apapun). Akibatnya siapa saja bisa buka console browser dan membaca
// seluruh passwordHash operator/admin secara langsung.
//
// Kode akses pendaftaran admin (KODE_AKSES_PENDAFTARAN_ADMIN) juga dulu
// hardcode di data.js — file yang dikirim ke SEMUA pengunjung situs — jadi
// siapa pun yang buka "View Page Source" bisa membaca kode itu dan
// mendaftar sebagai admin sendiri.
//
// PERBAIKAN:
// 1. Password TIDAK LAGI di-hash manual & disimpan di Firestore. Kita pakai
//    Firebase Authentication (email+password) yang sudah menangani hashing
//    aman (scrypt) di server Google — client tidak pernah menyentuh hash.
//    "Email" di sini disintesis dari NIK (bukan email asli), lihat
//    nikToSyntheticEmail() di bawah.
// 2. Dokumen Firestore di koleksi operator/admin sekarang HANYA berisi
//    profil publik (nama, idKaryawan, createdAt) — TIDAK ADA passwordHash.
// 3. Kode akses pendaftaran (operator & admin) disimpan sebagai Secret di
//    Cloud Functions (lihat REGISTRATION_CODES di bawah), BUKAN di kode
//    client — jadi tidak pernah terkirim ke browser sama sekali, dicek
//    hanya di server saat registerAccount dipanggil.
// 4. Role (operator/admin) disimpan sebagai Custom Claim di Firebase Auth
//    token milik user tsb. Firestore Rules bisa memeriksa
//    request.auth.token.role langsung tanpa perlu baca dokumen tambahan.
// 5. Pendaftaran memakai Firebase Auth sebagai sumber keunikan NIK: karena
//    "email" sintetis dibuat deterministik dari NIK+role, createUser()
//    akan otomatis gagal (auth/email-already-exists) kalau NIK itu sudah
//    terdaftar untuk role yang sama — ini atomik secara bawaan, tidak
//    butuh Firestore Transaction manual lagi.
//
// CARA DEPLOY (tidak bisa dijalankan dari sandbox ini — jalankan sendiri):
//   1. firebase login
//   2. cd functions && npm install
//   3. Set kode akses sebagai secret (nilainya TIDAK akan tersimpan di
//      kode sumber ataupun git):
//        firebase functions:secrets:set KODE_AKSES_OPERATOR
//        firebase functions:secrets:set KODE_AKSES_ADMIN
//      (masukkan nilai yang sama seperti KODE_AKSES_PENDAFTARAN /
//      KODE_AKSES_PENDAFTARAN_ADMIN yang lama, atau ganti dengan yang baru)
//   4. firebase deploy --only functions,firestore:rules
//   5. Project harus di plan Blaze (pay-as-you-go) — Cloud Functions tidak
//      jalan di plan gratis Spark. Untuk trafik skala internal seperti ini
//      biayanya biasanya masih masuk kuota gratis bulanan Blaze.
// ==========================================================================

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

const KODE_AKSES_OPERATOR = defineSecret("KODE_AKSES_OPERATOR");
const KODE_AKSES_ADMIN = defineSecret("KODE_AKSES_ADMIN");

const EMAIL_DOMAIN = "akun.gudanglog.internal"; // domain palsu, tidak pernah dipakai kirim email sungguhan
const VALID_ROLES = ["operator", "admin"];

function normalizeNik(nik) {
  return String(nik || "").trim();
}
function normalizeNamaKey(nama) {
  return String(nama || "").trim().toLowerCase();
}
// NIK -> "email" sintetis dipakai sebagai identitas login di Firebase Auth.
// Diberi awalan role (operator- / admin-) supaya NIK yang sama BISA dipakai
// terdaftar sebagai operator maupun admin secara terpisah, dan supaya akun
// operator tidak bisa "kebetulan" login lewat form admin atau sebaliknya.
function nikToSyntheticEmail(role, nik) {
  return `${role}-${normalizeNik(nik).toLowerCase()}@${EMAIL_DOMAIN}`;
}

/**
 * registerAccount({ role, nama, idKaryawan, password, kodeAkses })
 * Dipanggil dari layar "Daftar Baru" (operator maupun admin).
 * Kode akses pendaftaran divalidasi DI SINI (server), tidak pernah dikirim
 * ke browser.
 */
exports.registerAccount = onCall(
  { secrets: [KODE_AKSES_OPERATOR, KODE_AKSES_ADMIN], region: "asia-southeast2" },
  async (request) => {
    const data = request.data || {};
    const role = data.role;
    const nama = String(data.nama || "").trim();
    const idKaryawan = normalizeNik(data.idKaryawan);
    const password = String(data.password || "");
    const kodeAkses = String(data.kodeAkses || "").trim();

    if (!VALID_ROLES.includes(role)) {
      throw new HttpsError("invalid-argument", "Role tidak valid.");
    }
    if (!nama) {
      throw new HttpsError("invalid-argument", "Nama wajib diisi.");
    }
    if (!idKaryawan) {
      throw new HttpsError("invalid-argument", "ID Karyawan / NIK wajib diisi.");
    }
    if (!password || password.length < 6) {
      throw new HttpsError("invalid-argument", "Kata sandi minimal 6 karakter.");
    }

    const kodeValid = role === "admin" ? KODE_AKSES_ADMIN.value() : KODE_AKSES_OPERATOR.value();
    if (!kodeAkses || kodeAkses !== kodeValid) {
      throw new HttpsError(
        "permission-denied",
        role === "admin"
          ? "Kode Akses Pendaftaran Admin salah."
          : "Kode Akses Pendaftaran salah."
      );
    }

    const email = nikToSyntheticEmail(role, idKaryawan);
    const nikKey = idKaryawan;

    let userRecord;
    try {
      userRecord = await admin.auth().createUser({
        email,
        password,
        displayName: nama,
      });
    } catch (err) {
      if (err && err.code === "auth/email-already-exists") {
        throw new HttpsError(
          "already-exists",
          role === "admin"
            ? "NIK ini sudah terdaftar sebagai admin."
            : "NIK ini sudah terdaftar."
        );
      }
      console.error("Gagal membuat user Auth:", err);
      throw new HttpsError("internal", "Gagal mendaftar. Coba lagi.");
    }

    try {
      await admin.auth().setCustomUserClaims(userRecord.uid, {
        role,
        idKaryawan: nikKey,
      });

      // Profil publik saja — TIDAK ADA password/hash di sini.
      await admin
        .firestore()
        .collection(role) // 'operator' atau 'admin'
        .doc(nikKey)
        .set({
          nama,
          namaLower: normalizeNamaKey(nama),
          idKaryawan: nikKey,
          uid: userRecord.uid,
          createdAt: Date.now(),
        });
    } catch (err) {
      // Rollback supaya tidak ada user Auth "yatim" tanpa profil Firestore.
      console.error("Gagal menulis profil, rollback user Auth:", err);
      await admin.auth().deleteUser(userRecord.uid).catch(() => {});
      throw new HttpsError("internal", "Gagal mendaftar. Coba lagi.");
    }

    return { success: true };
  }
);

/**
 * deleteAccount({ role, idKaryawan })
 * Dipanggil dari panel admin ("Hapus akun operator"). HANYA admin yang
 * sedang login (dicek lewat custom claim di token, bukan yang diklaim
 * client) yang boleh memanggil ini.
 */
exports.deleteAccount = onCall({ region: "asia-southeast2" }, async (request) => {
  if (!request.auth || request.auth.token.role !== "admin") {
    throw new HttpsError("permission-denied", "Hanya admin yang boleh menghapus akun.");
  }

  const data = request.data || {};
  const role = data.role;
  const idKaryawan = normalizeNik(data.idKaryawan);

  if (!VALID_ROLES.includes(role) || !idKaryawan) {
    throw new HttpsError("invalid-argument", "Data tidak lengkap.");
  }

  const docRef = admin.firestore().collection(role).doc(idKaryawan);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Akun tidak ditemukan.");
  }
  const uid = snap.data().uid;

  if (uid) {
    await admin.auth().deleteUser(uid).catch((err) => {
      // Kalau user Auth-nya sudah tidak ada (misal terhapus manual), tetap
      // lanjutkan menghapus dokumen profilnya supaya tidak nyangkut.
      console.warn("Gagal menghapus user Auth (dilanjutkan):", err);
    });
  }
  await docRef.delete();

  return { success: true };
});
