/* ==========================================================================
   UTILITY FUNCTIONS
========================================================================== */
const BULAN = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
const BULAN_PANJANG = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

function todayISO() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function isoOfDate(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function formatTanggal(iso) {
  if (!iso) return '-';
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  const [y, m, d] = parts;
  return `${parseInt(d, 10)} ${BULAN[parseInt(m, 10) - 1]} ${y}`;
}

function formatWaktu(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ==========================================================================
   SEARCHABLE SELECT (reusable component)
========================================================================== */
const openPanels = [];

function setupSearchableSelect({ id, options, getLabel, getSub, onSelect, placeholder, allowAdd, onAdd, addMode }) {
  const wrap = document.getElementById(id);
  const btn = document.getElementById(`${id}-btn`);
  const valueEl = document.getElementById(`${id}-value`);
  const panel = document.getElementById(`${id}-panel`);
  const search = document.getElementById(`${id}-search`);
  const list = document.getElementById(`${id}-list`);

  if (!wrap || !btn || !valueEl || !panel || !search || !list) {
    console.warn(`setupSearchableSelect: markup untuk "${id}" tidak ditemukan, dilewati.`);
    return { getValue: () => null, reset: () => {}, setValue: () => {}, updateOptions: () => {} };
  }

  let selected = null;
  let currentOptions = options;
  let addBusy = false;

  function closeThis() { panel.hidden = true; btn.classList.remove('is-open'); }
  openPanels.push(closeThis);

  function selectOption(o) {
    selected = o;
    valueEl.textContent = getLabel(o);
    valueEl.classList.add('has-value');
    closeThis();
    search.value = '';
    onSelect(o);
  }

  function renderAddForm(query) {
    const box = document.createElement('div');
    box.className = 'option-item-add-form';
    box.innerHTML = `
      <div class="add-form-title">Barang belum ada di daftar. Tambahkan sebagai barang baru:</div>
      <label class="add-form-lbl">Nama Barang</label>
      <input type="text" class="add-form-nama" value="${escapeHtml(query)}" placeholder="Nama barang">
      <label class="add-form-lbl">Kode Barang</label>
      <input type="text" class="add-form-kode" placeholder="Contoh: 2051019099">
      <div class="add-form-actions">
        <button type="button" class="btn-mini btn-mini-cancel add-form-cancel">Batal</button>
        <button type="button" class="btn-mini btn-mini-save add-form-confirm">+ Tambahkan</button>
      </div>
    `;
    const namaInput = box.querySelector('.add-form-nama');
    const kodeInput = box.querySelector('.add-form-kode');
    box.querySelector('.add-form-cancel').addEventListener('click', () => renderList(search.value));
    box.querySelector('.add-form-confirm').addEventListener('click', async () => {
      if (addBusy) return;
      const nama = namaInput.value.trim().toUpperCase();
      const kode = kodeInput.value.trim();
      if (!nama) return namaInput.focus();
      if (!kode) return kodeInput.focus();
      const dup = currentOptions.find(o => String(o.kode) === kode);
      if (dup) {
        selectOption(dup);
        return;
      }
      addBusy = true;
      const confirmBtn = box.querySelector('.add-form-confirm');
      const originalTxt = confirmBtn.textContent;
      confirmBtn.textContent = 'Menyimpan...';
      try {
        const newItem = { kode, nama };
        await onAdd(newItem);
        currentOptions = [newItem, ...currentOptions];
        selectOption(newItem);
        showToast(`Barang baru "${nama}" ditambahkan ke daftar.`);
      } catch (err) {
        confirmBtn.textContent = originalTxt;
        addBusy = false;
        showToast('Gagal menambah barang baru: ' + err.message, 'error');
      }
    });
    list.appendChild(box);
  }

  function renderSimpleAddForm(query) {
    const box = document.createElement('div');
    box.className = 'option-item-add-form';
    box.innerHTML = `
      <div class="add-form-title">Belum ada di daftar. Tambahkan sebagai baru:</div>
      <label class="add-form-lbl">Nama</label>
      <input type="text" class="add-form-simple" value="${escapeHtml(query)}" placeholder="Ketik nama baru">
      <div class="add-form-actions">
        <button type="button" class="btn-mini btn-mini-cancel add-form-cancel">Batal</button>
        <button type="button" class="btn-mini btn-mini-save add-form-confirm">+ Tambahkan</button>
      </div>
    `;
    const nameInput = box.querySelector('.add-form-simple');
    box.querySelector('.add-form-cancel').addEventListener('click', () => renderList(search.value));
    box.querySelector('.add-form-confirm').addEventListener('click', async () => {
      if (addBusy) return;
      const nama = nameInput.value.trim();
      if (!nama) return nameInput.focus();
      const dup = currentOptions.find(o => String(o).toLowerCase() === nama.toLowerCase());
      if (dup) {
        selectOption(dup);
        return;
      }
      addBusy = true;
      const confirmBtn = box.querySelector('.add-form-confirm');
      const originalTxt = confirmBtn.textContent;
      confirmBtn.textContent = 'Menyimpan...';
      try {
        await onAdd(nama);
        currentOptions = [nama, ...currentOptions];
        selectOption(nama);
        showToast(`"${nama}" ditambahkan ke daftar.`);
      } catch (err) {
        confirmBtn.textContent = originalTxt;
        addBusy = false;
        showToast('Gagal menambah: ' + err.message, 'error');
      }
    });
    list.appendChild(box);
  }

  function renderList(query = '') {
    const q = query.trim().toLowerCase();
    let filtered = currentOptions;
    if (q) {
      filtered = currentOptions.filter(o =>
        getLabel(o).toLowerCase().includes(q) ||
        (getSub && getSub(o) && String(getSub(o)).toLowerCase().includes(q))
      );
    }
    list.innerHTML = '';
    if (filtered.length === 0) {
      // Sebelumnya opsi "Tambah baru" hanya muncul kalau `q` (teks pencarian)
      // sudah diisi. Itu bikin tombolnya kelihatan "nggak ada sama sekali"
      // kalau daftar kosong sebelum user sempat mengetik apa pun. Sekarang
      // cukup allowAdd + onAdd aktif, tidak perlu ada `q` dulu.
      if (allowAdd && onAdd) {
        list.innerHTML = '';
        if (addMode === 'simple') renderSimpleAddForm(search.value.trim());
        else renderAddForm(search.value.trim());
      } else {
        list.innerHTML = '<div class="no-result">Tidak ditemukan</div>';
      }
      return;
    }
    filtered.forEach(o => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'option-item';
      const sub = getSub ? getSub(o) : null;
      item.innerHTML = `<span class="opt-label">${escapeHtml(getLabel(o))}</span>` + (sub ? `<span class="opt-sub">${escapeHtml(sub)}</span>` : '');
      item.addEventListener('click', () => selectOption(o));
      list.appendChild(item);
    });
    // Sama seperti di atas: dulu tombol trigger "+ Tambah baru" di bawah
    // daftar juga mensyaratkan `q` terisi. Sekarang selalu tampil selama
    // allowAdd + onAdd aktif, supaya user tidak harus ngetik dulu untuk
    // sekadar melihat opsi tambah barang/pemilik baru.
    if (allowAdd && onAdd) {
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'option-item option-item-add-trigger';
      addBtn.textContent = addMode === 'simple' ? `+ Tidak ada di daftar? Tambah baru...` : `+ Barang tidak ada di daftar? Tambah baru...`;
      addBtn.addEventListener('click', () => {
        list.innerHTML = '';
        if (addMode === 'simple') renderSimpleAddForm(search.value.trim());
        else renderAddForm(search.value.trim());
      });
      list.appendChild(addBtn);
    }
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = !panel.hidden;
    openPanels.forEach(close => close());
    if (!wasOpen) {
      panel.hidden = false;
      btn.classList.add('is-open');
      renderList();
      search.focus();
    }
  });
  search.addEventListener('input', () => renderList(search.value));
  panel.addEventListener('click', (e) => e.stopPropagation());

  return {
    getValue: () => selected,
    reset: () => {
      selected = null;
      valueEl.textContent = placeholder;
      valueEl.classList.remove('has-value');
    },
    setValue: (o) => {
      selected = o;
      valueEl.textContent = getLabel(o);
      valueEl.classList.add('has-value');
    },
    updateOptions: (newOptions) => {
      currentOptions = newOptions;
    },
  };
}

document.addEventListener('click', () => openPanels.forEach(close => close()));

/* ==========================================================================
   SESSION & ROLE MANAGEMENT (LOGIN)
========================================================================== */
const SESSION_KEY = 'gudang_session_v1';

function getSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || (s.role !== 'operator' && s.role !== 'admin')) return null;
    if (s.role === 'admin') {
      const stillValid = ADMIN_ACCOUNTS.some(a => a.nama === s.nama);
      if (!stillValid) return null;
    }
    return s;
  } catch (e) { return null; }
}

function setSession(session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

/* ---- UI Elements ---- */
const loginScreen = document.getElementById('login-screen');
const appScreen = document.getElementById('app-screen');
const rolePill = document.getElementById('role-pill');
const userNameLabel = document.getElementById('user-name-label');
const tabOperator = document.getElementById('tab-operator');
const tabAdmin = document.getElementById('tab-admin');
const formLoginOperator = document.getElementById('form-login-operator');
const formLoginAdmin = document.getElementById('form-login-admin');
const loginOperatorNama = document.getElementById('login-operator-nama');
const loginAdminPassword = document.getElementById('login-admin-password');
const loginError = document.getElementById('login-error');
const operatorModeTabs = document.getElementById('operator-mode-tabs');
const tabOperatorLogin = document.getElementById('tab-operator-login');
const tabOperatorRegister = document.getElementById('tab-operator-register');
const formRegisterOperator = document.getElementById('form-register-operator');
const loginOperatorPassword = document.getElementById('login-operator-password');
const loginOperatorError = document.getElementById('login-operator-error');
const registerOperatorError = document.getElementById('register-operator-error');
const registerOperatorNama = document.getElementById('register-operator-nama');
const registerOperatorIdKaryawan = document.getElementById('register-operator-id-karyawan');
const registerOperatorKodeAkses = document.getElementById('register-operator-kode-akses');
const registerOperatorPassword = document.getElementById('register-operator-password');
const registerOperatorPasswordConfirm = document.getElementById('register-operator-password-confirm');

function switchOperatorMode(mode) {
  tabOperatorLogin.classList.toggle('is-active', mode === 'login');
  tabOperatorRegister.classList.toggle('is-active', mode === 'register');
  formLoginOperator.hidden = mode !== 'login';
  formRegisterOperator.hidden = mode !== 'register';
  loginOperatorError.hidden = true;
  registerOperatorError.hidden = true;
}
tabOperatorLogin.addEventListener('click', () => switchOperatorMode('login'));
tabOperatorRegister.addEventListener('click', () => switchOperatorMode('register'));

function switchLoginTab(role) {
  tabOperator.classList.toggle('is-active', role === 'operator');
  tabAdmin.classList.toggle('is-active', role === 'admin');
  formLoginAdmin.hidden = role !== 'admin';
  loginError.hidden = true;

  if (role === 'operator') {
    operatorModeTabs.hidden = false;
    switchOperatorMode('login');
  } else {
    operatorModeTabs.hidden = true;
    formLoginOperator.hidden = true;
    formRegisterOperator.hidden = true;
  }
}

tabOperator.addEventListener('click', () => switchLoginTab('operator'));
tabAdmin.addEventListener('click', () => switchLoginTab('admin'));

const selAdminNama = setupSearchableSelect({
  id: 'sel-admin-nama',
  options: ADMIN_ACCOUNTS,
  getLabel: o => o.nama,
  placeholder: 'Pilih nama Anda...',
  onSelect: () => {},
});

/* ==========================================================================
   AKUN OPERATOR — daftar & login sungguhan lewat Firestore
   (mencegah orang masuk tanpa mendaftar terlebih dahulu)
========================================================================== */

// Hash satu arah (SHA-256) supaya kata sandi tidak tersimpan sebagai teks
// polos di database. Ini bukan pengganti backend yang sesungguhnya (idealnya
// hashing + salt dilakukan di server), tapi jauh lebih aman dibanding
// menyimpan password apa adanya, dan cukup untuk skala aplikasi internal ini.
async function hashPassword(password) {
  const enc = new TextEncoder().encode(password);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeNamaKey(nama) {
  return String(nama || '').trim().toLowerCase();
}

// Halaman login bisa tampil sebelum proses sign-in anonim ke Firebase
// selesai. Fungsi ini menunggu event 'gudang-firebase-ready' (ditembakkan
// oleh firebase-config.js setelah auth siap) sebelum kita mencoba
// membaca/menulis koleksi 'operator'.
let firebaseAuthReady = false;
window.addEventListener('gudang-firebase-ready', () => { firebaseAuthReady = true; });

function waitForFirebaseAuth(timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    if (firebaseAuthReady && window.gudangFirebase) return resolve();
    let settled = false;
    const onReady = () => { if (settled) return; settled = true; cleanup(); resolve(); };
    const onError = () => { if (settled) return; settled = true; cleanup(); reject(new Error('auth-error')); };
    const timer = setTimeout(() => { if (settled) return; settled = true; cleanup(); reject(new Error('timeout')); }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener('gudang-firebase-ready', onReady);
      window.removeEventListener('gudang-firebase-auth-error', onError);
    }
    window.addEventListener('gudang-firebase-ready', onReady);
    window.addEventListener('gudang-firebase-auth-error', onError);
  });
}

async function findOperatorAccountByNama(nama) {
  const fb = window.gudangFirebase;
  const namaKey = normalizeNamaKey(nama);
  const q = fb.query(fb.operatorCol, fb.where('namaLower', '==', namaKey));
  const snapshot = await fb.getDocs(q);
  if (snapshot.empty) return null;
  const docSnap = snapshot.docs[0];
  return { id: docSnap.id, ...docSnap.data() };
}

function showRegisterError(msg) {
  registerOperatorError.hidden = false;
  registerOperatorError.textContent = msg;
}
function hideRegisterError() {
  registerOperatorError.hidden = true;
  registerOperatorError.textContent = '';
}
function showLoginOperatorError(msg) {
  loginOperatorError.hidden = false;
  loginOperatorError.textContent = msg;
}
function hideLoginOperatorError() {
  loginOperatorError.hidden = true;
  loginOperatorError.textContent = '';
}

formRegisterOperator.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideRegisterError();

  const nama = registerOperatorNama.value.trim();
  const idKaryawan = registerOperatorIdKaryawan.value.trim();
  const kodeAkses = registerOperatorKodeAkses.value.trim();
  const password = registerOperatorPassword.value;
  const passwordConfirm = registerOperatorPasswordConfirm.value;

  if (!nama) { showRegisterError('Nama operator wajib diisi.'); registerOperatorNama.focus(); return; }
  if (!idKaryawan) { showRegisterError('ID Karyawan / NIK wajib diisi.'); registerOperatorIdKaryawan.focus(); return; }
  if (!kodeAkses) { showRegisterError('Kode Akses Pendaftaran wajib diisi. Minta kode ini ke admin gudang.'); registerOperatorKodeAkses.focus(); return; }
  if (typeof KODE_AKSES_PENDAFTARAN === 'undefined') {
    showRegisterError('Sistem belum siap (data.js gagal dimuat). Muat ulang halaman (refresh) lalu coba lagi.');
    return;
  }
  if (kodeAkses !== KODE_AKSES_PENDAFTARAN) {
    showRegisterError('Kode Akses Pendaftaran salah. Pastikan Anda mendapatkan kode resmi dari admin gudang Mayora.');
    registerOperatorKodeAkses.value = '';
    registerOperatorKodeAkses.focus();
    return;
  }
  if (!password || password.length < 6) { showRegisterError('Kata sandi minimal 6 karakter.'); registerOperatorPassword.focus(); return; }
  if (password !== passwordConfirm) { showRegisterError('Konfirmasi kata sandi tidak cocok.'); registerOperatorPasswordConfirm.focus(); return; }

  const submitBtn = formRegisterOperator.querySelector('button[type="submit"]');
  const originalText = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'MENDAFTARKAN...';

  try {
    await waitForFirebaseAuth();

    const existing = await findOperatorAccountByNama(nama);
    if (existing) {
      showRegisterError('Nama ini sudah terdaftar. Silakan masuk lewat tab "Masuk", atau gunakan nama lain.');
      return;
    }

    const passwordHash = await hashPassword(password);
    const fb = window.gudangFirebase;
    await fb.addDoc(fb.operatorCol, {
      nama,
      namaLower: normalizeNamaKey(nama),
      idKaryawan,
      passwordHash,
      createdAt: Date.now(),
    });

    formRegisterOperator.reset();
    switchOperatorMode('login');
    loginOperatorNama.value = nama;
    loginOperatorPassword.focus();
    showToast('Pendaftaran berhasil. Silakan masuk dengan akun yang baru dibuat.');
  } catch (err) {
    console.error('Gagal mendaftarkan operator:', err);
    showRegisterError('Gagal mendaftar: sistem belum siap atau koneksi bermasalah. Coba lagi.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
});

formLoginOperator.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideLoginOperatorError();

  const nama = loginOperatorNama.value.trim();
  const password = loginOperatorPassword.value;

  if (!nama) { loginOperatorNama.focus(); return; }
  if (!password) { showLoginOperatorError('Kata sandi wajib diisi.'); loginOperatorPassword.focus(); return; }

  const submitBtn = formLoginOperator.querySelector('button[type="submit"]');
  const originalText = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'MEMERIKSA...';

  try {
    await waitForFirebaseAuth();

    const akun = await findOperatorAccountByNama(nama);
    if (!akun) {
      showLoginOperatorError('Nama belum terdaftar. Silakan daftar akun baru terlebih dahulu lewat tab "Daftar Baru".');
      return;
    }

    const passwordHash = await hashPassword(password);
    if (passwordHash !== akun.passwordHash) {
      showLoginOperatorError('Kata sandi salah. Coba lagi.');
      loginOperatorPassword.value = '';
      loginOperatorPassword.focus();
      return;
    }

    setSession({ role: 'operator', nama: akun.nama });
    enterApp({ role: 'operator', nama: akun.nama });
  } catch (err) {
    console.error('Gagal memeriksa akun operator:', err);
    showLoginOperatorError('Sistem belum siap atau koneksi bermasalah. Coba lagi sebentar.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
});

formLoginAdmin.addEventListener('submit', (e) => {
  e.preventDefault();
  const akun = selAdminNama.getValue();
  const password = loginAdminPassword.value;
  loginError.hidden = true;
  if (!akun) {
    loginError.hidden = false;
    loginError.textContent = 'Pilih nama admin terlebih dahulu.';
    return;
  }
  if (!password || akun.password !== password) {
    loginError.hidden = false;
    loginError.textContent = 'Password salah. Coba lagi.';
    loginAdminPassword.value = '';
    loginAdminPassword.focus();
    return;
  }
  setSession({ role: 'admin', nama: akun.nama });
  enterApp({ role: 'admin', nama: akun.nama });
});

function enterApp(session) {
  loginScreen.hidden = true;
  appScreen.hidden = false;
  document.body.classList.remove('role-operator', 'role-admin');
  document.body.classList.add(session.role === 'admin' ? 'role-admin' : 'role-operator');
  rolePill.textContent = session.role === 'admin' ? 'Admin' : 'Operator';
  rolePill.classList.toggle('is-admin', session.role === 'admin');
  userNameLabel.textContent = session.nama;

  if (session.role === 'operator') {
    inputOperator.value = session.nama;
  }

  initFirestoreConnection();
}

document.getElementById('btn-logout').addEventListener('click', () => {
  if (unsubscribeLaporan) unsubscribeLaporan();
  clearSession();
  window.location.reload();
});

/* ==========================================================================
   FIRESTORE CONNECTION & DATA MANAGEMENT
========================================================================== */
const RINGKASAN_SHEET = 'Ringkasan Stok';

let currentEntries = [];
let unsubscribeLaporan = null;
let firestoreReady = false;

// periodMode & periodDate dipindah ke sini (sebelum initFirestoreConnection()
// bisa dipanggil) supaya sudah pasti terisi sebelum listener Firestore
// (onSnapshot -> renderAll -> renderRingkasan) sempat menyala. Sebelumnya
// kedua variabel ini dideklarasikan jauh di bawah, dekat kode tab periode,
// sehingga ada celah di mana renderRingkasan() bisa terpanggil (lewat
// snapshot Firestore yang datang dari cache lokal / lebih cepat dari sisa
// skrip yang belum selesai jalan) sebelum baris deklarasinya tereksekusi —
// itu yang memicu error "Cannot access 'periodMode' before initialization".
let periodMode = 'harian';
let periodDate = todayISO();

const MONTH_HEADERS = ['Tanggal', 'Jenis', 'Tipe', 'Nama Operator', 'Kode Barang', 'Nama Barang', 'Supplier', 'Pemilik Barang', 'Lokasi', 'Jumlah (pcs)', 'Qty per Pallet (pcs)', 'Jumlah Pallet', 'Keterangan', 'Waktu Input', 'Waktu Diubah', 'ID'];
const MONTH_COL_WIDTHS = [12, 9, 13, 18, 14, 34, 22, 14, 10, 12, 16, 12, 28, 22, 22, 14];
const STOK_HEADERS = ['Kode Barang', 'Nama Barang', 'Lokasi Terpakai', 'Total Masuk', 'Total Keluar', 'Stok Saat Ini', 'Terakhir Masuk', 'Terakhir Keluar', 'Terakhir Diperbarui'];
const STOK_COL_WIDTHS = [14, 34, 26, 12, 12, 12, 22, 22, 22];

function safeSheetName(name) {
  let s = String(name).replace(/[:\\\/\?\*\[\]]/g, '-').trim();
  if (s.length > 31) s = s.slice(0, 31);
  return s || 'Sheet';
}

function buildStokList(entries) {
  const map = {};
  entries.forEach(t => {
    const key = t.kodeBarang || t.namaBarang;
    if (!map[key]) {
      map[key] = {
        kode: t.kodeBarang, nama: t.namaBarang,
        masuk: 0, keluar: 0, lokasi: new Set(),
        lastMasuk: null, lastKeluar: null, updated: 0,
        history: [],
      };
    }
    const item = map[key];
    item.history.push(t);
    if (t.lokasi) item.lokasi.add(t.lokasi);
    if (t.jenis === 'masuk') {
      item.masuk += t.jumlah;
      if (!item.lastMasuk || t.createdAt > item.lastMasuk.at) {
        item.lastMasuk = { at: t.createdAt, tanggal: t.tanggal, jumlah: t.jumlah, lokasi: t.lokasi, supplier: t.supplier, operator: t.operator };
      }
    } else {
      item.keluar += t.jumlah;
      if (!item.lastKeluar || t.createdAt > item.lastKeluar.at) {
        item.lastKeluar = { at: t.createdAt, tanggal: t.tanggal, jumlah: t.jumlah, lokasi: t.lokasi, operator: t.operator };
      }
    }
    if (t.updatedAt > item.updated) item.updated = t.updatedAt;
  });
  return Object.values(map).sort((a, b) => a.nama.localeCompare(b.nama));
}

function buildLocationStock(entries) {
  const map = {};
  entries.forEach(t => {
    if (!t.lokasi) return;
    const key = t.kodeBarang || t.namaBarang;
    if (!map[t.lokasi]) map[t.lokasi] = {};
    if (!map[t.lokasi][key]) map[t.lokasi][key] = { kode: t.kodeBarang, nama: t.namaBarang, qty: 0 };
    map[t.lokasi][key].qty += (t.jenis === 'masuk' ? t.jumlah : -t.jumlah);
  });
  const result = Object.entries(map).map(([lokasi, items]) => {
    const list = Object.values(items).filter(it => it.qty !== 0).sort((a, b) => b.qty - a.qty);
    const totalQty = list.reduce((s, it) => s + it.qty, 0);
    return { lokasi, items: list, totalQty, itemCount: list.length };
  }).filter(l => l.itemCount > 0).sort((a, b) => a.lokasi.localeCompare(b.lokasi));
  return result;
}

function buildMonthSheet(entries) {
  const rows = entries.map(t => [
    t.tanggal,
    t.jenis === 'masuk' ? 'MASUK' : 'KELUAR',
    t.tipe === 'penyesuaian' ? 'PENYESUAIAN' : 'TRANSAKSI',
    t.operator,
    t.kodeBarang,
    t.namaBarang,
    t.supplier,
    t.pemilik,
    t.lokasi,
    t.jumlah,
    t.qtyPerPallet != null ? t.qtyPerPallet : '',
    t.jumlahPallet != null ? t.jumlahPallet : '',
    t.keterangan || '',
    new Date(t.createdAt).toISOString(),
    new Date(t.updatedAt).toISOString(),
    t.id,
  ]);
  const aoa = [MONTH_HEADERS, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = MONTH_COL_WIDTHS.map(w => ({ wch: w }));
  ws['!autofilter'] = { ref: `A1:P${aoa.length}` };
  return ws;
}

function buildStokSheet(entries) {
  const items = buildStokList(entries);
  const rows = items.map(it => [
    it.kode,
    it.nama,
    Array.from(it.lokasi).join(', '),
    it.masuk,
    it.keluar,
    it.masuk - it.keluar,
    it.lastMasuk ? `${it.lastMasuk.tanggal} (${it.lastMasuk.jumlah} pcs)` : '-',
    it.lastKeluar ? `${it.lastKeluar.tanggal} (${it.lastKeluar.jumlah} pcs)` : '-',
    it.updated ? new Date(it.updated).toISOString() : '-',
  ]);
  const aoa = [STOK_HEADERS, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = STOK_COL_WIDTHS.map(w => ({ wch: w }));
  ws['!autofilter'] = { ref: `A1:I${aoa.length}` };
  return ws;
}

/* ---- UI Connection Status ---- */
const elConnecting = document.getElementById('connect-connecting');
const elConnected = document.getElementById('connect-connected');
const elConnectError = document.getElementById('connect-error');
const operatorNotReady = document.getElementById('operator-not-ready');

function currentRole() {
  const s = getSession();
  return s ? s.role : null;
}

function setConnectUI(state) {
  elConnecting.hidden = state !== 'connecting';
  elConnected.hidden = state !== 'connected';
  elConnectError.hidden = state !== 'error';

  const submitBtn = document.getElementById('btn-submit');
  if (submitBtn) submitBtn.disabled = state !== 'connected';
  const adjSubmitBtn = document.getElementById('btn-adj-submit');
  if (adjSubmitBtn) adjSubmitBtn.disabled = state !== 'connected';

  if (currentRole() === 'operator') {
    operatorNotReady.hidden = state === 'connected';
  } else {
    operatorNotReady.hidden = true;
  }
}

function renderAll() {
  renderRingkasan();
  renderKatalog();
  renderRiwayat();
  renderAkunOperator();
}

let currentOperatorAccounts = [];
let unsubscribeOperatorAccounts = null;

function initFirestoreConnection() {
  setConnectUI('connecting');

  function startListening() {
    const fb = window.gudangFirebase;
    if (!fb) { setConnectUI('error'); return; }

    if (unsubscribeLaporan) unsubscribeLaporan();

    unsubscribeLaporan = fb.onSnapshot(
      fb.laporanCol,
      (snapshot) => {
        currentEntries = snapshot.docs.map(d => {
          const data = d.data();
          return { id: d.id, ...data };
        });
        firestoreReady = true;
        setConnectUI('connected');
        renderAll();
      },
      (err) => {
        console.error('Firestore listen error:', err);
        firestoreReady = false;
        setConnectUI('error');
      }
    );

    if (currentRole() === 'admin') {
      if (unsubscribeOperatorAccounts) unsubscribeOperatorAccounts();
      unsubscribeOperatorAccounts = fb.onSnapshot(
        fb.operatorCol,
        (snapshot) => {
          currentOperatorAccounts = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
          renderAkunOperator();
        },
        (err) => {
          console.error('Gagal memuat daftar akun operator:', err);
        }
      );
    }
  }

  if (window.gudangFirebase) {
    startListening();
  } else {
    window.addEventListener('gudang-firebase-ready', startListening, { once: true });
    setTimeout(() => { if (!firestoreReady && window.gudangFirebase) startListening(); }, 300);
  }
}

document.getElementById('btn-retry-connect').addEventListener('click', () => {
  initFirestoreConnection();
});

async function addEntryToFirestore(entry) {
  const fb = window.gudangFirebase;
  await fb.addDoc(fb.laporanCol, entry);
}

async function updateEntryInFirestore(id, changes) {
  const fb = window.gudangFirebase;
  await fb.updateDoc(fb.doc(fb.db, 'laporan', id), changes);
}

async function deleteEntryFromFirestore(id) {
  const fb = window.gudangFirebase;
  await fb.deleteDoc(fb.doc(fb.db, 'laporan', id));
}

async function clearAllEntriesInFirestore() {
  const fb = window.gudangFirebase;
  const snapshot = await fb.getDocs(fb.laporanCol);
  const batch = fb.writeBatch(fb.db);
  snapshot.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

/* ==========================================================================
   TOAST NOTIFICATIONS
========================================================================== */
let toastTimer = null;
function showToast(message, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3400);
}

/* ==========================================================================
   BARANG BARU — kode barang yang belum ada di MASTER_DATA
   Disimpan di koleksi Firestore "barangBaru" supaya begitu satu operator/
   admin menambahkan kode barang baru, semua orang lain (di device lain)
   otomatis melihatnya juga tanpa perlu update file data.js.
========================================================================== */
let customBarang = [];
let BARANG_OPTIONS = MASTER_DATA.barang;

// Dideklarasikan lebih dulu (belum diberi nilai) — sama seperti selPemilik.
// rebuildBarangOptions() bisa terpanggil (lewat listener realtime Firestore)
// sebelum selBarang/selAdjBarang selesai dibuat lebih bawah di file ini.
// `typeof x !== 'undefined'` TIDAK melindungi dari kasus ini untuk
// variabel let/const yang masih di "temporal dead zone" — tetap melempar
// ReferenceError. Solusinya: deklarasikan lebih awal dengan `let`, baru
// diisi (assign) belakangan tanpa redeklarasi const.
let selBarang;
let selAdjBarang;

function rebuildBarangOptions() {
  const known = new Set(MASTER_DATA.barang.map(o => String(o.kode)));
  const extra = customBarang.filter(o => !known.has(String(o.kode)));
  BARANG_OPTIONS = [...MASTER_DATA.barang, ...extra];
  if (selBarang && selBarang.updateOptions) selBarang.updateOptions(BARANG_OPTIONS);
  if (selAdjBarang && selAdjBarang.updateOptions) selAdjBarang.updateOptions(BARANG_OPTIONS);
}

// firebase-config.js dimuat sebagai <script type="module">, yang butuh waktu
// fetch 3 file dari gstatic.com sebelum window.gudangFirebase benar-benar
// terisi. Kalau user sempat klik "+ Tambahkan" pas jendela waktu itu (baru
// buka halaman, koneksi agak lambat, dsb), window.gudangFirebase masih
// undefined walau sebenarnya tidak ada masalah koneksi permanen — cuma
// belum selesai loading. Fungsi ini menunggu (bukan langsung gagal) sampai
// window.gudangFirebase siap, atau menyerah setelah beberapa detik.
function waitForFirebase(timeoutMs = 6000) {
  if (window.gudangFirebase) return Promise.resolve(window.gudangFirebase);
  return new Promise((resolve, reject) => {
    const onReady = () => { cleanup(); resolve(window.gudangFirebase); };
    const onAuthError = (e) => { cleanup(); reject(new Error('Gagal masuk ke Firebase: ' + (e.detail && e.detail.message ? e.detail.message : 'tidak diketahui'))); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Database tidak terhubung. Periksa koneksi internet lalu coba lagi.')); }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener('gudang-firebase-ready', onReady);
      window.removeEventListener('gudang-firebase-auth-error', onAuthError);
    }
    window.addEventListener('gudang-firebase-ready', onReady, { once: true });
    window.addEventListener('gudang-firebase-auth-error', onAuthError, { once: true });
  });
}

async function tambahBarangBaru(item) {
  const fb = await waitForFirebase();
  if (!fb.barangBaruCol) throw new Error('Database tidak terhubung.');
  const session = getSession();
  await fb.addDoc(fb.barangBaruCol, {
    kode: item.kode,
    nama: item.nama,
    ditambahOleh: session ? session.nama : '-',
    createdAt: Date.now(),
  });
}

function startBarangBaruListener() {
  const fb = window.gudangFirebase;
  if (!fb || !fb.barangBaruCol) return;
  fb.onSnapshot(fb.barangBaruCol, (snapshot) => {
    customBarang = snapshot.docs.map(d => {
      const data = d.data();
      return { kode: data.kode, nama: data.nama };
    });
    rebuildBarangOptions();
  }, (err) => {
    console.error('Gagal memuat daftar barang baru:', err);
  });
}

if (window.gudangFirebase) {
  startBarangBaruListener();
} else {
  window.addEventListener('gudang-firebase-ready', startBarangBaruListener, { once: true });
}

/* ==========================================================================
   PEMILIK BARANG (PABRIK) — sama polanya dengan "Barang Baru" di atas:
   daftar dasarnya statis (PEMILIK_OPTIONS di bawah, boleh dikosongkan),
   tapi operator/admin bisa mengetik nama pemilik baru langsung dari
   dropdown ("+ Tambah baru..."). Begitu ditambahkan, tersimpan ke
   koleksi Firestore "pemilikBaru" sehingga semua device lain otomatis
   melihat nama pemilik baru itu juga di dropdown mereka — TIDAK perlu
   mengedit file data.js secara manual setiap kali ada pabrik baru.
========================================================================== */
// Daftar awal pemilik barang/pabrik. Boleh dikosongkan sepenuhnya —
// isi manual lewat dropdown form akan otomatis tersimpan & tersinkron.
const PEMILIK_OPTIONS = (typeof window.PEMILIK_OPTIONS !== 'undefined') ? window.PEMILIK_OPTIONS : [];

let customPemilik = [];

// Dideklarasikan dulu (belum diberi nilai) supaya rebuildPemilikOptions() bisa
// dipanggil dengan aman sebelum selPemilik selesai dibuat di bawah (fungsi ini
// dipanggil di dalam options: pada setupSearchableSelect({ id: 'sel-pemilik' }),
// yaitu SAAT selPemilik sendiri sedang diinisialisasi). `typeof selPemilik !==
// 'undefined'` tidak cukup untuk kasus ini: variabel let/const yang belum
// dieksekusi baris deklarasinya berada di "temporal dead zone" dan tetap
// melempar ReferenceError walau dicek pakai typeof.
let selPemilik;
let selAdjPemilik;

function rebuildPemilikOptions() {
  const known = new Set(PEMILIK_OPTIONS.map(o => String(o).toLowerCase()));
  const extra = customPemilik.filter(o => !known.has(String(o).toLowerCase()));
  const merged = [...PEMILIK_OPTIONS, ...extra];
  if (selPemilik && selPemilik.updateOptions) selPemilik.updateOptions(merged);
  if (selAdjPemilik && selAdjPemilik.updateOptions) selAdjPemilik.updateOptions(merged);
  return merged;
}

async function tambahPemilikBaru(nama) {
  const fb = await waitForFirebase();
  if (!fb.pemilikBaruCol) throw new Error('Database tidak terhubung.');
  const session = getSession();
  await fb.addDoc(fb.pemilikBaruCol, {
    nama,
    ditambahOleh: session ? session.nama : '-',
    createdAt: Date.now(),
  });
}

function startPemilikBaruListener() {
  const fb = window.gudangFirebase;
  if (!fb || !fb.pemilikBaruCol) return;
  fb.onSnapshot(fb.pemilikBaruCol, (snapshot) => {
    customPemilik = snapshot.docs.map(d => d.data().nama);
    rebuildPemilikOptions();
  }, (err) => {
    console.error('Gagal memuat daftar pemilik baru:', err);
  });
}

if (window.gudangFirebase) {
  startPemilikBaruListener();
} else {
  window.addEventListener('gudang-firebase-ready', startPemilikBaruListener, { once: true });
}

/* ==========================================================================
   DATALIST LOKASI GLOBAL
========================================================================== */
(function populateLokasiDatalist() {
  const dl = document.getElementById('dl-lokasi');
  if (!dl) return;
  const frag = document.createDocumentFragment();
  MASTER_DATA.lokasi.forEach(l => {
    const opt = document.createElement('option');
    opt.value = l;
    frag.appendChild(opt);
  });
  dl.appendChild(frag);
})();

/* ==========================================================================
   FORM INPUT — OPERATOR ONLY
========================================================================== */
let jenis = 'masuk';

const btnMasuk = document.getElementById('btn-jenis-masuk');
const btnKeluar = document.getElementById('btn-jenis-keluar');
btnMasuk.addEventListener('click', () => setJenis('masuk'));
btnKeluar.addEventListener('click', () => setJenis('keluar'));

function setJenis(j) {
  jenis = j;
  btnMasuk.classList.toggle('is-active', j === 'masuk');
  btnKeluar.classList.toggle('is-active', j === 'keluar');
}

selBarang = setupSearchableSelect({
  id: 'sel-barang',
  options: BARANG_OPTIONS,
  getLabel: o => o.nama,
  getSub: o => o.kode,
  placeholder: 'Pilih barang...',
  allowAdd: true,
  onAdd: tambahBarangBaru,
  onSelect: (o) => {
    document.getElementById('kode-box').hidden = false;
    document.getElementById('kode-value').textContent = o.kode;
  },
});

const selSupplier = setupSearchableSelect({
  id: 'sel-supplier',
  options: MASTER_DATA.supplier,
  getLabel: o => o,
  placeholder: 'Pilih supplier...',
  onSelect: () => {},
});

selPemilik = setupSearchableSelect({
  id: 'sel-pemilik',
  options: rebuildPemilikOptions(),
  getLabel: o => o,
  placeholder: 'Pilih pemilik barang...',
  allowAdd: true,
  addMode: 'simple',
  onAdd: tambahPemilikBaru,
  onSelect: () => {},
});

// Lokasi Penyimpanan BUKAN dropdown pilihan manual — nilainya hanya bisa
// diisi lewat hasil scan barcode (lihat onScanSuccess di bawah).
const lokasiValueEl = document.getElementById('sel-lokasi-value');
const selLokasi = {
  _value: null,
  getValue: () => selLokasi._value,
  reset: () => {
    selLokasi._value = null;
    if (lokasiValueEl) {
      lokasiValueEl.textContent = 'Belum di-scan...';
      lokasiValueEl.classList.remove('has-value');
    }
  },
  setValue: (v) => {
    selLokasi._value = v;
    if (lokasiValueEl) {
      lokasiValueEl.textContent = v;
      lokasiValueEl.classList.add('has-value');
    }
  },
};

const inputOperator = document.getElementById('input-operator');
const inputTanggal = document.getElementById('input-tanggal');
const inputJumlah = document.getElementById('input-jumlah');
const inputQtyPallet = document.getElementById('input-qty-pallet');
const inputJumlahPallet = document.getElementById('input-jumlah-pallet');
const formError = document.getElementById('form-error');
const form = document.getElementById('form-laporan');

function hitungJumlahPallet() {
  const jumlah = parseFloat(inputJumlah.value);
  const qtyPallet = parseFloat(inputQtyPallet.value);
  if (!jumlah || !qtyPallet || qtyPallet <= 0) {
    inputJumlahPallet.value = '';
    return;
  }
  const hasil = jumlah / qtyPallet;
  // tampilkan maks 2 angka desimal, buang nol yang tidak perlu
  inputJumlahPallet.value = (Math.round(hasil * 100) / 100).toString();
}
inputJumlah.addEventListener('input', hitungJumlahPallet);
inputQtyPallet.addEventListener('input', hitungJumlahPallet);

/* ==========================================================================
   SCAN BARCODE — LOKASI (Input Laporan)
========================================================================== */
const btnScanLokasi = document.getElementById('btn-scan-lokasi');
const scanModal = document.getElementById('scan-modal');
const scanModalClose = document.getElementById('scan-modal-close');
const scanStatus = document.getElementById('scan-status');
const scanErrorBox = document.getElementById('scan-error');

const LOKASI_SET = new Set(MASTER_DATA.lokasi);
let html5QrScanner = null;
let scanBusy = false;

function normalizeLokasiCode(text) {
  return String(text || '').trim().toUpperCase();
}

function stripSeparators(text) {
  return normalizeLokasiCode(text).replace(/[^A-Z0-9]/g, '');
}

function findMatchingLokasi(decodedText) {
  const exact = normalizeLokasiCode(decodedText);
  let match = MASTER_DATA.lokasi.find(l => normalizeLokasiCode(l) === exact);
  if (match) return match;

  // toleran terhadap perbedaan spasi/strip/prefix pada barcode fisik
  const stripped = stripSeparators(decodedText);
  match = MASTER_DATA.lokasi.find(l => stripSeparators(l) === stripped);
  if (match) return match;

  // coba cari pola kode lokasi (huruf-2digit-2digit) di dalam teks yang lebih panjang
  const patternMatch = exact.match(/[A-Z]-?\d{2}-?\d{2}/);
  if (patternMatch) {
    const strippedPattern = stripSeparators(patternMatch[0]);
    match = MASTER_DATA.lokasi.find(l => stripSeparators(l) === strippedPattern);
    if (match) return match;
  }
  return null;
}

async function stopScanner() {
  if (html5QrScanner) {
    try {
      const state = html5QrScanner.getState ? html5QrScanner.getState() : null;
      const isActive = (typeof Html5QrcodeScannerState !== 'undefined')
        ? (state === Html5QrcodeScannerState.SCANNING || state === Html5QrcodeScannerState.PAUSED)
        : !!state;
      if (isActive) await html5QrScanner.stop();
      html5QrScanner.clear();
    } catch (e) { /* kamera mungkin sudah berhenti, aman diabaikan */ }
  }
}

async function openScanModal() {
  if (typeof Html5Qrcode === 'undefined') {
    showToast('Fitur scan belum siap dimuat. Periksa koneksi internet lalu coba lagi.', 'error');
    return;
  }
  scanModal.hidden = false;
  scanErrorBox.hidden = true;
  scanStatus.textContent = 'Menyiapkan kamera...';
  scanBusy = false;

  try {
    html5QrScanner = new Html5Qrcode('scan-reader', { verbose: false });
    await html5QrScanner.start(
      { facingMode: 'environment' },
      {
        fps: 10,
        qrbox: (vw, vh) => {
          const size = Math.floor(Math.min(vw, vh) * 0.75);
          return { width: size, height: Math.max(size * 0.45, 80) };
        },
      },
      onScanSuccess,
      () => { /* frame tanpa barcode terdeteksi, abaikan */ }
    );
    scanStatus.textContent = 'Arahkan kamera ke barcode lokasi di rak.';
  } catch (err) {
    console.error('Gagal membuka kamera untuk scan:', err);
    scanStatus.textContent = '';
    scanErrorBox.hidden = false;
    scanErrorBox.textContent = 'Tidak bisa mengakses kamera. Pastikan izin kamera diberikan, lalu coba lagi.';
  }
}

async function closeScanModal() {
  await stopScanner();
  scanModal.hidden = true;
}

async function onScanSuccess(decodedText) {
  if (scanBusy) return;
  console.log('[scan-lokasi] barcode terbaca:', decodedText);
  const matched = findMatchingLokasi(decodedText);

  if (matched) {
    scanBusy = true;
    selLokasi.setValue(matched);
    await closeScanModal();
    showToast(`Lokasi berhasil di-scan: ${matched}`);
  } else {
    scanErrorBox.hidden = false;
    scanErrorBox.textContent = `Kode "${decodedText}" tidak dikenali sebagai lokasi yang valid. Coba scan ulang.`;
  }
}

if (btnScanLokasi) btnScanLokasi.addEventListener('click', openScanModal);
if (scanModalClose) scanModalClose.addEventListener('click', closeScanModal);
if (scanModal) scanModal.addEventListener('click', (e) => { if (e.target === scanModal) closeScanModal(); });

inputTanggal.value = todayISO();

function showError(msg) {
  formError.hidden = false;
  formError.textContent = msg;
}

function hideError() {
  formError.hidden = true;
  formError.textContent = '';
}

function resetForm() {
  selBarang.reset();
  selSupplier.reset();
  selPemilik.reset();
  selLokasi.reset();
  document.getElementById('kode-box').hidden = true;
  inputJumlah.value = '';
  inputQtyPallet.value = '';
  inputJumlahPallet.value = '';
  inputTanggal.value = todayISO();
  setJenis('masuk');
  hideError();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();

  if (!firestoreReady) return showError('Sistem belum siap menerima laporan. Periksa koneksi internet.');

  const operator = inputOperator.value.trim();
  const barang = selBarang.getValue();
  const supplier = selSupplier.getValue();
  const pemilik = selPemilik.getValue();
  const lokasi = selLokasi.getValue();
  const tanggal = inputTanggal.value;
  const jumlah = parseInt(inputJumlah.value, 10);
  const qtyPerPalletRaw = inputQtyPallet.value.trim();
  const qtyPerPallet = qtyPerPalletRaw ? parseFloat(qtyPerPalletRaw) : null;
  const jumlahPallet = inputJumlahPallet.value ? parseFloat(inputJumlahPallet.value) : null;

  if (!operator) return showError('Nama operator wajib diisi.');
  if (!barang) return showError('Pilih nama barang terlebih dahulu.');
  if (!supplier) return showError('Pilih supplier terlebih dahulu.');
  if (!pemilik) return showError('Pilih pemilik barang (pabrik) terlebih dahulu.');
  if (!lokasi) return showError('Scan barcode lokasi penyimpanan terlebih dahulu.');
  if (!tanggal) return showError('Tanggal wajib diisi.');
  if (!jumlah || jumlah <= 0) return showError('Jumlah barang harus berupa angka lebih dari 0.');
  if (qtyPerPalletRaw && (!qtyPerPallet || qtyPerPallet <= 0)) return showError('Qty per pallet harus berupa angka lebih dari 0.');

  if (jenis === 'keluar') {
    const stokTersedia = currentEntries
      .filter(t => t.kodeBarang === barang.kode)
      .reduce((s, t) => s + (t.jenis === 'masuk' ? t.jumlah : -t.jumlah), 0);
    if (jumlah > stokTersedia) {
      return showError(`Jumlah keluar (${jumlah.toLocaleString('id-ID')} pcs) melebihi stok yang tersedia (${stokTersedia.toLocaleString('id-ID')} pcs) untuk barang ini.`);
    }
  }

  const submitBtn = document.getElementById('btn-submit');
  const submitText = document.getElementById('btn-submit-text');
  submitBtn.disabled = true;
  const originalText = submitText.textContent;
  submitText.textContent = 'MENYIMPAN...';

  try {
    const now = Date.now();
    await addEntryToFirestore({
      jenis, tipe: 'transaksi', operator, kodeBarang: barang.kode, namaBarang: barang.nama,
      supplier, pemilik, lokasi, jumlah, qtyPerPallet, jumlahPallet, keterangan: '', tanggal, createdAt: now, updatedAt: now,
    });

    resetForm();
    inputOperator.value = operator;
    showToast('Laporan berhasil disimpan.');
  } catch (err) {
    showError('Gagal menyimpan laporan: ' + err.message);
  } finally {
    submitBtn.disabled = !firestoreReady;
    submitText.textContent = originalText;
  }
});

/* ==========================================================================
   PENYESUAIAN STOK — ADMIN ONLY
========================================================================== */
let adjArah = 'tambah';
const btnAdjTambah = document.getElementById('btn-adj-tambah');
const btnAdjKurang = document.getElementById('btn-adj-kurang');

if (btnAdjTambah && btnAdjKurang) {
  btnAdjTambah.addEventListener('click', () => setAdjArah('tambah'));
  btnAdjKurang.addEventListener('click', () => setAdjArah('kurang'));
}

function setAdjArah(a) {
  adjArah = a;
  btnAdjTambah.classList.toggle('is-active', a === 'tambah');
  btnAdjKurang.classList.toggle('is-active', a === 'kurang');
}

selAdjBarang = setupSearchableSelect({
  id: 'sel-adj-barang',
  options: BARANG_OPTIONS,
  getLabel: o => o.nama,
  getSub: o => o.kode,
  placeholder: 'Pilih barang...',
  allowAdd: true,
  onAdd: tambahBarangBaru,
  onSelect: (o) => {
    document.getElementById('adj-kode-box').hidden = false;
    document.getElementById('adj-kode-value').textContent = o.kode;
  },
});

selAdjPemilik = setupSearchableSelect({
  id: 'sel-adj-pemilik',
  options: rebuildPemilikOptions(),
  getLabel: o => o,
  placeholder: 'Pilih pemilik barang...',
  allowAdd: true,
  addMode: 'simple',
  onAdd: tambahPemilikBaru,
  onSelect: () => {},
});


const selAdjLokasi = setupSearchableSelect({
  id: 'sel-adj-lokasi',
  options: MASTER_DATA.lokasi,
  getLabel: o => o,
  placeholder: 'Pilih lokasi...',
  onSelect: () => {},
});

const formPenyesuaian = document.getElementById('form-penyesuaian');
const adjTanggal = document.getElementById('adj-tanggal');
const adjJumlah = document.getElementById('adj-jumlah');
const adjKeterangan = document.getElementById('adj-keterangan');
const adjError = document.getElementById('adj-error');

if (adjTanggal) adjTanggal.value = todayISO();

function showAdjError(msg) {
  adjError.hidden = false;
  adjError.textContent = msg;
}

function hideAdjError() {
  adjError.hidden = true;
  adjError.textContent = '';
}

function resetAdjForm() {
  selAdjBarang.reset();
  selAdjPemilik.reset();
  selAdjLokasi.reset();
  document.getElementById('adj-kode-box').hidden = true;
  adjJumlah.value = '';
  adjKeterangan.value = '';
  adjTanggal.value = todayISO();
  setAdjArah('tambah');
  hideAdjError();
}

if (formPenyesuaian) {
  formPenyesuaian.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAdjError();

    if (!firestoreReady) return showAdjError('Database belum terhubung.');

    const barang = selAdjBarang.getValue();
    const pemilik = selAdjPemilik.getValue();
    const lokasi = selAdjLokasi.getValue();
    const tanggal = adjTanggal.value;
    const jumlah = parseInt(adjJumlah.value, 10);
    const keterangan = adjKeterangan.value.trim();

    if (!barang) return showAdjError('Pilih nama barang terlebih dahulu.');
    if (!pemilik) return showAdjError('Pilih pemilik barang terlebih dahulu.');
    if (!lokasi) return showAdjError('Pilih lokasi terlebih dahulu.');
    if (!tanggal) return showAdjError('Tanggal wajib diisi.');
    if (!jumlah || jumlah <= 0) return showAdjError('Jumlah harus berupa angka lebih dari 0.');

    const submitBtn = document.getElementById('btn-adj-submit');
    const submitText = document.getElementById('btn-adj-submit-text');
    submitBtn.disabled = true;
    const originalText = submitText.textContent;
    submitText.textContent = 'MENYIMPAN...';

    try {
      const session = getSession();
      const now = Date.now();

      await addEntryToFirestore({
        jenis: adjArah === 'tambah' ? 'masuk' : 'keluar',
        tipe: 'penyesuaian',
        operator: session ? session.nama : 'Admin',
        kodeBarang: barang.kode,
        namaBarang: barang.nama,
        supplier: '-',
        pemilik,
        lokasi,
        jumlah,
        keterangan: keterangan || (adjArah === 'tambah' ? 'Penyesuaian stok (tambah)' : 'Penyesuaian stok (kurangi)'),
        tanggal,
        createdAt: now,
        updatedAt: now,
      });

      resetAdjForm();
      showToast('Penyesuaian stok berhasil disimpan.');
    } catch (err) {
      showAdjError('Gagal menyimpan penyesuaian: ' + err.message);
    } finally {
      submitBtn.disabled = !firestoreReady;
      submitText.textContent = originalText;
    }
  });
}

/* ==========================================================================
   PERIODE LAPORAN — ADMIN ONLY
   (periodMode & periodDate dideklarasikan lebih awal di atas, dekat
   currentEntries — lihat catatan di sana)
========================================================================== */

function getPeriodRange(mode, dateISO) {
  const d = new Date(dateISO + 'T00:00:00');
  if (mode === 'harian') {
    return { startISO: dateISO, endISO: dateISO, label: formatTanggal(dateISO) };
  }
  if (mode === 'mingguan') {
    const day = d.getDay();
    const diffToMon = (day === 0 ? -6 : 1 - day);
    const monday = new Date(d); monday.setDate(d.getDate() + diffToMon);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    return { startISO: isoOfDate(monday), endISO: isoOfDate(sunday), label: `${formatTanggal(isoOfDate(monday))} – ${formatTanggal(isoOfDate(sunday))}` };
  }
  if (mode === 'bulanan') {
    const y = d.getFullYear(), m = d.getMonth();
    const first = new Date(y, m, 1);
    const last = new Date(y, m + 1, 0);
    return { startISO: isoOfDate(first), endISO: isoOfDate(last), label: `${BULAN_PANJANG[m]} ${y}` };
  }
  return { startISO: null, endISO: null, label: 'Semua Waktu' };
}

function getPreviousPeriodRange(mode, dateISO) {
  const d = new Date(dateISO + 'T00:00:00');
  if (mode === 'harian') {
    const prev = new Date(d); prev.setDate(d.getDate() - 1);
    return getPeriodRange('harian', isoOfDate(prev));
  }
  if (mode === 'mingguan') {
    const prev = new Date(d); prev.setDate(d.getDate() - 7);
    return getPeriodRange('mingguan', isoOfDate(prev));
  }
  if (mode === 'bulanan') {
    const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    return getPeriodRange('bulanan', isoOfDate(prev));
  }
  return null;
}

function inPeriod(entry, range) {
  if (!range.startISO) return true;
  return entry.tanggal >= range.startISO && entry.tanggal <= range.endISO;
}

const periodTabsWrap = document.getElementById('period-tabs');
const periodDatePicker = document.getElementById('period-date-picker');
periodDatePicker.value = periodDate;

periodTabsWrap.querySelectorAll('.period-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    periodTabsWrap.querySelectorAll('.period-tab').forEach(b => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    periodMode = btn.dataset.mode;
    periodDatePicker.disabled = periodMode === 'semua';
    renderRingkasan();
    renderRiwayat();
  });
});

periodDatePicker.addEventListener('change', () => {
  periodDate = periodDatePicker.value || todayISO();
  renderRingkasan();
  renderRiwayat();
});

/* ==========================================================================
   RINGKASAN LAPORAN (admin)
========================================================================== */
const ringkasanDate = document.getElementById('ringkasan-date');
const statMasukQty = document.getElementById('stat-masuk-qty');
const statMasukCount = document.getElementById('stat-masuk-count');
const statKeluarQty = document.getElementById('stat-keluar-qty');
const statKeluarCount = document.getElementById('stat-keluar-count');
const statTotalCount = document.getElementById('stat-total-count');
const statTopOperator = document.getElementById('stat-top-operator');
const statTopOperatorSub = document.getElementById('stat-top-operator-sub');

function renderRingkasan() {
  if (currentRole() !== 'admin') return;
  const range = getPeriodRange(periodMode, periodDate);
  ringkasanDate.textContent = range.label;

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  let masukQty = 0, masukCount = 0, keluarQty = 0, keluarCount = 0;
  currentEntries.forEach(t => {
    if (inPeriod(t, range)) {
      if (t.jenis === 'masuk') { masukQty += t.jumlah; masukCount++; }
      else { keluarQty += t.jumlah; keluarCount++; }
    }
  });
  statMasukQty.textContent = masukQty.toLocaleString('id-ID');
  statMasukCount.textContent = `${masukCount} laporan`;
  statKeluarQty.textContent = keluarQty.toLocaleString('id-ID');
  statKeluarCount.textContent = `${keluarCount} laporan`;
  statTotalCount.textContent = currentEntries.length.toLocaleString('id-ID');

  const opCount = {};
  currentEntries.forEach(t => {
    if (t.createdAt >= sevenDaysAgo) {
      opCount[t.operator] = (opCount[t.operator] || 0) + 1;
    }
  });
  const opEntries = Object.entries(opCount).sort((a, b) => b[1] - a[1]);
  if (opEntries.length > 0) {
    statTopOperator.textContent = opEntries[0][0];
    statTopOperatorSub.textContent = `${opEntries[0][1]} laporan`;
  } else {
    statTopOperator.textContent = '-';
    statTopOperatorSub.textContent = 'belum ada data';
  }

  const arusEmpty = document.getElementById('arus-empty');
  const arusSplit = document.getElementById('arus-split');
  const totalArus = masukQty + keluarQty;
  if (totalArus === 0) {
    arusEmpty.hidden = false;
    arusSplit.hidden = true;
  } else {
    arusEmpty.hidden = true;
    arusSplit.hidden = false;
    const pctMasuk = Math.round((masukQty / totalArus) * 100);
    const pctKeluar = 100 - pctMasuk;
    document.getElementById('arus-seg-masuk').style.width = pctMasuk + '%';
    document.getElementById('arus-seg-keluar').style.width = pctKeluar + '%';
    document.getElementById('arus-pct-masuk').textContent = pctMasuk + '%';
    document.getElementById('arus-pct-keluar').textContent = pctKeluar + '%';
  }

  const trendEl = document.getElementById('arus-trend');
  const prevRange = getPreviousPeriodRange(periodMode, periodDate);
  if (!prevRange) {
    trendEl.hidden = true;
  } else {
    let prevTotal = 0;
    currentEntries.forEach(t => { if (inPeriod(t, prevRange)) prevTotal += t.jumlah; });
    if (prevTotal === 0 && totalArus === 0) {
      trendEl.hidden = true;
    } else {
      trendEl.hidden = false;
      let pct = prevTotal === 0 ? 100 : Math.round(((totalArus - prevTotal) / prevTotal) * 100);
      if (pct > 0) { trendEl.className = 'vis-trend up'; trendEl.textContent = `▲ ${pct}%`; }
      else if (pct < 0) { trendEl.className = 'vis-trend down'; trendEl.textContent = `▼ ${Math.abs(pct)}%`; }
      else { trendEl.className = 'vis-trend flat'; trendEl.textContent = `= sama`; }
    }
  }

  const barangCount = {};
  const barangKode = {};
  currentEntries.forEach(t => {
    if (t.createdAt >= thirtyDaysAgo) {
      barangCount[t.namaBarang] = (barangCount[t.namaBarang] || 0) + 1;
      barangKode[t.namaBarang] = t.kodeBarang;
    }
  });
  const topBarang = Object.entries(barangCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topBarangList = document.getElementById('top-barang-list');
  const topBarangEmpty = document.getElementById('top-barang-empty');
  topBarangList.innerHTML = '';
  if (topBarang.length > 0) {
    topBarangEmpty.hidden = true;
    const max = topBarang[0][1];
    topBarang.forEach(([nama, jml]) => {
      const row = document.createElement('div');
      row.className = 'bar-row';
      const pct = Math.max(6, Math.round((jml / max) * 100));
      row.innerHTML = `
        <div class="bar-row-top">
          <span class="bar-row-name" title="${escapeHtml(nama)}">${escapeHtml(nama)}</span>
          <span class="bar-row-val">${jml}x</span>
        </div>
        <div class="bar-row-track"><div class="bar-row-fill" style="width:${pct}%"></div></div>
      `;
      row.addEventListener('click', () => openItemModal(barangKode[nama]));
      topBarangList.appendChild(row);
    });
  } else {
    topBarangEmpty.hidden = false;
  }

  const locStock = buildLocationStock(currentEntries);
  const topLokasi = locStock.slice().sort((a, b) => b.totalQty - a.totalQty).slice(0, 5);
  const topLokasiList = document.getElementById('top-lokasi-list');
  const topLokasiEmpty = document.getElementById('top-lokasi-empty');
  topLokasiList.innerHTML = '';
  if (topLokasi.length > 0) {
    topLokasiEmpty.hidden = true;
    const max = Math.max(...topLokasi.map(l => l.totalQty), 1);
    topLokasi.forEach(l => {
      const row = document.createElement('div');
      row.className = 'bar-row bar-row-lokasi';
      const pct = Math.max(6, Math.round((l.totalQty / max) * 100));
      row.innerHTML = `
        <div class="bar-row-top">
          <span class="bar-row-name mono">${escapeHtml(l.lokasi)}</span>
          <span class="bar-row-val">${l.totalQty.toLocaleString('id-ID')} pcs</span>
        </div>
        <div class="bar-row-track"><div class="bar-row-fill" style="width:${pct}%"></div></div>
      `;
      row.addEventListener('click', () => openLokasiModal(l.lokasi));
      topLokasiList.appendChild(row);
    });
  } else {
    topLokasiEmpty.hidden = false;
  }
}

/* ==========================================================================
   KATALOG & STOK — jelajah gabungan (admin & operator)
   Satu daftar "folder" yang bisa dilihat dari 4 sisi berbeda:
   - barang    -> pakai buildStokList()      (sudah ada)
   - lokasi    -> pakai buildLocationStock() (sudah ada)
   - supplier  -> pakai buildAttributeBreakdown(entries, 'supplier')
   - pemilik   -> pakai buildAttributeBreakdown(entries, 'pemilik')
   Klik folder mana pun akan membuka modal detail yang sesuai.
========================================================================== */
const katalogList = document.getElementById('katalog-list');
const katalogEmpty = document.getElementById('katalog-empty');
const searchKatalog = document.getElementById('search-katalog');
const katalogHint = document.getElementById('katalog-hint');
const katalogModeTabs = document.getElementById('katalog-mode-tabs');

let katalogMode = 'barang';

// Kelompokkan transaksi berdasarkan satu field (supplier / pemilik), dan
// hitung barang apa saja + berapa stok saat ini yang berkaitan dengan tiap
// nilai field tersebut. Dipakai untuk mode "Supplier" & "Pemilik".
function buildAttributeBreakdown(entries, field) {
  const map = {};
  entries.forEach(t => {
    const key = t[field];
    if (!key || key === '-') return;
    if (!map[key]) map[key] = {};
    const itemKey = t.kodeBarang || t.namaBarang;
    if (!map[key][itemKey]) map[key][itemKey] = { kode: t.kodeBarang, nama: t.namaBarang, masuk: 0, keluar: 0 };
    if (t.jenis === 'masuk') map[key][itemKey].masuk += t.jumlah;
    else map[key][itemKey].keluar += t.jumlah;
  });
  return Object.entries(map).map(([nama, itemsMap]) => {
    const items = Object.values(itemsMap)
      .map(it => ({ ...it, stok: it.masuk - it.keluar }))
      .sort((a, b) => b.stok - a.stok);
    const totalStok = items.reduce((s, it) => s + it.stok, 0);
    return { nama, items, itemCount: items.length, totalStok };
  }).sort((a, b) => a.nama.localeCompare(b.nama));
}

function folderIconSvg() {
  return '<svg class="folder-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 7a2 2 0 0 1 2-2h4.17a2 2 0 0 1 1.42.59L12 7h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" fill="currentColor"/></svg>';
}

function appendFolderCard(container, { label, sub, dotClass, dotTitle, countBadge, countTitle, extraClass, onClick }) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'folder-card' + (extraClass ? ' ' + extraClass : '');
  const dotHtml = dotClass ? `<span class="folder-dot ${dotClass}"${dotTitle ? ` title="${escapeHtml(dotTitle)}"` : ''}></span>` : '';
  const countHtml = countBadge != null ? `<span class="folder-count"${countTitle ? ` title="${escapeHtml(countTitle)}"` : ''}>${countBadge}</span>` : '';
  card.innerHTML = `
    <div class="folder-icon-wrap">
      ${folderIconSvg()}
      ${dotHtml}${countHtml}
    </div>
    <div class="folder-label" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
    <div class="folder-sub mono">${escapeHtml(sub)}</div>
  `;
  card.addEventListener('click', onClick);
  container.appendChild(card);
}

function setKatalogEmpty(msg) {
  katalogEmpty.hidden = false;
  katalogEmpty.textContent = msg;
}

function renderKatalog() {
  const q = searchKatalog.value.trim().toLowerCase();
  katalogList.innerHTML = '';

  if (katalogMode === 'barang') {
    const items = buildStokList(currentEntries);
    const filtered = q ? items.filter(it => it.nama.toLowerCase().includes(q) || String(it.kode).toLowerCase().includes(q)) : items;
    if (items.length === 0) return setKatalogEmpty('Belum ada barang yang tercatat.');
    if (filtered.length === 0) return setKatalogEmpty('Tidak ada barang yang cocok dengan pencarian.');
    katalogEmpty.hidden = true;
    katalogHint.textContent = `📁 ${items.length} barang. Klik untuk lihat stok, lokasi, supplier, pemilik & riwayat.`;
    filtered.forEach(it => {
      const stok = it.masuk - it.keluar;
      const dotClass = stok > 0 ? 'pos' : (stok < 0 ? 'neg' : 'zero');
      appendFolderCard(katalogList, {
        label: it.nama, sub: it.kode, dotClass,
        dotTitle: `Stok saat ini: ${stok.toLocaleString('id-ID')} pcs`,
        onClick: () => openItemModal(it.kode),
      });
    });

  } else if (katalogMode === 'lokasi') {
    const all = buildLocationStock(currentEntries);
    const filtered = q ? all.filter(l => l.lokasi.toLowerCase().includes(q)) : all;
    if (all.length === 0) return setKatalogEmpty('Belum ada stok tercatat di lokasi manapun.');
    if (filtered.length === 0) return setKatalogEmpty('Tidak ada lokasi yang cocok dengan pencarian.');
    katalogEmpty.hidden = true;
    katalogHint.textContent = `📁 ${all.length} lokasi terisi. Klik untuk lihat barang apa saja di dalamnya.`;
    filtered.forEach(l => {
      appendFolderCard(katalogList, {
        label: l.lokasi, sub: `${l.totalQty.toLocaleString('id-ID')} pcs`,
        extraClass: 'folder-card-lokasi',
        countBadge: l.itemCount, countTitle: `${l.itemCount} jenis barang`,
        onClick: () => openLokasiModal(l.lokasi),
      });
    });

  } else if (katalogMode === 'supplier' || katalogMode === 'pemilik') {
    const field = katalogMode === 'supplier' ? 'supplier' : 'pemilik';
    const all = buildAttributeBreakdown(currentEntries, field);
    const filtered = q ? all.filter(d => d.nama.toLowerCase().includes(q)) : all;
    const labelJenis = katalogMode === 'supplier' ? 'supplier' : 'pemilik barang';
    if (all.length === 0) return setKatalogEmpty(`Belum ada data ${labelJenis}.`);
    if (filtered.length === 0) return setKatalogEmpty(`Tidak ada ${labelJenis} yang cocok dengan pencarian.`);
    katalogEmpty.hidden = true;
    katalogHint.textContent = `📁 ${all.length} ${labelJenis}. Klik untuk lihat barang apa saja yang terkait.`;
    filtered.forEach(d => {
      appendFolderCard(katalogList, {
        label: d.nama, sub: `${d.totalStok.toLocaleString('id-ID')} pcs`,
        extraClass: katalogMode === 'supplier' ? 'folder-card-supplier' : 'folder-card-pemilik',
        countBadge: d.itemCount, countTitle: `${d.itemCount} jenis barang`,
        onClick: () => openAttributeModal(katalogMode, d.nama),
      });
    });
  }
}

if (katalogModeTabs) {
  katalogModeTabs.querySelectorAll('.period-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      katalogModeTabs.querySelectorAll('.period-tab').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      katalogMode = btn.dataset.mode;
      searchKatalog.value = '';
      renderKatalog();
    });
  });
}

searchKatalog.addEventListener('input', renderKatalog);

/* ==========================================================================
   AKUN OPERATOR TERDAFTAR (admin)
========================================================================== */
const akunOperatorListEl = document.getElementById('akun-operator-list');
const akunOperatorEmptyEl = document.getElementById('akun-operator-empty');
const searchAkunOperator = document.getElementById('search-akun-operator');

function renderAkunOperator() {
  if (!akunOperatorListEl || currentRole() !== 'admin') return;

  const all = currentOperatorAccounts.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const q = searchAkunOperator ? searchAkunOperator.value.trim().toLowerCase() : '';
  const filtered = q
    ? all.filter(a => (a.nama || '').toLowerCase().includes(q) || (a.idKaryawan || '').toLowerCase().includes(q))
    : all;

  akunOperatorListEl.innerHTML = '';
  if (all.length === 0) {
    akunOperatorEmptyEl.hidden = false;
    akunOperatorEmptyEl.textContent = 'Belum ada operator yang mendaftar.';
    return;
  }
  if (filtered.length === 0) {
    akunOperatorEmptyEl.hidden = false;
    akunOperatorEmptyEl.textContent = 'Tidak ada akun yang cocok dengan pencarian.';
    return;
  }
  akunOperatorEmptyEl.hidden = true;

  filtered.forEach(a => {
    const row = document.createElement('div');
    row.className = 'akun-operator-item';
    row.innerHTML = `
      <div class="akun-operator-main">
        <span class="akun-operator-nama">${escapeHtml(a.nama || '-')}</span>
        <span class="akun-operator-meta">ID Karyawan: <span class="mono">${escapeHtml(a.idKaryawan || '-')}</span></span>
      </div>
      <div class="akun-operator-actions">
        <span class="akun-operator-date">Daftar: ${a.createdAt ? formatWaktu(a.createdAt) : '-'}</span>
        <button type="button" class="icon-btn danger btn-hapus-akun" title="Hapus akun ini" aria-label="Hapus">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    `;
    row.querySelector('.btn-hapus-akun').addEventListener('click', async () => {
      if (!confirm(`Hapus akun operator "${a.nama}"? Operator ini tidak akan bisa masuk lagi sampai mendaftar ulang.`)) return;
      try {
        const fb = window.gudangFirebase;
        await fb.deleteDoc(fb.doc(fb.db, 'operator', a.id));
        showToast('Akun operator dihapus.');
      } catch (err) {
        showToast('Gagal menghapus akun: ' + err.message, 'error');
      }
    });
    akunOperatorListEl.appendChild(row);
  });
}

if (searchAkunOperator) searchAkunOperator.addEventListener('input', renderAkunOperator);

/* ---- Modal detail lokasi ---- */
function openLokasiModal(lokasi) {
  const all = buildLocationStock(currentEntries);
  const data = all.find(l => l.lokasi === lokasi);
  if (!data) return;

  modalBody.innerHTML = `
    <div class="modal-item-head">
      <div class="modal-item-kode">LOKASI PENYIMPANAN</div>
      <h2 class="modal-item-nama mono">${escapeHtml(data.lokasi)}</h2>
    </div>
    <div class="modal-stat-grid">
      <div class="modal-stat"><span>Jenis Barang</span><strong>${data.itemCount}</strong></div>
      <div class="modal-stat"><span>Total Stok</span><strong>${data.totalQty.toLocaleString('id-ID')}</strong></div>
      <div class="modal-stat"><span>&nbsp;</span><strong>&nbsp;</strong></div>
    </div>
    <div class="modal-section">
      <h4>Barang di Lokasi Ini</h4>
      <div class="modal-history-list">
        ${data.items.map(it => `
          <div class="modal-lokasi-item-row" data-kode="${escapeHtml(it.kode)}">
            <span>
              <span class="li-nama">${escapeHtml(it.nama)}</span>
              <span class="li-kode">${escapeHtml(it.kode)}</span>
            </span>
            <span class="li-qty">${it.qty.toLocaleString('id-ID')} pcs</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  modalBody.querySelectorAll('.modal-lokasi-item-row').forEach(row => {
    row.addEventListener('click', () => openItemModal(row.dataset.kode));
  });
  itemModal.hidden = false;
}

/* ---- Modal detail supplier / pemilik barang ---- */
function openAttributeModal(kind, nama) {
  const field = kind === 'supplier' ? 'supplier' : 'pemilik';
  const all = buildAttributeBreakdown(currentEntries, field);
  const data = all.find(d => d.nama === nama);
  if (!data) return;

  const labelJenis = kind === 'supplier' ? 'SUPPLIER' : 'PEMILIK BARANG (PABRIK)';

  modalBody.innerHTML = `
    <div class="modal-item-head">
      <div class="modal-item-kode">${labelJenis}</div>
      <h2 class="modal-item-nama">${escapeHtml(data.nama)}</h2>
    </div>
    <div class="modal-stat-grid">
      <div class="modal-stat"><span>Jenis Barang</span><strong>${data.itemCount}</strong></div>
      <div class="modal-stat"><span>Total Stok Terkait</span><strong>${data.totalStok.toLocaleString('id-ID')}</strong></div>
      <div class="modal-stat"><span>&nbsp;</span><strong>&nbsp;</strong></div>
    </div>
    <div class="modal-section">
      <h4>Barang Terkait</h4>
      <div class="modal-history-list">
        ${data.items.map(it => `
          <div class="modal-lokasi-item-row" data-kode="${escapeHtml(it.kode)}">
            <span>
              <span class="li-nama">${escapeHtml(it.nama)}</span>
              <span class="li-kode">${escapeHtml(it.kode)}</span>
            </span>
            <span class="li-qty">${it.stok.toLocaleString('id-ID')} pcs</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  modalBody.querySelectorAll('.modal-lokasi-item-row').forEach(row => {
    row.addEventListener('click', () => openItemModal(row.dataset.kode));
  });
  itemModal.hidden = false;
}

/* ---- Modal detail barang ---- */
const itemModal = document.getElementById('item-modal');
const modalBody = document.getElementById('modal-body');
document.getElementById('modal-close').addEventListener('click', closeItemModal);
itemModal.addEventListener('click', (e) => { if (e.target === itemModal) closeItemModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeItemModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && scanModal && !scanModal.hidden) closeScanModal(); });

function closeItemModal() { itemModal.hidden = true; }

function lokasiBreakdown(history) {
  const map = {};
  history.forEach(t => {
    if (!t.lokasi) return;
    map[t.lokasi] = (map[t.lokasi] || 0) + (t.jenis === 'masuk' ? t.jumlah : -t.jumlah);
  });
  return Object.entries(map).filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]);
}

function openItemModal(kode) {
  if (!kode) return;
  const items = buildStokList(currentEntries);
  const item = items.find(i => i.kode === kode);
  if (!item) return;

  const stok = item.masuk - item.keluar;
  const lokasiList = lokasiBreakdown(item.history);
  const historySorted = [...item.history].sort((a, b) => b.createdAt - a.createdAt);

  modalBody.innerHTML = `
    <div class="modal-item-head">
      <div class="modal-item-kode mono">${escapeHtml(item.kode || '-')}</div>
      <h2 class="modal-item-nama">${escapeHtml(item.nama)}</h2>
    </div>
    <div class="modal-stat-grid">
      <div class="modal-stat"><span>Stok Saat Ini</span><strong class="${stok <= 0 ? 'neg' : ''}">${stok.toLocaleString('id-ID')}</strong></div>
      <div class="modal-stat"><span>Total Masuk</span><strong>${item.masuk.toLocaleString('id-ID')}</strong></div>
      <div class="modal-stat"><span>Total Keluar</span><strong>${item.keluar.toLocaleString('id-ID')}</strong></div>
    </div>
    <div class="modal-section">
      <h4>Lokasi Penyimpanan</h4>
      ${lokasiList.length
        ? `<div class="lokasi-chips">${lokasiList.map(([lok, qty]) => `<button type="button" class="lokasi-chip" data-lokasi="${escapeHtml(lok)}">${escapeHtml(lok)} <b>${qty}</b></button>`).join('')}</div>`
        : '<p class="muted">Tidak ada stok aktif di lokasi manapun.</p>'}
    </div>
    <div class="modal-section modal-section-grid">
      <div>
        <h4>Terakhir Masuk</h4>
        ${item.lastMasuk
          ? `<p>${formatTanggal(item.lastMasuk.tanggal)} — ${item.lastMasuk.jumlah} pcs<br><span class="muted">${escapeHtml(item.lastMasuk.supplier || '-')} · ${escapeHtml(item.lastMasuk.lokasi || '-')}</span></p>`
          : '<p class="muted">Belum pernah.</p>'}
      </div>
      <div>
        <h4>Terakhir Keluar</h4>
        ${item.lastKeluar
          ? `<p>${formatTanggal(item.lastKeluar.tanggal)} — ${item.lastKeluar.jumlah} pcs<br><span class="muted">${escapeHtml(item.lastKeluar.lokasi || '-')}</span></p>`
          : '<p class="muted">Belum pernah.</p>'}
      </div>
    </div>
    <div class="modal-section">
      <h4>Riwayat Transaksi (${historySorted.length})</h4>
      <div class="modal-history-list">
        ${historySorted.map(t => `
          <div class="modal-history-row">
            <span class="badge-jenis ${t.jenis === 'masuk' ? 'badge-masuk' : 'badge-keluar'}">${t.jenis === 'masuk' ? 'MASUK' : 'KELUAR'}${t.tipe === 'penyesuaian' ? ' · PNY' : ''}</span>
            <span>${formatTanggal(t.tanggal)} · ${escapeHtml(t.lokasi)}</span>
            <span>${t.jumlah} pcs</span>
            <span class="muted">${escapeHtml(t.operator)}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  modalBody.querySelectorAll('.lokasi-chip').forEach(chip => {
    chip.addEventListener('click', () => openLokasiModal(chip.dataset.lokasi));
  });
  itemModal.hidden = false;
}

/* ==========================================================================
   RIWAYAT (admin)
========================================================================== */
const riwayatList = document.getElementById('riwayat-list');
const riwayatEmpty = document.getElementById('riwayat-empty');
const riwayatHint = document.getElementById('riwayat-hint');
const searchRiwayat = document.getElementById('search-riwayat');

function renderRiwayat() {
  if (currentRole() !== 'admin') return;
  const range = getPeriodRange(periodMode, periodDate);
  riwayatHint.textContent = `Menampilkan laporan periode: ${range.label}`;

  let all = currentEntries.filter(t => inPeriod(t, range));
  all = all.sort((a, b) => b.createdAt - a.createdAt);

  const q = searchRiwayat.value.trim().toLowerCase();
  const filtered = q
    ? all.filter(t => t.operator.toLowerCase().includes(q) || t.namaBarang.toLowerCase().includes(q) || t.kodeBarang.includes(q))
    : all;

  riwayatList.innerHTML = '';
  if (filtered.length === 0) {
    riwayatEmpty.hidden = false;
    riwayatEmpty.textContent = all.length === 0 ? 'Belum ada laporan pada periode ini.' : 'Tidak ada laporan yang cocok dengan pencarian.';
    return;
  }
  riwayatEmpty.hidden = true;

  filtered.forEach(t => {
    const isAdjustment = t.tipe === 'penyesuaian';
    const card = document.createElement('div');
    card.className = 'ticket';
    card.innerHTML = `
      <div class="ticket-top">
        <span class="badge-jenis ${t.jenis === 'masuk' ? 'badge-masuk' : 'badge-keluar'}">
          ${t.jenis === 'masuk' ? 'BARANG MASUK' : 'BARANG KELUAR'}
        </span>
        ${isAdjustment ? '<span class="badge-jenis badge-penyesuaian">PENYESUAIAN</span>' : ''}
        <span class="ticket-time">${formatWaktu(t.createdAt)}</span>
        <span class="ticket-actions">
          <button type="button" class="icon-btn btn-edit" title="Edit lokasi / jumlah" aria-label="Edit">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </button>
          <button type="button" class="icon-btn danger btn-delete" title="Hapus" aria-label="Hapus">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </span>
      </div>
      <div class="ticket-grid">
        <div><span class="lbl">Operator: </span>${escapeHtml(t.operator)}</div>
        <div><span class="lbl">Barang: </span><a class="link-barang" href="javascript:void(0)">${escapeHtml(t.namaBarang)}</a></div>
        <div><span class="lbl">Kode: </span><span class="mono">${escapeHtml(t.kodeBarang)}</span></div>
        <div><span class="lbl">Supplier: </span>${escapeHtml(t.supplier)}</div>
        <div><span class="lbl">Pemilik: </span>${escapeHtml(t.pemilik)}</div>
        <div class="ticket-lokasi-view"><span class="lbl">Lokasi: </span><button type="button" class="link-barang link-lokasi">${escapeHtml(t.lokasi)}</button></div>
        <div class="ticket-jumlah-view"><span class="lbl">Jumlah: </span>${t.jumlah} pcs</div>
        ${t.qtyPerPallet != null ? `<div><span class="lbl">Qty/Pallet: </span>${t.qtyPerPallet} pcs</div>` : ''}
        ${t.jumlahPallet != null ? `<div><span class="lbl">Jumlah Pallet: </span>${t.jumlahPallet}</div>` : ''}
        <div><span class="lbl">Tanggal: </span>${formatTanggal(t.tanggal)}</div>
      </div>
      ${t.keterangan ? `<div class="ticket-note"><b>Keterangan:</b> ${escapeHtml(t.keterangan)}</div>` : ''}
      <div class="ticket-edit" hidden>
        <div class="field">
          <label>Lokasi</label>
          <input type="text" class="edit-lokasi" list="dl-lokasi" value="${escapeHtml(t.lokasi)}">
        </div>
        <div class="field">
          <label>Jumlah</label>
          <input type="number" class="edit-jumlah" min="1" value="${t.jumlah}">
        </div>
        <div class="field field-full">
          <label>Keterangan</label>
          <input type="text" class="edit-keterangan" value="${escapeHtml(t.keterangan || '')}" placeholder="Contoh: koreksi lokasi hasil stock opname">
        </div>
        <div class="ticket-edit-actions">
          <button type="button" class="btn-mini btn-mini-cancel">Batal</button>
          <button type="button" class="btn-mini btn-mini-save">Simpan Perubahan</button>
        </div>
      </div>
    `;
    card.querySelector('.link-barang:not(.link-lokasi)').addEventListener('click', () => openItemModal(t.kodeBarang));
    card.querySelector('.link-lokasi').addEventListener('click', () => openLokasiModal(t.lokasi));

    const editPanel = card.querySelector('.ticket-edit');
    card.querySelector('.btn-edit').addEventListener('click', () => {
      editPanel.hidden = !editPanel.hidden;
    });
    card.querySelector('.btn-mini-cancel').addEventListener('click', () => { editPanel.hidden = true; });
    card.querySelector('.btn-mini-save').addEventListener('click', async () => {
      if (!firestoreReady) return showToast('Database tidak terhubung.', 'error');
      const newLokasi = card.querySelector('.edit-lokasi').value.trim();
      const newJumlah = parseInt(card.querySelector('.edit-jumlah').value, 10);
      const newKeterangan = card.querySelector('.edit-keterangan').value.trim();
      if (!newLokasi) return showToast('Lokasi tidak boleh kosong.', 'error');
      if (!newJumlah || newJumlah <= 0) return showToast('Jumlah harus lebih dari 0.', 'error');
      try {
        await updateEntryInFirestore(t.id, { lokasi: newLokasi, jumlah: newJumlah, keterangan: newKeterangan, updatedAt: Date.now() });
        showToast('Laporan berhasil diperbarui.');
      } catch (err) {
        showToast('Gagal menyimpan perubahan: ' + err.message, 'error');
      }
    });

    card.querySelector('.btn-delete').addEventListener('click', async () => {
      if (!confirm('Hapus laporan ini?')) return;
      if (!firestoreReady) return showToast('Database tidak terhubung.', 'error');
      try {
        await deleteEntryFromFirestore(t.id);
        showToast('Laporan dihapus.');
      } catch (err) {
        showToast('Gagal menghapus: ' + err.message, 'error');
      }
    });
    riwayatList.appendChild(card);
  });
}

searchRiwayat.addEventListener('input', renderRiwayat);

/* ==========================================================================
   EXPORT EXCEL & HAPUS SEMUA (admin)
========================================================================== */
document.getElementById('btn-export').addEventListener('click', () => {
  if (currentEntries.length === 0) {
    showToast('Belum ada data untuk diunduh.', 'error');
    return;
  }
  const wb = XLSX.utils.book_new();
  const groups = {};
  currentEntries.forEach(t => {
    const ym = (t.tanggal && /^\d{4}-\d{2}/.test(t.tanggal)) ? t.tanggal.slice(0, 7) : 'lainnya';
    (groups[ym] = groups[ym] || []).push(t);
  });
  Object.keys(groups).sort().forEach(ym => {
    const list = groups[ym].slice().sort((a, b) => (a.tanggal !== b.tanggal ? (a.tanggal < b.tanggal ? -1 : 1) : a.createdAt - b.createdAt));
    const label = ym === 'lainnya' ? 'Lainnya' : `${BULAN_PANJANG[parseInt(ym.split('-')[1], 10) - 1]} ${ym.split('-')[0]}`;
    XLSX.utils.book_append_sheet(wb, buildMonthSheet(list), safeSheetName(label));
  });
  XLSX.utils.book_append_sheet(wb, buildStokSheet(currentEntries), RINGKASAN_SHEET);
  wb.SheetNames.unshift(wb.SheetNames.pop());
  XLSX.writeFile(wb, `salinan-laporan-gudang-${todayISO()}.xlsx`);
  showToast('Salinan cadangan berhasil diunduh.');
});

document.getElementById('btn-clear').addEventListener('click', async () => {
  if (currentEntries.length === 0) return;
  if (!firestoreReady) return showToast('Database tidak terhubung.', 'error');
  if (!confirm('Hapus SEMUA laporan di database bersama ini? Tindakan ini tidak bisa dibatalkan.')) return;
  try {
    await clearAllEntriesInFirestore();
    showToast('Semua laporan telah dihapus.');
  } catch (err) {
    showToast('Gagal menghapus: ' + err.message, 'error');
  }
});

/* ==========================================================================
   STARTUP
========================================================================== */
(function start() {
  const existing = getSession();
  if (existing) {
    enterApp(existing);
  } else {
    switchLoginTab('operator');
    loginOperatorNama.focus();
  }
})();

window.addEventListener('gudang-firebase-auth-error', () => {
  setConnectUI('error');
});