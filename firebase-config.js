// ==========================================================================
// KONFIGURASI FIREBASE — GUDANG•LOG
// File ini menginisialisasi koneksi ke project Firebase "gudang-log-mayora"
// dan menyediakan variabel global (window.gudangFirebase) yang dipakai oleh
// script.js untuk membaca/menulis data laporan secara real-time ke Firestore.
//
// Sekarang menggunakan Firebase Authentication (Anonymous Sign-In) supaya
// Firestore Security Rules bisa mensyaratkan request.auth != null — jadi
// hanya klien yang benar-benar menjalankan aplikasi ini (lewat SDK Firebase)
// yang bisa baca/tulis data, bukan sembarang orang yang tahu apiKey/projectId.
//
// CATATAN: apiKey di bawah ini AMAN untuk ditampilkan di kode client-side.
// Keamanan sesungguhnya diatur lewat Firestore Security Rules + Auth,
// bukan oleh kerahasiaan apiKey ini.
//
// TAMBAHAN: koleksi "operator" dipakai untuk menyimpan akun operator
// (nama + kata sandi) supaya operator harus mendaftar dulu sebelum bisa
// masuk. Ini dipakai oleh fitur "Daftar Baru" / "Masuk" di layar login.
// ==========================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot,
  writeBatch,
  getDocs,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyCe0vTJoo97MV-Vrk5a-WCKoH840jz1yaI",
  authDomain: "gudang-log-mayora.firebaseapp.com",
  projectId: "gudang-log-mayora",
  storageBucket: "gudang-log-mayora.firebasestorage.app",
  messagingSenderId: "1033142924756",
  appId: "1:1033142924756:web:5e3ecdf858e46730599241",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const LAPORAN_COLLECTION = "laporan";
const OPERATOR_COLLECTION = "operator";
const BARANG_BARU_COLLECTION = "barangBaru";
const PEMILIK_BARU_COLLECTION = "pemilikBaru";

// ---- Promise "auth siap" ----
// Alih-alih memaksa setiap pemanggil mendengarkan event manual
// (addEventListener + cleanup), kita sediakan satu Promise yang bisa
// langsung di-`await`. Promise "mengingat" hasilnya sendiri: kalau
// dipanggil setelah auth sudah selesai, dia langsung resolve — tidak
// perlu logika "if (sudahSiap) ... else dengarkan event".
//
// Contoh pemakaian di script.js:
//   await window.gudangFirebase.authReady;
//   // di sini auth sudah pasti siap, aman baca/tulis Firestore
let resolveAuthReady, rejectAuthReady;
const authReady = new Promise((resolve, reject) => {
  resolveAuthReady = resolve;
  rejectAuthReady = reject;
});

window.gudangFirebase = {
  db,
  auth,
  authReady,
  laporanCol: collection(db, LAPORAN_COLLECTION),
  operatorCol: collection(db, OPERATOR_COLLECTION),
  barangBaruCol: collection(db, BARANG_BARU_COLLECTION),
  pemilikBaruCol: collection(db, PEMILIK_BARU_COLLECTION),
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot,
  writeBatch,
  getDocs,
  query,
  where,
};

// ---- Autentikasi anonim ----
// script.js bisa `await window.gudangFirebase.authReady` ATAU tetap
// mendengarkan event 'gudang-firebase-ready' di bawah ini (dipertahankan
// supaya kode lama yang masih pakai event tidak perlu diubah). Keduanya
// ditembakkan bersamaan, SETELAH proses sign-in anonim berhasil.
onAuthStateChanged(auth, (user) => {
  if (user) {
    window.gudangFirebase.currentUser = user;
    resolveAuthReady(user);
    window.dispatchEvent(new Event("gudang-firebase-ready"));
  }
});

signInAnonymously(auth).catch((err) => {
  console.error("Gagal sign-in anonim ke Firebase:", err);
  rejectAuthReady(err);
  window.dispatchEvent(new CustomEvent("gudang-firebase-auth-error", { detail: err }));
});