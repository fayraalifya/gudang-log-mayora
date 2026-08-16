// ==========================================================================
// KONFIGURASI FIREBASE — GUDANG•LOG
// File ini menginisialisasi koneksi ke project Firebase "gudang-log-mayora"
// dan menyediakan variabel global (window.gudangFirebase) yang dipakai oleh
// script.js untuk membaca/menulis data laporan secara real-time ke Firestore.
//
// CATATAN: apiKey di bawah ini AMAN untuk ditampilkan di kode client-side.
// Keamanan sesungguhnya diatur lewat Firestore Security Rules + Auth,
// bukan oleh kerahasiaan apiKey ini.
//
// ---- PERUBAHAN KEAMANAN PENTING ----
// Sebelumnya file ini memakai Anonymous Sign-In (signInAnonymously), yang
// otomatis memberi SIAPA SAJA yang membuka halaman ini sebuah sesi
// "authenticated" tanpa kredensial apapun — termasuk lewat console browser,
// tanpa pernah menyentuh layar login aplikasi. Firestore Rules yang cuma
// mensyaratkan `request.auth != null` jadi tidak benar-benar membatasi
// siapa pun.
//
// Sekarang dipakai Firebase Authentication EMAIL+PASSWORD sungguhan.
// Operator/admin "masuk" lewat signInWithEmailAndPassword (dipanggil dari
// script.js dengan email sintetis dari NIK — lihat nikToSyntheticEmail di
// script.js), dan Firebase Auth sendiri yang menangani hashing password
// secara aman di server Google.
//
// ---- TIDAK PAKAI CLOUD FUNCTIONS (project sengaja tetap plan Spark) ----
// Karena tidak ada Cloud Functions, custom claim `role` TIDAK BISA diset
// (butuh Admin SDK). Sebagai gantinya:
//  - Role ditentukan dari KOLEKSI tempat dokumen profil user berada
//    (operator/{uid} atau admin/{uid}), dicek lewat exists() di
//    firestore.rules berdasarkan request.auth.uid.
//  - Pendaftaran (createUserWithEmailAndPassword) & "hapus akun" jalan
//    LANGSUNG dari client SDK — lihat registerViaClientSDK() di script.js
//    dan firestore.rules untuk detail & trade-off keamanannya (kode akses
//    pendaftaran tidak lagi divalidasi Cloud Function, tapi lewat trik
//    "registrationGate" di firestore.rules).
//  - deleteUser dari SDK Auth cuma bisa menghapus user yang SEDANG login —
//    dipakai untuk rollback registrasi kalau kode akses salah, BUKAN untuk
//    admin menghapus akun operator lain (itu jadi soft-delete dokumen
//    Firestore saja, lihat script.js).
//
// Sesi Firebase Auth sengaja diset "session persistence" (browserSessionPersistence)
// supaya perilakunya konsisten dengan sesi aplikasi yang ada (tersimpan di
// sessionStorage, hilang begitu tab ditutup) — lihat SESSION_KEY di
// script.js.
// ==========================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  collection,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  writeBatch,
  runTransaction,
  getDocs,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  getAuth,
  setPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  deleteUser,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
// Cloud Functions TIDAK dipakai lagi (project sengaja tetap plan Spark,
// tidak ada billing) — import getFunctions/httpsCallable dihapus.

const firebaseConfig = {
  apiKey: "AIzaSyCe0vTJoo97MV-Vrk5a-WCKoH840jz1yaI",
  authDomain: "gudang-log-mayora.firebaseapp.com",
  projectId: "gudang-log-mayora",
  storageBucket: "gudang-log-mayora.firebasestorage.app",
  messagingSenderId: "1033142924756",
  appId: "1:1033142924756:web:5e3ecdf858e46730599241",
};

const app = initializeApp(firebaseConfig);

// ---- Firestore dengan PERSISTENSI OFFLINE ----
// (tidak berubah — lihat catatan versi sebelumnya)
let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
  });
} catch (err) {
  console.warn("Persistensi offline tidak didukung di browser ini, memakai cache memori biasa:", err);
  db = initializeFirestore(app, {});
}

const auth = getAuth(app);

const LAPORAN_COLLECTION = "laporan";
const OPERATOR_COLLECTION = "operator";
const ADMIN_COLLECTION = "admin";
const BARANG_BARU_COLLECTION = "barangBaru";
const PEMILIK_BARU_COLLECTION = "pemilikBaru";

// ---- Promise "SDK siap" ----
// Beda dari versi lama: ini TIDAK LAGI menunggu proses sign-in (karena
// sekarang login hanya terjadi saat pengguna submit form login, bukan
// otomatis saat halaman dibuka). Promise ini cuma menandai bahwa Firebase
// SDK sudah selesai diinisialisasi dan siap dipakai — termasuk menunggu
// satu kali callback onAuthStateChanged pertama, supaya kalau ada sesi
// Firebase Auth yang masih valid dari reload sebelumnya (dalam tab yang
// sama), itu sempat terdeteksi dulu sebelum dipakai.
let resolveAuthReady;
const authReady = new Promise((resolve) => {
  resolveAuthReady = resolve;
});
let authReadyResolved = false;

setPersistence(auth, browserSessionPersistence)
  .catch((err) => console.warn("Gagal set auth persistence, memakai default:", err))
  .finally(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      window.gudangFirebase.currentUser = user;
      if (!authReadyResolved) {
        authReadyResolved = true;
        resolveAuthReady(user);
        window.dispatchEvent(new Event("gudang-firebase-ready"));
      }
    });
    window.gudangFirebase._unsubAuthState = unsub;
  });

window.gudangFirebase = {
  db,
  auth,
  authReady,
  laporanCol: collection(db, LAPORAN_COLLECTION),
  operatorCol: collection(db, OPERATOR_COLLECTION),
  adminCol: collection(db, ADMIN_COLLECTION),
  barangBaruCol: collection(db, BARANG_BARU_COLLECTION),
  pemilikBaruCol: collection(db, PEMILIK_BARU_COLLECTION),
  collection,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  writeBatch,
  runTransaction,
  getDocs,
  query,
  where,
  // ---- Auth ----
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  deleteUser,
  signOut,
};
