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

function setupSearchableSelect({ id, options, getLabel, getSub, onSelect, placeholder }) {
  const wrap = document.getElementById(id);
  const btn = document.getElementById(`${id}-btn`);
  const valueEl = document.getElementById(`${id}-value`);
  const panel = document.getElementById(`${id}-panel`);
  const search = document.getElementById(`${id}-search`);
  const list = document.getElementById(`${id}-list`);

  if (!wrap || !btn || !valueEl || !panel || !search || !list) {
    console.warn(`setupSearchableSelect: markup untuk "${id}" tidak ditemukan, dilewati.`);
    return { getValue: () => null, reset: () => {}, setValue: () => {} };
  }

  let selected = null;

  function closeThis() { panel.hidden = true; btn.classList.remove('is-open'); }
  openPanels.push(closeThis);

  function renderList(query = '') {
    const q = query.trim().toLowerCase();
    let filtered = options;
    if (q) {
      filtered = options.filter(o =>
        getLabel(o).toLowerCase().includes(q) ||
        (getSub && getSub(o) && String(getSub(o)).toLowerCase().includes(q))
      );
    }
    list.innerHTML = '';
    if (filtered.length === 0) {
      list.innerHTML = '<div class="no-result">Tidak ditemukan</div>';
      return;
    }
    filtered.forEach(o => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'option-item';
      const sub = getSub ? getSub(o) : null;
      item.innerHTML = `<span class="opt-label">${escapeHtml(getLabel(o))}</span>` + (sub ? `<span class="opt-sub">${escapeHtml(sub)}</span>` : '');
      item.addEventListener('click', () => {
        selected = o;
        valueEl.textContent = getLabel(o);
        valueEl.classList.add('has-value');
        closeThis();
        search.value = '';
        onSelect(o);
      });
      list.appendChild(item);
    });
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
const operatorModeTabs = document.getElementById('operator-mode-tabs');
const tabOperatorLogin = document.getElementById('tab-operator-login');
const tabOperatorRegister = document.getElementById('tab-operator-register');
const formRegisterOperator = document.getElementById('form-register-operator');
const loginOperatorPassword = document.getElementById('login-operator-password');
const loginOperatorError = document.getElementById('login-operator-error');
const registerOperatorError = document.getElementById('register-operator-error');

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

formLoginOperator.addEventListener('submit', (e) => {
  e.preventDefault();
  const nama = loginOperatorNama.value.trim();
  if (!nama) { loginOperatorNama.focus(); return; }
  setSession({ role: 'operator', nama });
  enterApp({ role: 'operator', nama });
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

const MONTH_HEADERS = ['Tanggal', 'Jenis', 'Tipe', 'Nama Operator', 'Kode Barang', 'Nama Barang', 'Supplier', 'Pemilik Barang', 'Lokasi', 'Jumlah', 'Keterangan', 'Waktu Input', 'Waktu Diubah', 'ID'];
const MONTH_COL_WIDTHS = [12, 9, 13, 18, 14, 34, 22, 14, 10, 9, 28, 22, 22, 14];
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
    t.keterangan || '',
    new Date(t.createdAt).toISOString(),
    new Date(t.updatedAt).toISOString(),
    t.id,
  ]);
  const aoa = [MONTH_HEADERS, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = MONTH_COL_WIDTHS.map(w => ({ wch: w }));
  ws['!autofilter'] = { ref: `A1:N${aoa.length}` };
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
  renderLokasi();
  renderRiwayat();
}

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
        if (currentRole() === 'admin') renderAll();
      },
      (err) => {
        console.error('Firestore listen error:', err);
        firestoreReady = false;
        setConnectUI('error');
      }
    );
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

const selBarang = setupSearchableSelect({
  id: 'sel-barang',
  options: MASTER_DATA.barang,
  getLabel: o => o.nama,
  getSub: o => o.kode,
  placeholder: 'Pilih barang...',
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

const selPemilik = setupSearchableSelect({
  id: 'sel-pemilik',
  options: MASTER_DATA.pemilik,
  getLabel: o => o,
  placeholder: 'Pilih pemilik barang...',
  onSelect: () => {},
});

const selLokasi = setupSearchableSelect({
  id: 'sel-lokasi',
  options: MASTER_DATA.lokasi,
  getLabel: o => o,
  placeholder: 'Pilih lokasi...',
  onSelect: () => {},
});

const inputOperator = document.getElementById('input-operator');
const inputTanggal = document.getElementById('input-tanggal');
const inputJumlah = document.getElementById('input-jumlah');
const formError = document.getElementById('form-error');
const form = document.getElementById('form-laporan');

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

  if (!operator) return showError('Nama operator wajib diisi.');
  if (!barang) return showError('Pilih nama barang terlebih dahulu.');
  if (!supplier) return showError('Pilih supplier terlebih dahulu.');
  if (!pemilik) return showError('Pilih pemilik barang (pabrik) terlebih dahulu.');
  if (!lokasi) return showError('Pilih lokasi penyimpanan terlebih dahulu.');
  if (!tanggal) return showError('Tanggal wajib diisi.');
  if (!jumlah || jumlah <= 0) return showError('Jumlah barang harus berupa angka lebih dari 0.');

  const submitBtn = document.getElementById('btn-submit');
  const submitText = document.getElementById('btn-submit-text');
  submitBtn.disabled = true;
  const originalText = submitText.textContent;
  submitText.textContent = 'MENYIMPAN...';

  try {
    const now = Date.now();
    await addEntryToFirestore({
      jenis, tipe: 'transaksi', operator, kodeBarang: barang.kode, namaBarang: barang.nama,
      supplier, pemilik, lokasi, jumlah, keterangan: '', tanggal, createdAt: now, updatedAt: now,
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

const selAdjBarang = setupSearchableSelect({
  id: 'sel-adj-barang',
  options: MASTER_DATA.barang,
  getLabel: o => o.nama,
  getSub: o => o.kode,
  placeholder: 'Pilih barang...',
  onSelect: (o) => {
    document.getElementById('adj-kode-box').hidden = false;
    document.getElementById('adj-kode-value').textContent = o.kode;
  },
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
    const lokasi = selAdjLokasi.getValue();
    const tanggal = adjTanggal.value;
    const jumlah = parseInt(adjJumlah.value, 10);
    const keterangan = adjKeterangan.value.trim();

    if (!barang) return showAdjError('Pilih nama barang terlebih dahulu.');
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
        pemilik: '-',
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
========================================================================== */
let periodMode = 'harian';
let periodDate = todayISO();

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
   KATALOG BARANG & STOK (admin)
========================================================================== */
const katalogList = document.getElementById('katalog-list');
const katalogEmpty = document.getElementById('katalog-empty');
const searchKatalog = document.getElementById('search-katalog');

function renderKatalog() {
  if (currentRole() !== 'admin') return;
  const items = buildStokList(currentEntries);
  const q = searchKatalog.value.trim().toLowerCase();
  const filtered = q
    ? items.filter(it => it.nama.toLowerCase().includes(q) || String(it.kode).toLowerCase().includes(q))
    : items;

  katalogList.innerHTML = '';
  if (items.length === 0) {
    katalogEmpty.hidden = false;
    katalogEmpty.textContent = 'Belum ada barang yang tercatat.';
    return;
  }
  if (filtered.length === 0) {
    katalogEmpty.hidden = false;
    katalogEmpty.textContent = 'Tidak ada barang yang cocok dengan pencarian.';
    return;
  }
  katalogEmpty.hidden = true;

  filtered.forEach(it => {
    const stok = it.masuk - it.keluar;
    const badgeClass = stok > 0 ? 'pos' : (stok < 0 ? 'neg' : 'zero');
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'katalog-item';
    const lokasiTxt = Array.from(it.lokasi).slice(0, 3).join(', ') + (it.lokasi.size > 3 ? `, +${it.lokasi.size - 3} lagi` : '');
    card.innerHTML = `
      <div class="katalog-item-top">
        <div>
          <div class="katalog-item-nama">${escapeHtml(it.nama)}</div>
          <div class="katalog-item-kode mono">${escapeHtml(it.kode)}</div>
        </div>
        <span class="stok-badge ${badgeClass}">${stok.toLocaleString('id-ID')} pcs</span>
      </div>
      <div class="katalog-item-loc">📍 ${it.lokasi.size ? escapeHtml(lokasiTxt) : 'Belum ada lokasi aktif'}</div>
    `;
    card.addEventListener('click', () => openItemModal(it.kode));
    katalogList.appendChild(card);
  });
}

searchKatalog.addEventListener('input', renderKatalog);

/* ==========================================================================
   STOK PER LOKASI (admin)
========================================================================== */
const lokasiListEl = document.getElementById('lokasi-list');
const lokasiEmptyEl = document.getElementById('lokasi-empty');
const lokasiHintEl = document.getElementById('lokasi-hint');
const searchLokasi = document.getElementById('search-lokasi');

function renderLokasi() {
  if (currentRole() !== 'admin') return;
  const all = buildLocationStock(currentEntries);
  const q = searchLokasi.value.trim().toLowerCase();
  const filtered = q ? all.filter(l => l.lokasi.toLowerCase().includes(q)) : all;

  lokasiListEl.innerHTML = '';
  if (all.length === 0) {
    lokasiEmptyEl.hidden = false;
    lokasiEmptyEl.textContent = 'Belum ada stok tercatat di lokasi manapun.';
    lokasiHintEl.textContent = 'Klik salah satu lokasi untuk melihat barang apa saja yang ada di sana.';
    return;
  }
  if (filtered.length === 0) {
    lokasiEmptyEl.hidden = false;
    lokasiEmptyEl.textContent = 'Tidak ada lokasi yang cocok dengan pencarian.';
    return;
  }
  lokasiEmptyEl.hidden = true;
  lokasiHintEl.textContent = `${all.length} lokasi terisi. Klik salah satu untuk detail.`;

  filtered.forEach(l => {
    const preview = l.items.slice(0, 3).map(it => `${escapeHtml(it.nama)} <b>${it.qty}</b>`).join(', ');
    const more = l.items.length > 3 ? `, +${l.items.length - 3} barang lagi` : '';
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'lokasi-item';
    card.innerHTML = `
      <div class="lokasi-item-top">
        <span class="lokasi-item-kode">${escapeHtml(l.lokasi)}</span>
        <span class="lokasi-item-count">${l.itemCount} jenis barang</span>
      </div>
      <div class="lokasi-item-preview">${preview}${more}</div>
      <div class="lokasi-item-total">${l.totalQty.toLocaleString('id-ID')} pcs total</div>
    `;
    card.addEventListener('click', () => openLokasiModal(l.lokasi));
    lokasiListEl.appendChild(card);
  });
}

if (searchLokasi) searchLokasi.addEventListener('input', renderLokasi);

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

/* ---- Modal detail barang ---- */
const itemModal = document.getElementById('item-modal');
const modalBody = document.getElementById('modal-body');
document.getElementById('modal-close').addEventListener('click', closeItemModal);
itemModal.addEventListener('click', (e) => { if (e.target === itemModal) closeItemModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeItemModal(); });

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
        <div class="ticket-jumlah-view"><span class="lbl">Jumlah: </span>${t.jumlah}</div>
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