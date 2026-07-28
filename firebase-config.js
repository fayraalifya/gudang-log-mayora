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

window.gudangFirebase = {
  db,
  auth,
  laporanCol: collection(db, LAPORAN_COLLECTION),
  operatorCol: collection(db, OPERATOR_COLLECTION),
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot,
  writeBatch,
  getDocs,
};

// ---- Autentikasi anonim ----
// script.js menunggu event 'gudang-firebase-ready' sebelum mulai
// mendengarkan (onSnapshot) koleksi 'laporan'. Event ini sekarang baru
// ditembakkan SETELAH proses sign-in anonim berhasil, bukan langsung
// setelah Firebase App diinisialisasi.
onAuthStateChanged(auth, (user) => {
  if (user) {
    window.gudangFirebase.currentUser = user;
    window.dispatchEvent(new Event("gudang-firebase-ready"));
  }
});

signInAnonymously(auth).catch((err) => {
  console.error("Gagal sign-in anonim ke Firebase:", err);
  window.dispatchEvent(new CustomEvent("gudang-firebase-auth-error", { detail: err }));
});