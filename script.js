/* ==========================================================================
   GLOBAL STATE & UTILITIES
========================================================================== */

// Deklarasi global variables untuk transaksi & data master
// Harus di-deklarasikan DI ATAS class definition untuk avoid TDZ (Temporal Dead Zone)
let currentEntries = [];
let currentEntriesRaw = [];

/* ==========================================================================
   OVERLAY MASTER DATA — barang, supplier, pemilik, lokasi
   Data induk (kode barang, nama supplier, dst) berasal dari data.js
   (statis, dikirim sama persis ke semua pengunjung — tidak bisa diedit
   dari aplikasi). Panel admin "Pengelolaan Barang" TIDAK mengubah data.js
   — sebagai gantinya setiap tambah/ubah/hapus ditulis sebagai dokumen
   "overlay" ke Firestore (koleksi barangBaru, supplierBaru, pemilikBaru,
   lokasiBaru — lihat startBarangBaruListener() dkk di bawah), dan
   disinkronkan REAL-TIME ke semua perangkat lewat onSnapshot. Dropdown
   operator (form Barang Masuk/Keluar) SELALU memakai variabel *_OPTIONS
   di bawah ini (gabungan data statis + overlay), jadi begitu admin
   menyimpan perubahan di satu perangkat, operator di perangkat lain
   otomatis melihatnya tanpa reload manual.
   Hapus = tombstone (dokumen overlay dengan deleted:true), BUKAN
   deleteDoc — supaya entri bawaan data.js (yang tidak mungkin dihapus
   dari file statisnya) tetap bisa "disembunyikan" secara konsisten di
   semua perangkat.
   Dideklarasikan di ATAS (sebelum KatalogManager) supaya tidak kena
   Temporal Dead Zone — katalogManager.init() dipanggil sinkron begitu
   file ini dimuat, jauh sebelum listener Firestore di bawah sempat jalan.
========================================================================== */
let barangOverlay = new Map();    // kode -> { kode, nama, deleted }
let supplierOverlay = new Map();  // id -> { nama, deleted }
let pemilikOverlay = new Map();   // id -> { nama, deleted }
let lokasiOverlay = new Map();    // id -> { nama, deleted }

let BARANG_OPTIONS = MASTER_DATA.barang || [];
let SUPPLIER_OPTIONS = MASTER_DATA.supplier || [];
let PEMILIK_OPTIONS_MERGED = MASTER_DATA.pemilik || [];
let LOKASI_OPTIONS = MASTER_DATA.lokasi || [];
let LOKASI_SET = new Set(LOKASI_OPTIONS);

// Widget dropdown/select yang perlu di-refresh (updateOptions) begitu
// salah satu daftar di atas berubah. Diisi belakangan saat form input
// laporan dibuat (lihat sekitar "FORM INPUT — OPERATOR ONLY" di bawah) —
// dideklarasikan `let` di sini lebih dulu supaya rebuild*Options() yang
// mungkin terpanggil lebih awal (dari listener Firestore) tidak kena
// ReferenceError.
let selBarang;
let selSupplier;
let selPemilik;

// Doc ID Firestore tidak boleh mengandung "/". Nama supplier/pemilik/
// lokasi di aplikasi ini praktiknya tidak pernah memakai "/", tapi tetap
// dijaga (diganti "-") supaya tidak pernah menyebabkan error tak terduga.
function sanitizeMasterId(nama) {
  return String(nama || '').trim().replace(/\//g, '-');
}

/* ==========================================================================
   UTILITY FUNCTIONS
========================================================================== */

// Hitung stok barang tertentu di SATU lokasi spesifik saja (bukan total
// gabungan semua lokasi). Dipakai untuk mencegah barang keluar / penyesuaian
// kurang membuat stok minus di lokasi tersebut, walau total stok barang itu
// di lokasi lain masih banyak.
function getStokAtLokasi(entries, kodeBarang, lokasi) {
  return entries
    .filter(t => t.kodeBarang === kodeBarang && t.lokasi === lokasi)
    .reduce((s, t) => s + (t.jenis === 'masuk' ? t.jumlah : -t.jumlah), 0);
}

/* ==========================================================================
   KOMBINASI TERIKAT (ITEM MASTER "SATU IKAT")
   Barang tidak lagi bebas keluar dengan supplier/pemilik/lokasi apa saja.
   Setiap barang MASUK mengikat kode+nama+supplier+pemilik+lokasi menjadi
   satu kombinasi. Barang KELUAR wajib memakai kombinasi yang PERSIS sama
   dengan yang pernah tercatat masuk (dan masih ada sisa stok/palletnya) —
   kalau kombinasinya beda, dianggap "barang lain" walau kode & namanya
   sama, dan akan ditolak. Ini dihitung langsung dari riwayat transaksi
   (currentEntries), jadi tidak perlu koleksi/master data baru di Firestore
   ataupun migrasi data lama — cukup mengikat data yang sudah ada.
========================================================================== */

// Kunci unik satu kombinasi (dipakai untuk mengelompokkan transaksi).
function comboKey(kodeBarang, supplier, pemilik, lokasi) {
  return [kodeBarang, supplier, pemilik, lokasi].join('␟');
}

// Sisa stok (pcs) HANYA untuk kombinasi kode+supplier+pemilik+lokasi yang
// persis sama — ini yang membuat barang "terikat" (beda supplier/pemilik/
// lokasi = beda saldo, tidak bisa saling menutupi).
function getStokKombinasi(entries, kodeBarang, supplier, pemilik, lokasi) {
  return entries
    .filter(t => t.kodeBarang === kodeBarang && t.supplier === supplier && t.pemilik === pemilik && t.lokasi === lokasi)
    .reduce((s, t) => s + (t.jenis === 'masuk' ? t.jumlah : -t.jumlah), 0);
}

// Sama seperti getStokKombinasi tapi untuk saldo jumlah pallet-nya.
function getPalletKombinasi(entries, kodeBarang, supplier, pemilik, lokasi) {
  return entries
    .filter(t => t.kodeBarang === kodeBarang && t.supplier === supplier && t.pemilik === pemilik && t.lokasi === lokasi && t.jumlahPallet != null)
    .reduce((s, t) => s + (t.jenis === 'masuk' ? t.jumlahPallet : -t.jumlahPallet), 0);
}

// Tanggal kedatangan (masuk) paling awal untuk satu kombinasi kode+supplier+
// pemilik+lokasi. Dipakai untuk menampilkan "asal" tanggal kedatangan barang
// pada laporan KELUAR di Riwayat (jenis 'keluar' hanya punya tanggal
// penginputan, jadi tanggal kedatangan aslinya perlu dicari dari transaksi
// MASUK dengan kombinasi yang sama).
function getTanggalKedatanganKombinasi(entries, kodeBarang, supplier, pemilik, lokasi) {
  const tanggalMasuk = entries
    .filter(t => t.jenis === 'masuk' && t.kodeBarang === kodeBarang && t.supplier === supplier && t.pemilik === pemilik && t.lokasi === lokasi && t.tanggal)
    .map(t => t.tanggal)
    .sort();
  return tanggalMasuk.length > 0 ? tanggalMasuk[0] : null;
}

// Daftar semua kombinasi supplier+pemilik+lokasi (+ sisa stok, pallet, dan
// tanggal kedatangan) yang MASIH ADA STOKNYA untuk satu kode barang. Inilah
// "kesatuan" yang ditampilkan ke operator saat lapor barang KELUAR, supaya
// operator hanya bisa memilih kombinasi yang benar-benar tersedia — bukan
// mengetik bebas.
//
// tanggalKedatangan = tanggal transaksi MASUK paling awal untuk kombinasi
// ini. Dipakai supaya daftar bisa diurutkan FIFO (First In First Out) —
// stok yang datang paling lama ditampilkan paling atas, supaya operator
// memprioritaskan mengeluarkan barang lama dulu sebelum barang baru.
function getKombinasiTersedia(entries, kodeBarang) {
  const map = new Map();
  entries.filter(t => t.kodeBarang === kodeBarang).forEach(t => {
    const key = comboKey(t.kodeBarang, t.supplier, t.pemilik, t.lokasi);
    if (!map.has(key)) {
      map.set(key, { supplier: t.supplier, pemilik: t.pemilik, lokasi: t.lokasi, stok: 0, pallet: 0, tanggalKedatangan: null });
    }
    const c = map.get(key);
    const arah = t.jenis === 'masuk' ? 1 : -1;
    c.stok += arah * t.jumlah;
    if (t.jumlahPallet != null) c.pallet += arah * t.jumlahPallet;
    if (t.jenis === 'masuk' && t.tanggal && (!c.tanggalKedatangan || t.tanggal < c.tanggalKedatangan)) {
      c.tanggalKedatangan = t.tanggal;
    }
  });
  return [...map.values()].filter(c => c.stok > 0).sort((a, b) => {
    // Urutkan dari tanggal kedatangan PALING LAMA di atas (FIFO). Kombinasi
    // tanpa tanggal kedatangan (kasus langka/data lama) ditaruh di bawah.
    if (a.tanggalKedatangan && b.tanggalKedatangan && a.tanggalKedatangan !== b.tanggalKedatangan) {
      return a.tanggalKedatangan < b.tanggalKedatangan ? -1 : 1;
    }
    if (!!a.tanggalKedatangan !== !!b.tanggalKedatangan) return a.tanggalKedatangan ? -1 : 1;
    return b.stok - a.stok;
  });
}
const BULAN = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];

// Rincian batch kedatangan (FIFO) yang MASIH TERSISA untuk satu kombinasi
// kode+supplier+pemilik+lokasi. Dipakai supaya operator jelas "stok yang
// tersisa itu berasal dari kedatangan tanggal berapa saja" — karena satu
// kombinasi bisa menerima BEBERAPA kali kedatangan (tanggal beda-beda) yang
// kalau cuma dilihat total stoknya jadi tergabung jadi satu angka saja,
// tidak kelihatan asal-usulnya. Logika FIFO: batch yang datang paling awal
// dianggap paling dulu keluar, jadi total pcs yang sudah pernah keluar
// dikurangkan dari batch tertua dulu, baru lanjut ke batch berikutnya.
function getBatchBreakdownKombinasi(entries, kodeBarang, supplier, pemilik, lokasi) {
  const masukList = entries
    .filter(t => t.jenis === 'masuk' && t.kodeBarang === kodeBarang && t.supplier === supplier && t.pemilik === pemilik && t.lokasi === lokasi)
    .map(t => ({ tanggal: t.tanggal, qty: t.jumlah || 0 }))
    .sort((a, b) => (a.tanggal || '').localeCompare(b.tanggal || ''));

  let totalKeluar = entries
    .filter(t => t.jenis === 'keluar' && t.kodeBarang === kodeBarang && t.supplier === supplier && t.pemilik === pemilik && t.lokasi === lokasi)
    .reduce((s, t) => s + (t.jumlah || 0), 0);

  // Gabung batch dengan tanggal persis sama jadi satu baris, supaya tidak
  // ada baris duplikat kalau ada 2x input masuk di hari yang sama.
  const merged = [];
  masukList.forEach(b => {
    const last = merged[merged.length - 1];
    if (last && last.tanggal === b.tanggal) last.qty += b.qty;
    else merged.push({ tanggal: b.tanggal, qty: b.qty });
  });

  const breakdown = [];
  merged.forEach(b => {
    let sisa = b.qty;
    if (totalKeluar > 0) {
      const potong = Math.min(totalKeluar, sisa);
      sisa -= potong;
      totalKeluar -= potong;
    }
    if (sisa > 0) breakdown.push({ tanggal: b.tanggal, sisa });
  });
  return breakdown;
}

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

// Ubah string tanggal ISO ("YYYY-MM-DD") jadi objek Date lokal (bukan UTC)
// supaya ExcelJS bisa menaruhnya sebagai sel tanggal asli (bisa di-sort,
// diformat dd/mm/yyyy), bukan sekadar teks.
function isoToExcelDate(iso) {
  if (!iso) return null;
  const parts = iso.split('-');
  if (parts.length !== 3) return null;
  const [y, m, d] = parts.map(p => parseInt(p, 10));
  return new Date(y, m - 1, d);
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

// Cuma jam:menit saja (tanpa tanggal) — dipakai di kartu Riwayat Transaksi
// yang tanggalnya sudah ditampilkan terpisah lewat formatTanggal().
function formatJam(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

// Format angka jumlah/qty dengan pemisah ribuan ala Indonesia (mis. 12500
// -> "12.500") supaya tidak keliru dibaca sekilas. Dipakai di SEMUA tempat
// yang menampilkan jumlah pcs/pallet — kartu laporan, modal detail, jejak
// edit — biar konsisten dengan angka di Ringkasan/Dashboard yang sudah
// lebih dulu pakai format ini.
function fmtQty(n) {
  if (n == null || isNaN(n)) return '-';
  return Number(n).toLocaleString('id-ID');
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Helper kecil: set textContent elemen by id, aman kalau elemennya belum
// ada di DOM (mis. saat dipanggil dari panel yang sedang tidak aktif).
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
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
   KATALOG MANAGEMENT — ADMIN PANEL (BARANG, SUPPLIER, PEMILIK, LOKASI)
========================================================================== */

class KatalogManager {
  constructor() {
    this.barangEditing = null;
    this.supplierEditing = null;
    this.pemilikEditing = null;
    this.lokasiEditing = null;
    // Paginasi tabel Daftar Kode Barang (panel Pengelolaan Barang).
    this.barangPage = 1;
    this.barangPageSize = 10;
    // Paginasi untuk tabel sederhana (Supplier / Pemilik Barang / Lokasi) —
    // masing-masing entity punya state halaman & ukuran halaman sendiri.
    this.simplePage = { supplier: 1, pemilik: 1, lokasi: 1 };
    this.simplePageSize = { supplier: 10, pemilik: 10, lokasi: 10 };
  }

  init() {
    // Tab switching
    document.querySelectorAll('.katalog-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    // Barang
    document.getElementById('btn-tambah-barang')?.addEventListener('click', () => this.openBarangForm());
    document.getElementById('form-barang')?.addEventListener('submit', (e) => this.saveBarang(e));
    document.getElementById('search-barang')?.addEventListener('input', (e) => this.filterBarang(e.target.value));
    document.getElementById('barang-page-size')?.addEventListener('change', (e) => {
      this.barangPageSize = parseInt(e.target.value, 10) || 10;
      this.barangPage = 1;
      this.renderBarangList(document.getElementById('search-barang')?.value || '');
    });

    // Supplier
    document.getElementById('btn-tambah-supplier')?.addEventListener('click', () => this.openSupplierForm());
    document.getElementById('form-supplier')?.addEventListener('submit', (e) => this.saveSupplier(e));
    document.getElementById('search-supplier')?.addEventListener('input', (e) => this.filterSupplier(e.target.value));
    document.getElementById('supplier-page-size')?.addEventListener('change', (e) => {
      this.simplePageSize.supplier = parseInt(e.target.value, 10) || 10;
      this.simplePage.supplier = 1;
      this.renderSupplierList(document.getElementById('search-supplier')?.value || '');
    });

    // Pemilik
    document.getElementById('btn-tambah-pemilik')?.addEventListener('click', () => this.openPemilikForm());
    document.getElementById('form-pemilik')?.addEventListener('submit', (e) => this.savePemilik(e));
    document.getElementById('search-pemilik')?.addEventListener('input', (e) => this.filterPemilik(e.target.value));
    document.getElementById('pemilik-page-size')?.addEventListener('change', (e) => {
      this.simplePageSize.pemilik = parseInt(e.target.value, 10) || 10;
      this.simplePage.pemilik = 1;
      this.renderPemilikList(document.getElementById('search-pemilik')?.value || '');
    });

    // Lokasi
    document.getElementById('btn-tambah-lokasi')?.addEventListener('click', () => this.openLokasiForm());
    document.getElementById('form-lokasi')?.addEventListener('submit', (e) => this.saveLokasi(e));
    document.getElementById('search-lokasi')?.addEventListener('input', (e) => this.filterLokasi(e.target.value));
    document.getElementById('lokasi-page-size')?.addEventListener('change', (e) => {
      this.simplePageSize.lokasi = parseInt(e.target.value, 10) || 10;
      this.simplePage.lokasi = 1;
      this.renderLokasiList(document.getElementById('search-lokasi')?.value || '');
    });

    // Modal close buttons
    document.querySelectorAll('#form-barang-modal .modal-close, #form-barang-modal .modal-cancel').forEach(btn => {
      btn.addEventListener('click', () => this.closeBarangForm());
    });
    document.querySelectorAll('#form-supplier-modal .modal-close, #form-supplier-modal .modal-cancel').forEach(btn => {
      btn.addEventListener('click', () => this.closeSupplierForm());
    });
    document.querySelectorAll('#form-pemilik-modal .modal-close, #form-pemilik-modal .modal-cancel').forEach(btn => {
      btn.addEventListener('click', () => this.closePemilikForm());
    });
    document.querySelectorAll('#form-lokasi-modal .modal-close, #form-lokasi-modal .modal-cancel').forEach(btn => {
      btn.addEventListener('click', () => this.closeLokasiForm());
    });

    // Close modal on overlay click
    document.getElementById('form-barang-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'form-barang-modal') this.closeBarangForm();
    });
    document.getElementById('form-supplier-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'form-supplier-modal') this.closeSupplierForm();
    });
    document.getElementById('form-pemilik-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'form-pemilik-modal') this.closePemilikForm();
    });
    document.getElementById('form-lokasi-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'form-lokasi-modal') this.closeLokasiForm();
    });

    // Load and render all katalog data
    this.loadKatalog();
  }

  // ---- PENTING: subscription Firestore dipisah dari loadKatalog() ----
  // Sebelumnya, onSnapshot() ke barangBaruCol/pemilikBaruCol dipasang
  // LANGSUNG di dalam loadKatalog() (dipanggil dari init(), yang jalan di
  // TOP-LEVEL script.js lewat `katalogManager.init()` — SEBELUM user
  // login). firestore.rules mensyaratkan isAppUser() (auth != null DAN
  // ada dokumen profil operator/admin), jadi listener yang terpasang
  // sebelum login langsung kena "Missing or insufficient permissions" dan
  // gagal permanen (sama seperti bug yang sudah diperbaiki di
  // startAllOverlayListeners() — lihat catatan di sana). Sekarang 
  // subscribeToUpdates() ini HANYA dipanggil dari
  // initFirestoreConnection() -> startListening(), yaitu SETELAH user
  // benar-benar login.
  subscribeToUpdates() {
    startAllOverlayListeners();
    // After listeners are set up, render updated lists
    this.renderBarangList();
    this.renderSupplierList();
    this.renderPemilikList();
    this.renderLokasiList();
  }

  switchTab(tab) {
    document.querySelectorAll('.katalog-tab-btn').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.katalog-section').forEach(section => {
      section.hidden = section.id !== `katalog-${tab}`;
    });
  }

  // ========== BARANG ==========
  loadKatalog() {
    this.renderBarangList();
    this.renderSupplierList();
    this.renderPemilikList();
    this.renderLokasiList();
    // Subscription ke barangBaru/pemilikBaru DIPINDAH ke subscribeToUpdates()
    // di atas, dipanggil setelah login. Lihat catatan di subscribeToUpdates().
  }

  // Hitung stok semua barang dalam SATU PASS — efisien untuk 671+ item.
  // Mengembalikan Map { kodeBarang => totalStok }
  calculateAllBarangStok(entries = []) {
    const stokMap = new Map();
    if (!entries || !Array.isArray(entries)) return stokMap;
    entries.forEach(entry => {
      if (!entry || !entry.kodeBarang) return;
      const current = stokMap.get(entry.kodeBarang) || 0;
      const delta = entry.jenis === 'masuk' ? entry.jumlah : -entry.jumlah;
      stokMap.set(entry.kodeBarang, current + delta);
    });
    return stokMap;
  }

  renderBarangList(filter = '') {
    const tbody = document.getElementById('barang-list');
    const empty = document.getElementById('barang-empty');
    const countLabel = document.getElementById('barang-total-label');
    const tableWrap = document.getElementById('barang-table-wrap');
    const pagination = document.getElementById('barang-pagination');
    if (!tbody) return;

    const allBarang = [...BARANG_OPTIONS];
    const q = filter.trim().toLowerCase();

    // Urutkan alfabetis berdasarkan nama barang.
    let barang = allBarang.sort((a, b) => (a.nama || '').localeCompare(b.nama || ''));

    // Jika ada search query, filter daftar (tapi JANGAN sembunyikan semuanya)
    // — search adalah filter, bukan syarat wajib.
    let displayBarang = barang;
    const totalMatches = barang.length;
    if (q) {
      displayBarang = barang.filter(b =>
        (b.kode || '').toLowerCase().includes(q) ||
        (b.nama || '').toLowerCase().includes(q)
      );
    }

    if (countLabel) {
      countLabel.textContent = q
        ? `${displayBarang.length} dari ${totalMatches} barang cocok`
        : `${totalMatches} barang total`;
    }

    if (displayBarang.length === 0) {
      tbody.innerHTML = '';
      empty.hidden = false;
      if (tableWrap) tableWrap.hidden = true;
      if (pagination) pagination.hidden = true;
      return;
    }
    empty.hidden = true;
    if (tableWrap) tableWrap.hidden = false;
    if (pagination) pagination.hidden = false;

    // Paginasi.
    const pageSize = this.barangPageSize || 10;
    const totalPages = Math.max(1, Math.ceil(displayBarang.length / pageSize));
    if (this.barangPage > totalPages) this.barangPage = totalPages;
    if (this.barangPage < 1) this.barangPage = 1;
    const startIdx = (this.barangPage - 1) * pageSize;
    const pageItems = displayBarang.slice(startIdx, startIdx + pageSize);

    tbody.innerHTML = pageItems.map((b, i) => {
      return `
        <tr>
          <td class="katalog-td-no">${startIdx + i + 1}</td>
          <td class="katalog-td-kode">${escapeHtml(b.kode || '-')}</td>
          <td title="${escapeHtml(b.nama || '-')}">${escapeHtml(b.nama || '-')}</td>
          <td class="katalog-td-edit">
            <button type="button" class="btn-katalog-edit" data-action="edit-barang" data-kode="${escapeHtml(b.kode || '')}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z"/></svg>
              Edit
            </button>
          </td>
          <td class="katalog-td-hapus">
            <button type="button" class="btn-katalog-delete" data-action="delete-barang" data-kode="${escapeHtml(b.kode || '')}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
              Hapus
            </button>
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('[data-action="edit-barang"]').forEach(btn => {
      btn.addEventListener('click', () => this.editBarang(btn.dataset.kode));
    });
    tbody.querySelectorAll('[data-action="delete-barang"]').forEach(btn => {
      btn.addEventListener('click', () => this.deleteBarang(btn.dataset.kode));
    });

    this.renderBarangPagination(totalPages);
  }

  // Bangun daftar nomor halaman dengan elipsis ("...") untuk total halaman
  // yang banyak, mis. [1, '...', 5, 6, 7, '...', 68].
  buildPageList(current, total) {
    const pages = [];
    if (total <= 7) {
      for (let i = 1; i <= total; i++) pages.push(i);
      return pages;
    }
    pages.push(1);
    if (current > 3) pages.push('...');
    const start = Math.max(2, current - 1);
    const end = Math.min(total - 1, current + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    if (current < total - 2) pages.push('...');
    pages.push(total);
    return pages;
  }

  renderBarangPagination(totalPages) {
    const wrap = document.getElementById('barang-pagination-pages');
    if (!wrap) return;
    const page = this.barangPage;
    const pages = this.buildPageList(page, totalPages);

    wrap.innerHTML = `
      <button type="button" class="katalog-page-btn katalog-page-nav" data-page="prev" ${page <= 1 ? 'disabled' : ''} aria-label="Halaman sebelumnya">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m15 18-6-6 6-6"/></svg>
      </button>
      ${pages.map(p => p === '...'
        ? `<span class="katalog-page-ellipsis">…</span>`
        : `<button type="button" class="katalog-page-btn ${p === page ? 'is-active' : ''}" data-page="${p}">${p}</button>`
      ).join('')}
      <button type="button" class="katalog-page-btn katalog-page-nav" data-page="next" ${page >= totalPages ? 'disabled' : ''} aria-label="Halaman berikutnya">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m9 18 6-6-6-6"/></svg>
      </button>
    `;

    wrap.querySelectorAll('[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.dataset.page;
        if (val === 'prev') this.barangPage = Math.max(1, this.barangPage - 1);
        else if (val === 'next') this.barangPage = Math.min(totalPages, this.barangPage + 1);
        else this.barangPage = parseInt(val, 10);
        this.renderBarangList(document.getElementById('search-barang')?.value || '');
      });
    });
  }

  filterBarang(value) {
    this.barangPage = 1;
    this.renderBarangList(value);
  }

  openBarangForm(kode = null) {
    const modal = document.getElementById('form-barang-modal');
    const form = document.getElementById('form-barang');
    const title = document.getElementById('form-barang-title');
    const input_kode = document.getElementById('form-barang-kode');
    const input_nama = document.getElementById('form-barang-nama');
    const errorBox = document.getElementById('form-barang-error');

    this.barangEditing = kode;
    if (kode) {
      const barang = (MASTER_DATA.barang || []).find(b => b.kode === kode);
      if (barang) {
        title.textContent = 'Edit Kode Barang';
        input_kode.value = barang.kode || '';
        input_nama.value = barang.nama || '';
        input_kode.disabled = true;
      }
    } else {
      title.textContent = 'Tambah Kode Barang';
      form.reset();
      input_kode.disabled = false;
    }
    errorBox.hidden = true;
    modal.hidden = false;
    input_nama.focus();
  }

  closeBarangForm() {
    document.getElementById('form-barang-modal').hidden = true;
    this.barangEditing = null;
  }

  async saveBarang(e) {
    e.preventDefault();
    const kode = document.getElementById('form-barang-kode').value.trim();
    const nama = document.getElementById('form-barang-nama').value.trim();
    const errorBox = document.getElementById('form-barang-error');

    if (!kode || !nama) {
      errorBox.textContent = 'Kode dan nama barang harus diisi.';
      errorBox.hidden = false;
      return;
    }

    try {
      const fb = await waitForFirebase();
      const session = getSession();
      const docId = kode;
      
      // Check if kode already exists in base data (can't add duplicate)
      const baseExists = (MASTER_DATA.barang || []).some(b => b.kode === kode);
      if (!baseExists && !this.barangEditing) {
        // Adding new — check if already in overlay
        const overlayExists = barangOverlay.has(kode);
        if (overlayExists) {
          errorBox.textContent = 'Kode barang sudah ada!';
          errorBox.hidden = false;
          return;
        }
      }

      if (this.barangEditing) {
        // Edit — update overlay doc
        await upsertOverlayDoc('barangBaru', docId, {
          kode,
          nama,
          ditambahOleh: session ? session.nama : '-',
          deleted: false
        });
      } else {
        // Add new — create overlay doc
        await upsertOverlayDoc('barangBaru', docId, {
          kode,
          nama,
          ditambahOleh: session ? session.nama : '-',
          createdAt: Date.now(),
          deleted: false
        });
        this.barangPage = 1;
      }

      // Optimistic update lokal: begitu tulisan ke Firestore SUKSES, langsung
      // perbarui barangOverlay + render ulang tabel DI SINI juga — jangan
      // cuma mengandalkan listener onSnapshot(barangBaruCol) di
      // startAllOverlayListeners() yang datang belakangan. onSnapshot tetap
      // jalan seperti biasa dan akan menimpa dengan data server begitu tiba
      // (idempotent, tidak masalah dobel render), tapi user tidak lagi
      // menunggu bolak-balik ke server dulu sebelum tabel berubah.
      barangOverlay.set(docId, { kode, nama, deleted: false });
      rebuildBarangOptions();

      showToast('Barang berhasil disimpan');
      this.closeBarangForm();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }
  }

  editBarang(kode) {
    this.openBarangForm(kode);
  }

  async deleteBarang(kode) {
    if (!await showConfirmModal({ title: 'Hapus Kode Barang', message: `Hapus kode barang "${kode}"? Tindakan ini tidak dapat dibatalkan.` })) return;
    try {
      const fb = await waitForFirebase();
      const existing = barangOverlay.get(kode) || {};

      // Soft-delete: set deleted:true in overlay
      await upsertOverlayDoc('barangBaru', kode, {
        kode,
        nama: existing.nama || kode,
        ditambahOleh: existing.ditambahOleh || '-',
        deleted: true
      });

      // Optimistic update lokal — sama alasannya seperti di saveBarang():
      // begitu Firestore konfirmasi tulisan sukses, langsung tandai
      // deleted:true di Map lokal & render ulang tabel di sini juga,
      // supaya baris yang baru dihapus langsung hilang dari layar tanpa
      // menunggu giliran listener onSnapshot(barangBaruCol) menyala lagi.
      barangOverlay.set(kode, {
        kode,
        nama: existing.nama || kode,
        ditambahOleh: existing.ditambahOleh || '-',
        deleted: true,
      });
      rebuildBarangOptions();

      showToast('Kode barang berhasil dihapus');
    } catch (err) {
      showToast('Gagal menghapus barang: ' + err.message, 'error');
    }
  }

  // ========== SUPPLIER / PEMILIK / LOKASI (tabel sederhana No. + Nama + Aksi) ==========
  // Keempat entity ini modelnya sama (kombinasi base + overlay Firestore),
  // jadi dipakaikan satu fungsi generik supaya tidak triplikasi kode.
  renderSimpleList(entity, filter = '') {
    const tbody = document.getElementById(`${entity}-list`);
    const empty = document.getElementById(`${entity}-empty`);
    const tableWrap = document.getElementById(`${entity}-table-wrap`);
    const pagination = document.getElementById(`${entity}-pagination`);
    if (!tbody) return;

    let items = entity === 'supplier' ? SUPPLIER_OPTIONS :
                entity === 'pemilik' ? PEMILIK_OPTIONS_MERGED :
                entity === 'lokasi' ? LOKASI_OPTIONS : [];
    items = [...items];
    const q = filter.trim().toLowerCase();
    if (q) {
      items = items.filter(x => (x || '').toLowerCase().includes(q));
    }

    if (items.length === 0) {
      tbody.innerHTML = '';
      if (empty) empty.hidden = false;
      if (tableWrap) tableWrap.hidden = true;
      if (pagination) pagination.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;
    if (tableWrap) tableWrap.hidden = false;
    if (pagination) pagination.hidden = false;

    const pageSize = this.simplePageSize[entity] || 10;
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    if (this.simplePage[entity] > totalPages) this.simplePage[entity] = totalPages;
    if (this.simplePage[entity] < 1) this.simplePage[entity] = 1;
    const page = this.simplePage[entity];
    const startIdx = (page - 1) * pageSize;
    const pageItems = items.slice(startIdx, startIdx + pageSize);

    tbody.innerHTML = pageItems.map((val, i) => `
      <tr>
        <td class="katalog-td-no">${startIdx + i + 1}</td>
        <td>${escapeHtml(val || '-')}</td>
        <td class="katalog-td-edit">
          <button type="button" class="btn-katalog-edit" data-action="edit-${entity}" data-nama="${escapeHtml(val || '')}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z"/></svg>
            Edit
          </button>
        </td>
        <td class="katalog-td-hapus">
          <button type="button" class="btn-katalog-delete" data-action="delete-${entity}" data-nama="${escapeHtml(val || '')}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
            Hapus
          </button>
        </td>
      </tr>
    `).join('');

    const cap = entity.charAt(0).toUpperCase() + entity.slice(1);
    tbody.querySelectorAll(`[data-action="edit-${entity}"]`).forEach(btn => {
      btn.addEventListener('click', () => this[`edit${cap}`](btn.dataset.nama));
    });
    tbody.querySelectorAll(`[data-action="delete-${entity}"]`).forEach(btn => {
      btn.addEventListener('click', () => this[`delete${cap}`](btn.dataset.nama));
    });

    this.renderSimplePagination(entity, totalPages);
  }

  renderSimplePagination(entity, totalPages) {
    const wrap = document.getElementById(`${entity}-pagination-pages`);
    if (!wrap) return;
    const page = this.simplePage[entity];
    const pages = this.buildPageList(page, totalPages);

    wrap.innerHTML = `
      <button type="button" class="katalog-page-btn katalog-page-nav" data-page="prev" ${page <= 1 ? 'disabled' : ''} aria-label="Halaman sebelumnya">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m15 18-6-6 6-6"/></svg>
      </button>
      ${pages.map(p => p === '...'
        ? `<span class="katalog-page-ellipsis">…</span>`
        : `<button type="button" class="katalog-page-btn ${p === page ? 'is-active' : ''}" data-page="${p}">${p}</button>`
      ).join('')}
      <button type="button" class="katalog-page-btn katalog-page-nav" data-page="next" ${page >= totalPages ? 'disabled' : ''} aria-label="Halaman berikutnya">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m9 18 6-6-6-6"/></svg>
      </button>
    `;

    wrap.querySelectorAll('[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.dataset.page;
        if (val === 'prev') this.simplePage[entity] = Math.max(1, this.simplePage[entity] - 1);
        else if (val === 'next') this.simplePage[entity] = Math.min(totalPages, this.simplePage[entity] + 1);
        else this.simplePage[entity] = parseInt(val, 10);
        const searchVal = document.getElementById(`search-${entity}`)?.value || '';
        this.renderSimpleList(entity, searchVal);
      });
    });
  }

  // ========== SUPPLIER ==========
  renderSupplierList(filter = '') {
    this.renderSimpleList('supplier', filter);
  }

  filterSupplier(value) {
    this.simplePage.supplier = 1;
    this.renderSupplierList(value);
  }

  openSupplierForm(nama = null) {
    const modal = document.getElementById('form-supplier-modal');
    const form = document.getElementById('form-supplier');
    const title = document.getElementById('form-supplier-title');
    const input_nama = document.getElementById('form-supplier-nama');
    const errorBox = document.getElementById('form-supplier-error');

    this.supplierEditing = nama;
    if (nama) {
      title.textContent = 'Edit Supplier';
      input_nama.value = nama;
    } else {
      title.textContent = 'Tambah Supplier';
      form.reset();
    }
    errorBox.hidden = true;
    modal.hidden = false;
    input_nama.focus();
  }

  closeSupplierForm() {
    document.getElementById('form-supplier-modal').hidden = true;
    this.supplierEditing = null;
  }

  async saveSupplier(e) {
    e.preventDefault();
    const nama = document.getElementById('form-supplier-nama').value.trim();
    const errorBox = document.getElementById('form-supplier-error');

    if (!nama) {
      errorBox.textContent = 'Nama supplier harus diisi.';
      errorBox.hidden = false;
      return;
    }

    try {
      const fb = await waitForFirebase();
      const session = getSession();
      const docId = sanitizeMasterId(nama);
      
      // Check if already exists in base or overlay (active)
      const baseExists = (MASTER_DATA.supplier || []).some(s => String(s).toLowerCase() === nama.toLowerCase());
      const overlayActive = customSupplier.some(s => String(s).toLowerCase() === nama.toLowerCase());
      
      if (!this.supplierEditing && (baseExists || overlayActive)) {
        errorBox.textContent = 'Supplier sudah ada!';
        errorBox.hidden = false;
        return;
      }

      if (this.supplierEditing) {
        // Edit: soft-delete old, create/update new
        const oldId = sanitizeMasterId(this.supplierEditing);
        await upsertOverlayDoc('supplierBaru', oldId, {
          nama: this.supplierEditing,
          ditambahOleh: '-',
          deleted: true
        });
        // Optimistic update lokal untuk nama LAMA (lihat catatan di
        // deleteSupplier() / saveBarang() soal kenapa ini perlu).
        supplierOverlay.set(oldId, { nama: this.supplierEditing, deleted: true });
        customSupplier = customSupplier.filter(s => sanitizeMasterId(s) !== oldId);
      }

      // Add/update new supplier
      await upsertOverlayDoc('supplierBaru', docId, {
        nama,
        ditambahOleh: session ? session.nama : '-',
        createdAt: Date.now(),
        deleted: false
      });

      // Optimistic update lokal untuk nama BARU — langsung perbarui Map +
      // render ulang tabel di sini, jangan tunggu onSnapshot(supplierBaruCol).
      supplierOverlay.set(docId, { nama, deleted: false });
      if (!customSupplier.some(s => sanitizeMasterId(s) === docId)) customSupplier.push(nama);
      rebuildSupplierOptions();

      showToast('Supplier berhasil disimpan');
      this.closeSupplierForm();
      if (!this.supplierEditing) this.simplePage.supplier = 1;
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }
  }

  editSupplier(nama) {
    this.openSupplierForm(nama);
  }

  async deleteSupplier(nama) {
    if (!await showConfirmModal({ title: 'Hapus Supplier', message: `Hapus supplier "${nama}"? Tindakan ini tidak dapat dibatalkan.` })) return;
    try {
      const fb = await waitForFirebase();
      const docId = sanitizeMasterId(nama);
      
      // Soft-delete: set deleted:true in overlay
      await upsertOverlayDoc('supplierBaru', docId, {
        nama,
        ditambahOleh: '-',
        deleted: true
      });

      // Optimistic update lokal — lihat catatan di deleteBarang().
      supplierOverlay.set(docId, { nama, deleted: true });
      customSupplier = customSupplier.filter(s => sanitizeMasterId(s) !== docId);
      rebuildSupplierOptions();

      showToast('Supplier berhasil dihapus');
    } catch (err) {
      showToast('Gagal menghapus supplier: ' + err.message, 'error');
    }
  }

  // ========== PEMILIK ==========
  renderPemilikList(filter = '') {
    this.renderSimpleList('pemilik', filter);
  }

  filterPemilik(value) {
    this.simplePage.pemilik = 1;
    this.renderPemilikList(value);
  }

  openPemilikForm(nama = null) {
    const modal = document.getElementById('form-pemilik-modal');
    const form = document.getElementById('form-pemilik');
    const title = document.getElementById('form-pemilik-title');
    const input_nama = document.getElementById('form-pemilik-nama');
    const errorBox = document.getElementById('form-pemilik-error');

    this.pemilikEditing = nama;
    if (nama) {
      title.textContent = 'Edit Pemilik Barang';
      input_nama.value = nama;
    } else {
      title.textContent = 'Tambah Pemilik Barang';
      form.reset();
    }
    errorBox.hidden = true;
    modal.hidden = false;
    input_nama.focus();
  }

  closePemilikForm() {
    document.getElementById('form-pemilik-modal').hidden = true;
    this.pemilikEditing = null;
  }

  async savePemilik(e) {
    e.preventDefault();
    const nama = document.getElementById('form-pemilik-nama').value.trim();
    const errorBox = document.getElementById('form-pemilik-error');

    if (!nama) {
      errorBox.textContent = 'Nama pemilik harus diisi.';
      errorBox.hidden = false;
      return;
    }

    try {
      const fb = await waitForFirebase();
      const session = getSession();
      const docId = sanitizeMasterId(nama);
      
      // Check if already exists in base or overlay (active)
      const baseExists = (MASTER_DATA.pemilik || []).some(p => String(p).toLowerCase() === nama.toLowerCase());
      const overlayActive = customPemilik.some(p => String(p).toLowerCase() === nama.toLowerCase());
      
      if (!this.pemilikEditing && (baseExists || overlayActive)) {
        errorBox.textContent = 'Pemilik sudah ada!';
        errorBox.hidden = false;
        return;
      }

      if (this.pemilikEditing) {
        // Edit: soft-delete old, create/update new
        const oldId = sanitizeMasterId(this.pemilikEditing);
        await upsertOverlayDoc('pemilikBaru', oldId, {
          nama: this.pemilikEditing,
          ditambahOleh: '-',
          deleted: true
        });
        // Optimistic update lokal untuk nama LAMA.
        pemilikOverlay.set(oldId, { nama: this.pemilikEditing, deleted: true });
        customPemilik = customPemilik.filter(p => sanitizeMasterId(p) !== oldId);
      }

      // Add/update new pemilik
      await upsertOverlayDoc('pemilikBaru', docId, {
        nama,
        ditambahOleh: session ? session.nama : '-',
        createdAt: Date.now(),
        deleted: false
      });

      // Optimistic update lokal untuk nama BARU.
      pemilikOverlay.set(docId, { nama, deleted: false });
      if (!customPemilik.some(p => sanitizeMasterId(p) === docId)) customPemilik.push(nama);
      rebuildPemilikOptions();

      showToast('Pemilik berhasil disimpan');
      this.closePemilikForm();
      if (!this.pemilikEditing) this.simplePage.pemilik = 1;
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }
  }

  editPemilik(nama) {
    this.openPemilikForm(nama);
  }

  async deletePemilik(nama) {
    if (!await showConfirmModal({ title: 'Hapus Pemilik', message: `Hapus pemilik "${nama}"? Tindakan ini tidak dapat dibatalkan.` })) return;
    try {
      const fb = await waitForFirebase();
      const docId = sanitizeMasterId(nama);
      
      // Soft-delete: set deleted:true in overlay
      await upsertOverlayDoc('pemilikBaru', docId, {
        nama,
        ditambahOleh: '-',
        deleted: true
      });

      // Optimistic update lokal — lihat catatan di deleteBarang().
      pemilikOverlay.set(docId, { nama, deleted: true });
      customPemilik = customPemilik.filter(p => sanitizeMasterId(p) !== docId);
      rebuildPemilikOptions();

      showToast('Pemilik berhasil dihapus');
    } catch (err) {
      showToast('Gagal menghapus pemilik: ' + err.message, 'error');
    }
  }

  // ========== LOKASI ==========
  renderLokasiList(filter = '') {
    this.renderSimpleList('lokasi', filter);
  }

  filterLokasi(value) {
    this.simplePage.lokasi = 1;
    this.renderLokasiList(value);
  }

  openLokasiForm(nama = null) {
    const modal = document.getElementById('form-lokasi-modal');
    const form = document.getElementById('form-lokasi');
    const title = document.getElementById('form-lokasi-title');
    const input_nama = document.getElementById('form-lokasi-nama');
    const errorBox = document.getElementById('form-lokasi-error');

    this.lokasiEditing = nama;
    if (nama) {
      title.textContent = 'Edit Lokasi';
      input_nama.value = nama;
    } else {
      title.textContent = 'Tambah Lokasi';
      form.reset();
    }
    errorBox.hidden = true;
    modal.hidden = false;
    input_nama.focus();
  }

  closeLokasiForm() {
    document.getElementById('form-lokasi-modal').hidden = true;
    this.lokasiEditing = null;
  }

  async saveLokasi(e) {
    e.preventDefault();
    const nama = document.getElementById('form-lokasi-nama').value.trim();
    const errorBox = document.getElementById('form-lokasi-error');

    if (!nama) {
      errorBox.textContent = 'Nama lokasi harus diisi.';
      errorBox.hidden = false;
      return;
    }

    try {
      const fb = await waitForFirebase();
      const session = getSession();
      const docId = sanitizeMasterId(nama);
      
      // Check if already exists in base or overlay (active)
      const baseExists = (MASTER_DATA.lokasi || []).some(l => String(l).toLowerCase() === nama.toLowerCase());
      const overlayActive = customLokasi.some(l => String(l).toLowerCase() === nama.toLowerCase());
      
      if (!this.lokasiEditing && (baseExists || overlayActive)) {
        errorBox.textContent = 'Lokasi sudah ada!';
        errorBox.hidden = false;
        return;
      }

      if (this.lokasiEditing) {
        // Edit: soft-delete old, create/update new
        const oldId = sanitizeMasterId(this.lokasiEditing);
        await upsertOverlayDoc('lokasiBaru', oldId, {
          nama: this.lokasiEditing,
          ditambahOleh: '-',
          deleted: true
        });
        // Optimistic update lokal untuk nama LAMA.
        lokasiOverlay.set(oldId, { nama: this.lokasiEditing, deleted: true });
        customLokasi = customLokasi.filter(l => sanitizeMasterId(l) !== oldId);
      }

      // Add/update new lokasi
      await upsertOverlayDoc('lokasiBaru', docId, {
        nama,
        ditambahOleh: session ? session.nama : '-',
        createdAt: Date.now(),
        deleted: false
      });

      // Optimistic update lokal untuk nama BARU.
      lokasiOverlay.set(docId, { nama, deleted: false });
      if (!customLokasi.some(l => sanitizeMasterId(l) === docId)) customLokasi.push(nama);
      rebuildLokasiOptions();

      showToast('Lokasi berhasil disimpan');
      this.closeLokasiForm();
      if (!this.lokasiEditing) this.simplePage.lokasi = 1;
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }
  }

  editLokasi(nama) {
    this.openLokasiForm(nama);
  }

  async deleteLokasi(nama) {
    if (!await showConfirmModal({ title: 'Hapus Lokasi', message: `Hapus lokasi "${nama}"? Tindakan ini tidak dapat dibatalkan.` })) return;
    try {
      const fb = await waitForFirebase();
      const docId = sanitizeMasterId(nama);
      
      // Soft-delete: set deleted:true in overlay
      await upsertOverlayDoc('lokasiBaru', docId, {
        nama,
        ditambahOleh: '-',
        deleted: true
      });

      // Optimistic update lokal — lihat catatan di deleteBarang().
      lokasiOverlay.set(docId, { nama, deleted: true });
      customLokasi = customLokasi.filter(l => sanitizeMasterId(l) !== docId);
      rebuildLokasiOptions();

      showToast('Lokasi berhasil dihapus');
    } catch (err) {
      showToast('Gagal menghapus lokasi: ' + err.message, 'error');
    }
  }
}

const katalogManager = new KatalogManager();
katalogManager.init();

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
const headerAvatar = document.getElementById('header-avatar');
const tabOperator = document.getElementById('tab-operator');
const tabAdmin = document.getElementById('tab-admin');

/* ==========================================================================
   MODE GELAP — tema tersimpan di localStorage supaya diingat lain kali
   dibuka. Diterapkan sedini mungkin lewat inline script di <head> (biar
   tidak kedip), tombol di header cuma toggle + simpan ulang preferensinya.
========================================================================== */
const btnThemeToggle = document.getElementById('btn-theme-toggle');
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('gudang-theme', theme); } catch (e) {}
}
if (btnThemeToggle) {
  btnThemeToggle.addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    applyTheme(isDark ? 'light' : 'dark');
  });
}

/* ==========================================================================
   PWA — supaya bisa "diinstall" ke home screen HP dan tetap bisa dibuka
   (tampilannya) walau sinyal internet lagi lemah. Service worker cuma
   nge-cache TAMPILAN (HTML/CSS/JS), bukan data laporan — data laporan
   tetap butuh koneksi ke Firestore seperti biasa.
========================================================================== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });

  // Begitu service worker versi baru selesai aktif, dia mengirim pesan
  // 'gudang-sw-updated' ke semua tab yang terbuka. Kita tangkap di sini
  // dan tampilkan banner "Versi baru tersedia" supaya tab yang sudah
  // lama terbuka tidak terus-terusan menjalankan JS versi lama.
  let swUpdateBannerShown = false;
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'gudang-sw-updated' && !swUpdateBannerShown) {
      swUpdateBannerShown = true;
      showSwUpdateBanner();
    }
  });

  function showSwUpdateBanner() {
    const bar = document.createElement('div');
    bar.textContent = 'Versi baru tersedia. ';
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;' +
      'background:#0F2038;color:#fff;font-family:Inter,sans-serif;font-size:14px;' +
      'padding:12px 16px;display:flex;align-items:center;justify-content:center;gap:12px;' +
      'box-shadow:0 -2px 12px rgba(0,0,0,.25);';

    const btn = document.createElement('button');
    btn.textContent = 'Muat Ulang';
    btn.style.cssText = 'background:#F2ECDC;color:#0F2038;border:none;border-radius:6px;' +
      'padding:6px 14px;font-weight:700;font-size:13px;cursor:pointer;';
    btn.onclick = () => window.location.reload();

    bar.appendChild(btn);
    document.body.appendChild(bar);
  }
}

/* ==========================================================================
   DETEKSI TAB GANDA — firebase-config.js memakai persistentSingleTabManager,
   yang hanya mengizinkan SATU tab memegang akses persistensi offline
   (IndexedDB). Kalau aplikasi ini dibuka di lebih dari satu tab/jendela
   sekaligus, tab kedua otomatis fallback ke cache memori biasa (ini NORMAL,
   bukan bug — muncul di console sebagai "Falling back to memory cache").
   Supaya operator tidak bingung dan tidak salah input dobel di dua tab
   berbeda, kita kasih tahu lewat BroadcastChannel: setiap tab yang terbuka
   saling "say hi", dan kalau ada balasan dari tab lain, tampilkan banner.
========================================================================== */
if ('BroadcastChannel' in window) {
  const tabChannel = new BroadcastChannel('gudang-log-tabs');
  let multiTabBannerShown = false;

  function showMultiTabBanner() {
    if (multiTabBannerShown) return;
    multiTabBannerShown = true;
    const bar = document.createElement('div');
    bar.textContent = 'Aplikasi ini terbuka di tab/jendela lain juga. Sebaiknya pakai satu tab saja supaya data tidak bentrok. ';
    bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99999;' +
      'background:#B45309;color:#fff;font-family:Inter,sans-serif;font-size:14px;' +
      'padding:12px 16px;display:flex;align-items:center;justify-content:center;gap:12px;' +
      'box-shadow:0 2px 12px rgba(0,0,0,.25);';

    const btn = document.createElement('button');
    btn.textContent = 'Mengerti';
    btn.style.cssText = 'background:#fff;color:#B45309;border:none;border-radius:6px;' +
      'padding:6px 14px;font-weight:700;font-size:13px;cursor:pointer;';
    btn.onclick = () => bar.remove();

    bar.appendChild(btn);
    document.body.appendChild(bar);
  }

  tabChannel.addEventListener('message', (event) => {
    if (event.data === 'ping') {
      tabChannel.postMessage('pong');
      showMultiTabBanner();
    } else if (event.data === 'pong') {
      showMultiTabBanner();
    }
  });

  tabChannel.postMessage('ping');
}

let deferredInstallPrompt = null;
const btnInstallApp = document.getElementById('btn-install-app');
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (btnInstallApp) btnInstallApp.hidden = false;
});
if (btnInstallApp) {
  btnInstallApp.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    btnInstallApp.hidden = true;
  });
}
window.addEventListener('appinstalled', () => {
  if (btnInstallApp) btnInstallApp.hidden = true;
});
const formLoginOperator = document.getElementById('form-login-operator');
const formLoginAdmin = document.getElementById('form-login-admin');
const loginOperatorNik = document.getElementById('login-operator-nik');
const loginAdminNik = document.getElementById('login-admin-nik');
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

// ---- Elemen form admin (Masuk / Daftar Baru) — pola sama seperti operator ----
const adminModeTabs = document.getElementById('admin-mode-tabs');
const tabAdminLogin = document.getElementById('tab-admin-login');
const tabAdminRegister = document.getElementById('tab-admin-register');
const formRegisterAdmin = document.getElementById('form-register-admin');
const registerAdminError = document.getElementById('register-admin-error');
const registerAdminNama = document.getElementById('register-admin-nama');
const registerAdminIdKaryawan = document.getElementById('register-admin-id-karyawan');
const registerAdminKodeAkses = document.getElementById('register-admin-kode-akses');
const registerAdminPassword = document.getElementById('register-admin-password');
const registerAdminPasswordConfirm = document.getElementById('register-admin-password-confirm');
const loginFormIntro = document.getElementById('login-form-intro');

// ---- Tombol "Lihat/Sembunyikan Kata Sandi" ----
// Satu handler generik untuk semua field password di layar login (login &
// daftar, operator & admin) — cukup cari tombol dengan atribut
// [data-toggle-password], lalu toggle type text/password pada <input>
// yang jadi tetangganya (sibling sebelumnya) di dalam .input-icon yang
// sama. Ini menghindari perlu menulis 8 event listener terpisah untuk
// tiap field satu-satu.
document.querySelectorAll('[data-toggle-password]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = btn.previousElementSibling;
    if (!input || input.tagName !== 'INPUT') return;
    const isVisible = input.type === 'text';
    input.type = isVisible ? 'password' : 'text';
    btn.classList.toggle('is-visible', !isVisible);
  });
});

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

// Sama seperti switchOperatorMode, tapi untuk tab Admin — admin sekarang
// juga bisa "Daftar Baru" sendiri, dengan Kode Akses Pendaftaran yang
// berbeda dari operator (divalidasi di server, lihat functions/index.js).
function switchAdminMode(mode) {
  tabAdminLogin.classList.toggle('is-active', mode === 'login');
  tabAdminRegister.classList.toggle('is-active', mode === 'register');
  formLoginAdmin.hidden = mode !== 'login';
  formRegisterAdmin.hidden = mode !== 'register';
  loginError.hidden = true;
  registerAdminError.hidden = true;
}
tabAdminLogin.addEventListener('click', () => switchAdminMode('login'));
tabAdminRegister.addEventListener('click', () => switchAdminMode('register'));

function switchLoginTab(role) {
  tabOperator.classList.toggle('is-active', role === 'operator');
  tabAdmin.classList.toggle('is-active', role === 'admin');
  if (loginFormIntro) {
    loginFormIntro.textContent = role === 'admin'
      ? 'Pilih untuk masuk atau daftar sebagai admin.'
      : 'Pilih untuk masuk atau daftar sebagai operator.';
  }

  if (role === 'operator') {
    operatorModeTabs.hidden = false;
    adminModeTabs.hidden = true;
    formLoginAdmin.hidden = true;
    formRegisterAdmin.hidden = true;
    switchOperatorMode('login');
  } else {
    operatorModeTabs.hidden = true;
    formLoginOperator.hidden = true;
    formRegisterOperator.hidden = true;
    adminModeTabs.hidden = false;
    switchAdminMode('login');
  }
}

tabOperator.addEventListener('click', () => switchLoginTab('operator'));
tabAdmin.addEventListener('click', () => switchLoginTab('admin'));

/* ==========================================================================
   AKUN OPERATOR & ADMIN — daftar & login lewat Firebase Authentication
   (bukan lagi menyimpan/membandingkan password hash sendiri di Firestore —
   lihat functions/index.js untuk alasan & detail perubahan ini)
========================================================================== */

function normalizeNamaKey(nama) {
  return String(nama || '').trim().toLowerCase();
}

function normalizeNikKey(nik) {
  return String(nik || '').trim();
}

// Firebase Auth butuh "email" untuk sign-in, jadi NIK diubah jadi email
// sintetis yang deterministik (tidak pernah dipakai kirim email
// sungguhan). Diberi awalan role supaya NIK yang sama tetap bisa dipakai
// terpisah sebagai operator maupun admin. HARUS PERSIS SAMA dengan
// nikToSyntheticEmail() di functions/index.js.
function nikToSyntheticEmail(role, nik) {
  return `${role}-${normalizeNikKey(nik).toLowerCase()}@akun.gudanglog.internal`;
}

// Pesan error Firebase Auth diseragamkan supaya tidak membocorkan apakah
// NIK terdaftar atau tidak (mencegah user enumeration) — sama seperti
// prinsip yang sudah dipakai aplikasi ini sebelumnya.
function loginErrorMessage(err) {
  const code = err && err.code;
  if (code === 'auth/invalid-credential' || code === 'auth/user-not-found' || code === 'auth/wrong-password') {
    return 'NIK atau kata sandi salah. Jika belum punya akun, daftar lewat tab "Daftar Baru".';
  }
  if (code === 'auth/too-many-requests') {
    return 'Terlalu banyak percobaan gagal. Coba lagi beberapa saat lagi.';
  }
  return 'Sistem belum siap atau koneksi bermasalah. Coba lagi sebentar.';
}

// Halaman login bisa tampil sebelum proses sign-in anonim ke Firebase
// selesai — bahkan sebelum firebase-config.js (dimuat sebagai <script
// type="module">, jadi dieksekusi belakangan dan butuh waktu fetch SDK
// dari internet) sempat membuat window.gudangFirebase sama sekali.
// Fungsi ini menunggu (polling tiap 50ms) sampai window.gudangFirebase
// ada, lalu menunggu Promise 'authReady'-nya — semua dalam satu batas
// waktu total (timeoutMs).
function waitForFirebaseAuth(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;

  function waitForGudangFirebase() {
    return new Promise((resolve, reject) => {
      (function check() {
        if (window.gudangFirebase && window.gudangFirebase.authReady) {
          resolve(window.gudangFirebase.authReady);
        } else if (Date.now() > deadline) {
          reject(new Error('timeout: firebase-config.js belum termuat'));
        } else {
          setTimeout(check, 50);
        }
      })();
    });
  }

  return waitForGudangFirebase().then((authReady) => {
    const sisaWaktu = Math.max(0, deadline - Date.now());
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), sisaWaktu)
    );
    return Promise.race([authReady, timeout]);
  });
}

// ---- Registrasi & login lewat Firebase Authentication (TANPA Cloud Functions) ----
// CATATAN ARSITEKTUR (dibaca dulu sebelum ubah-ubah bagian ini):
// Project ini sengaja TIDAK memakai plan Blaze, jadi Cloud Functions tidak
// bisa dipakai sama sekali. Konsekuensinya:
//
// 1. Kode akses pendaftaran TIDAK BISA divalidasi 100% rahasia lagi. Kita
//    taruh perbandingannya di dalam firestore.rules (server-side, tidak
//    dikirim ke browser seperti kalau ditaruh di script.js/data.js) lewat
//    trik dua-langkah "registrationGate": client menulis dulu ke koleksi
//    registrationGate/{uid} yang isinya kode yang diketik user — rule di
//    koleksi itu HANYA mengizinkan create kalau kode == konstanta rahasia
//    di dalam rules. Baru kalau itu sukses, client boleh menulis dokumen
//    profil ke operator/{uid} atau admin/{uid} (rule-nya mensyaratkan
//    exists(registrationGate/{uid})). Koleksi registrationGate sendiri
//    TIDAK BISA dibaca siapa pun (allow read: if false) jadi kode aksesnya
//    tidak pernah bocor lewat baca data — tapi ini tetap lebih lemah
//    dibanding Cloud Function murni, karena siapa pun yang punya akses ke
//    Firebase Console project ini (bukan pengunjung biasa) bisa melihat
//    rules-nya.
// 2. Role (operator/admin) TIDAK BISA lagi disimpan sebagai custom claim
//    (butuh Admin SDK). Sekarang role ditentukan dari KOLEKSI tempat
//    dokumen profilnya berada (operator/{uid} vs admin/{uid}), dan
//    firestore.rules mengecek exists(...) berdasarkan request.auth.uid.
//    ID dokumen profil sekarang UID Firebase Auth, BUKAN NIK lagi (NIK
//    cuma field biasa di dalam dokumen).
// 3. Firebase Auth client SDK cuma bisa menghapus akunnya SENDIRI, bukan
//    akun user lain — jadi "hapus akun operator" oleh admin sekarang cuma
//    menghapus dokumen profil Firestore-nya (soft-delete: operator itu
//    langsung kehilangan akses ke seluruh data karena exists() check
//    gagal, tapi akun Firebase Auth-nya sendiri tetap ada di sistem sampai
//    dibersihkan manual lewat Firebase Console kalau perlu).
async function registerViaClientSDK(role, { nama, idKaryawan, password, kodeAkses }) {
  const fb = window.gudangFirebase;
  const email = nikToSyntheticEmail(role, idKaryawan);
  const namaLower = String(nama || '').trim().toLowerCase();
  const nik = normalizeNikKey(idKaryawan);

  let cred;
  try {
    cred = await fb.createUserWithEmailAndPassword(fb.auth, email, password);
  } catch (err) {
    if (err && err.code === 'auth/email-already-in-use') {
      const e = new Error(
        role === 'admin' ? 'NIK ini sudah terdaftar sebagai admin.' : 'NIK ini sudah terdaftar.'
      );
      e.code = 'already-exists';
      throw e;
    }
    if (err && err.code === 'auth/weak-password') {
      const e = new Error('Kata sandi terlalu lemah, minimal 6 karakter.');
      e.code = 'invalid-argument';
      throw e;
    }
    throw err;
  }

  const uid = cred.user.uid;

  try {
    // Langkah 1: "buktikan" tahu kode akses lewat koleksi registrationGate.
    // Rule-nya yang menolak kalau kodeAkses salah — kalau ini gagal,
    // dilempar ke catch di bawah (rollback: hapus user Auth yang baru
    // dibuat supaya tidak nyangkut jadi akun "yatim").
    await fb.setDoc(fb.doc(fb.db, 'registrationGate', uid), {
      role,
      kodeAkses,
      createdAt: Date.now(),
    });

    // Langkah 2: tulis profil publik. Rule di operator/{uid} & admin/{uid}
    // mensyaratkan exists(registrationGate/{uid}) dari langkah 1 di atas.
    await fb.setDoc(fb.doc(fb.db, role, uid), {
      nama,
      namaLower,
      idKaryawan: nik,
      uid,
      role,
      createdAt: Date.now(),
    });
  } catch (err) {
    console.error('Gagal menulis profil, rollback akun Auth:', err);
    try { await fb.deleteUser(cred.user); } catch (e2) { console.warn('Rollback gagal:', e2); }
    if (err && err.code === 'permission-denied') {
      const e = new Error(
        role === 'admin' ? 'Kode Akses Pendaftaran Admin salah.' : 'Kode Akses Pendaftaran salah.'
      );
      e.code = 'permission-denied';
      throw e;
    }
    const e = new Error('Gagal mendaftar. Coba lagi.');
    e.code = 'internal';
    throw e;
  }

  // Registrasi client-side otomatis membuat sesi login — sign out lagi
  // supaya perilakunya konsisten dengan sebelumnya: user diarahkan balik
  // ke layar "Masuk" dan login manual dengan akun barunya.
  try { await fb.signOut(fb.auth); } catch (e3) { console.warn('Gagal sign-out setelah registrasi:', e3); }
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
function showRegisterAdminError(msg) {
  registerAdminError.hidden = false;
  registerAdminError.textContent = msg;
}
function hideRegisterAdminError() {
  registerAdminError.hidden = true;
  registerAdminError.textContent = '';
}
function showLoginAdminError(msg) {
  loginError.hidden = false;
  loginError.textContent = msg;
}
function hideLoginAdminError() {
  loginError.hidden = true;
  loginError.textContent = '';
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
  if (!password || password.length < 6) { showRegisterError('Kata sandi minimal 6 karakter.'); registerOperatorPassword.focus(); return; }
  if (password !== passwordConfirm) { showRegisterError('Konfirmasi kata sandi tidak cocok.'); registerOperatorPasswordConfirm.focus(); return; }

  const submitBtn = formRegisterOperator.querySelector('button[type="submit"]');
  const originalText = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'MENDAFTARKAN...';

  try {
    await waitForFirebaseAuth();

    // Kode akses divalidasi lewat firestore.rules (koleksi registrationGate),
    // bukan di client — lihat catatan panjang di registerViaClientSDK().
    try {
      await registerViaClientSDK('operator', { nama, idKaryawan, password, kodeAkses });
    } catch (regErr) {
      if (regErr.code === 'already-exists') {
        showRegisterError('NIK ini sudah terdaftar. Silakan masuk lewat tab "Masuk", atau hubungi admin gudang jika ini bukan Anda.');
        return;
      }
      if (regErr.code === 'permission-denied') {
        showRegisterError(regErr.message);
        registerOperatorKodeAkses.value = '';
        registerOperatorKodeAkses.focus();
        return;
      }
      if (regErr.code === 'invalid-argument') {
        showRegisterError(regErr.message);
        return;
      }
      throw regErr;
    }

    formRegisterOperator.reset();
    switchOperatorMode('login');
    loginOperatorNik.value = idKaryawan;
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

formRegisterAdmin.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideRegisterAdminError();

  const nama = registerAdminNama.value.trim();
  const idKaryawan = registerAdminIdKaryawan.value.trim();
  const kodeAkses = registerAdminKodeAkses.value.trim();
  const password = registerAdminPassword.value;
  const passwordConfirm = registerAdminPasswordConfirm.value;

  if (!nama) { showRegisterAdminError('Nama admin wajib diisi.'); registerAdminNama.focus(); return; }
  if (!idKaryawan) { showRegisterAdminError('ID Karyawan / NIK wajib diisi.'); registerAdminIdKaryawan.focus(); return; }
  if (!kodeAkses) { showRegisterAdminError('Kode Akses Pendaftaran Admin wajib diisi.'); registerAdminKodeAkses.focus(); return; }
  if (!password || password.length < 6) { showRegisterAdminError('Kata sandi minimal 6 karakter.'); registerAdminPassword.focus(); return; }
  if (password !== passwordConfirm) { showRegisterAdminError('Konfirmasi kata sandi tidak cocok.'); registerAdminPasswordConfirm.focus(); return; }

  const submitBtn = formRegisterAdmin.querySelector('button[type="submit"]');
  const originalText = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'MENDAFTARKAN...';

  try {
    await waitForFirebaseAuth();

    // Sama seperti registrasi operator: kode akses ADMIN divalidasi lewat
    // firestore.rules (registrationGate), bukan konstanta di script.js.
    try {
      await registerViaClientSDK('admin', { nama, idKaryawan, password, kodeAkses });
    } catch (regErr) {
      if (regErr.code === 'already-exists') {
        showRegisterAdminError('NIK ini sudah terdaftar sebagai admin. Silakan masuk lewat tab "Masuk".');
        return;
      }
      if (regErr.code === 'permission-denied') {
        showRegisterAdminError(regErr.message);
        registerAdminKodeAkses.value = '';
        registerAdminKodeAkses.focus();
        return;
      }
      if (regErr.code === 'invalid-argument') {
        showRegisterAdminError(regErr.message);
        return;
      }
      throw regErr;
    }

    formRegisterAdmin.reset();
    switchAdminMode('login');
    loginAdminNik.value = idKaryawan;
    loginAdminPassword.focus();
    showToast('Pendaftaran admin berhasil. Silakan masuk dengan akun yang baru dibuat.');
  } catch (err) {
    console.error('Gagal mendaftarkan admin:', err);
    showRegisterAdminError('Gagal mendaftar: sistem belum siap atau koneksi bermasalah. Coba lagi.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
});

formLoginOperator.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideLoginOperatorError();

  const nik = loginOperatorNik.value.trim();
  const password = loginOperatorPassword.value;

  if (!nik) { loginOperatorNik.focus(); return; }
  if (!password) { showLoginOperatorError('Kata sandi wajib diisi.'); loginOperatorPassword.focus(); return; }

  const submitBtn = formLoginOperator.querySelector('button[type="submit"]');
  const originalText = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'MEMERIKSA...';

  try {
    await waitForFirebaseAuth();
    const fb = window.gudangFirebase;

    // signInWithEmailAndPassword memverifikasi password lewat Firebase
    // Authentication sendiri — tidak ada lagi passwordHash yang dibaca
    // dari Firestore. Firebase Auth modern menyatukan "user tidak ada"
    // dan "password salah" jadi satu error code (auth/invalid-credential)
    // sehingga tidak membocorkan NIK mana yang terdaftar (user
    // enumeration) — cara ini otomatis mempertahankan prinsip yang sama
    // dengan pesan error seragam yang dipakai versi sebelumnya.
    const email = nikToSyntheticEmail('operator', nik);
    const cred = await fb.signInWithEmailAndPassword(fb.auth, email, password);

    // Tidak ada custom claim lagi (butuh Admin SDK) — profil & role
    // sekarang diambil langsung dari dokumen Firestore operator/{uid}.
    // Ini juga sekaligus fungsi sebagai pengecekan "akun masih aktif":
    // kalau admin sudah menghapus dokumen profil ini (soft-delete),
    // dokumennya tidak akan ketemu di sini walau login Firebase Auth-nya
    // sendiri masih berhasil — user tetap ditolak masuk.
    const profileSnap = await fb.getDoc(fb.doc(fb.db, 'operator', cred.user.uid));
    if (!profileSnap.exists()) {
      await fb.signOut(fb.auth);
      showLoginOperatorError('Akun ini sudah tidak aktif. Hubungi admin gudang.');
      return;
    }
    const nama = profileSnap.data().nama || cred.user.displayName || nik;

    setSession({ role: 'operator', nama });
    enterApp({ role: 'operator', nama });
  } catch (err) {
    console.error('Gagal login operator:', err);
    showLoginOperatorError(loginErrorMessage(err));
    loginOperatorPassword.value = '';
    loginOperatorPassword.focus();
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
});

formLoginAdmin.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideLoginAdminError();

  const nik = loginAdminNik.value.trim();
  const password = loginAdminPassword.value;

  if (!nik) { loginAdminNik.focus(); return; }
  if (!password) { showLoginAdminError('Kata sandi wajib diisi.'); loginAdminPassword.focus(); return; }

  const submitBtn = formLoginAdmin.querySelector('button[type="submit"]');
  const originalText = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'MEMERIKSA...';

  try {
    await waitForFirebaseAuth();
    const fb = window.gudangFirebase;

    const email = nikToSyntheticEmail('admin', nik);
    const cred = await fb.signInWithEmailAndPassword(fb.auth, email, password);

    const profileSnap = await fb.getDoc(fb.doc(fb.db, 'admin', cred.user.uid));
    if (!profileSnap.exists()) {
      await fb.signOut(fb.auth);
      showLoginAdminError('Akun ini sudah tidak aktif. Hubungi admin gudang lain.');
      return;
    }
    const nama = profileSnap.data().nama || cred.user.displayName || nik;

    setSession({ role: 'admin', nama });
    enterApp({ role: 'admin', nama });
  } catch (err) {
    console.error('Gagal login admin:', err);
    showLoginAdminError(loginErrorMessage(err));
    loginAdminPassword.value = '';
    loginAdminPassword.focus();
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
});

// Ambil inisial dari nama (maks 2 huruf) untuk ditampilkan di lingkaran

// avatar header, contoh: "Budi Santoso" -> "BS", "Admin" -> "AD".
function getInitials(nama) {
  if (!nama) return '-';
  const parts = nama.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function enterApp(session) {
  loginScreen.hidden = true;
  appScreen.hidden = false;
  document.body.classList.remove('role-operator', 'role-admin');
  document.body.classList.add(session.role === 'admin' ? 'role-admin' : 'role-operator');
  rolePill.textContent = session.role === 'admin' ? 'Admin' : 'Operator';
  rolePill.classList.toggle('is-admin', session.role === 'admin');
  userNameLabel.textContent = session.nama;
  if (headerAvatar) headerAvatar.textContent = getInitials(session.nama);

  if (session.role === 'operator') {
    inputOperator.value = session.nama;
    switchOperatorPanel('laporan');
  } else {
    switchAdminPanel('dashboard');
  }

  initFirestoreConnection();
}

document.getElementById('btn-logout').addEventListener('click', async () => {
  if (unsubscribeLaporan) unsubscribeLaporan();
  clearSession();
  // PENTING: harus sign-out dari Firebase Auth juga, bukan cuma menghapus
  // sessionStorage — kalau tidak, sesi Auth yang sesungguhnya (yang
  // memberi akses baca/tulis Firestore) tetap aktif walau tampilan sudah
  // kembali ke layar login.
  try {
    await window.gudangFirebase?.signOut(window.gudangFirebase.auth);
  } catch (err) {
    console.warn('Gagal sign-out dari Firebase Auth:', err);
  }
  window.location.reload();
});

/* ==========================================================================
   FIRESTORE CONNECTION & DATA MANAGEMENT
========================================================================== */
const RINGKASAN_SHEET = 'Ringkasan Stok';

let unsubscribeLaporan = null;
let unsubscribeBarangBaru = null;
let unsubscribePemilikBaru = null;
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

const MONTH_HEADERS = ['Tanggal Kedatangan', 'Tanggal Penginputan', 'Jenis', 'Tipe', 'Nama Operator', 'Kode Barang', 'Nama Barang', 'Supplier', 'Pemilik Barang', 'Lokasi', 'Jumlah (pcs)', 'Qty per Pallet (pcs)', 'Jumlah Pallet', 'Keterangan', 'Waktu Input', 'Waktu Diubah', 'ID'];
const MONTH_COL_WIDTHS = [16, 18, 9, 13, 18, 14, 34, 22, 14, 10, 12, 16, 12, 28, 22, 22, 14];
const STOK_HEADERS = ['Kode Barang', 'Nama Barang', 'Lokasi Terpakai', 'Total Masuk', 'Total Keluar', 'Stok Saat Ini', 'Tgl Terakhir Masuk', 'Jml Terakhir Masuk', 'Tgl Terakhir Keluar', 'Jml Terakhir Keluar', 'Terakhir Diperbarui'];
const STOK_COL_WIDTHS = [14, 34, 26, 12, 12, 12, 16, 14, 16, 14, 22];

/* ---- Tema warna untuk file Excel yang diunduh (disamakan dengan palet
   warna aplikasi: navy utk header, hijau/oranye/emas utk badge Jenis/Tipe) ---- */
const EXCEL_THEME = {
  navy: 'FF0F2038',
  navySoft: 'FF1B3457',
  navyPale: 'FFE7EBF1',
  white: 'FFFFFFFF',
  border: 'FFD3D8E0',
  hijau: 'FF276B44',
  hijauSoft: 'FFE4F1E8',
  oranye: 'FFA85417',
  oranyeSoft: 'FFFAEADA',
  emas: 'FFB9791F',
  emasSoft: 'FFFBF1DD',
  merah: 'FFD31A20',
  merahSoft: 'FFFBE7E6',
  abu: 'FF6B7280',
};

// Mengubah "YYYY-MM-DD" -> objek Date lokal (jam 00:00) tanpa terpengaruh
// pergeseran zona waktu, supaya kolom tanggal di Excel bisa diformat rapi
// sebagai tanggal asli (bukan teks) dan tetap bisa diurutkan/difilter.
function isoDateToLocalDate(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// Styling umum: header tebal berwarna, border tipis di semua sel terisi,
// baris selang-seling (zebra), freeze baris header, dan autofilter —
// dipakai di semua sheet yang diunduh supaya tampilannya konsisten & rapi.
function styleExcelSheet(ws, { headerRowNum = 1, lastCol, firstDataRow, lastDataRow }) {
  const headerRow = ws.getRow(headerRowNum);
  headerRow.height = 22;
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    if (colNumber > lastCol) return;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXCEL_THEME.navy } };
    cell.font = { bold: true, color: { argb: EXCEL_THEME.white }, size: 11 };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: EXCEL_THEME.navySoft } },
      bottom: { style: 'thin', color: { argb: EXCEL_THEME.navySoft } },
      left: { style: 'thin', color: { argb: EXCEL_THEME.navySoft } },
      right: { style: 'thin', color: { argb: EXCEL_THEME.navySoft } },
    };
  });
  for (let r = firstDataRow; r <= lastDataRow; r++) {
    const row = ws.getRow(r);
    const isEven = (r - firstDataRow) % 2 === 1;
    for (let c = 1; c <= lastCol; c++) {
      const cell = row.getCell(c);
      cell.border = {
        top: { style: 'thin', color: { argb: EXCEL_THEME.border } },
        bottom: { style: 'thin', color: { argb: EXCEL_THEME.border } },
        left: { style: 'thin', color: { argb: EXCEL_THEME.border } },
        right: { style: 'thin', color: { argb: EXCEL_THEME.border } },
      };
      if (!cell.fill && isEven) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXCEL_THEME.navyPale } };
    }
  }
  ws.views = [{ state: 'frozen', ySplit: headerRowNum, xSplit: 0 }];
  ws.autoFilter = { from: { row: headerRowNum, column: 1 }, to: { row: headerRowNum, column: lastCol } };
}

// Memberi warna badge (mirip tampilan di aplikasi) pada sel "Jenis"
// (MASUK/KELUAR) dan "Tipe" (PENYESUAIAN) di sheet bulanan.
function colorizeBadgeCell(cell, kind) {
  const map = {
    masuk: [EXCEL_THEME.hijauSoft, EXCEL_THEME.hijau],
    keluar: [EXCEL_THEME.oranyeSoft, EXCEL_THEME.oranye],
    penyesuaian: [EXCEL_THEME.emasSoft, EXCEL_THEME.emas],
  };
  const [bg, fg] = map[kind] || [null, null];
  if (!bg) return;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
  cell.font = { bold: true, color: { argb: fg }, size: 10.5 };
  cell.alignment = { vertical: 'middle', horizontal: 'center' };
}

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
        masuk: 0, keluar: 0, masukPallet: 0, keluarPallet: 0, lokasi: new Set(),
        supplierSet: new Set(), pemilikSet: new Set(),
        lastMasuk: null, lastKeluar: null, updated: 0,
        history: [],
      };
    }
    const item = map[key];
    item.history.push(t);
    if (t.lokasi) item.lokasi.add(t.lokasi);
    if (t.supplier) item.supplierSet.add(t.supplier);
    if (t.pemilik) item.pemilikSet.add(t.pemilik);
    if (t.jenis === 'masuk') {
      item.masuk += t.jumlah;
      if (t.jumlahPallet != null) item.masukPallet += t.jumlahPallet;
      if (!item.lastMasuk || t.createdAt > item.lastMasuk.at) {
        item.lastMasuk = { at: t.createdAt, tanggal: t.tanggal, jumlah: t.jumlah, lokasi: t.lokasi, supplier: t.supplier, pemilik: t.pemilik, qtyPerPallet: t.qtyPerPallet, jumlahPallet: t.jumlahPallet, operator: t.operator };
      }
    } else {
      item.keluar += t.jumlah;
      if (t.jumlahPallet != null) item.keluarPallet += t.jumlahPallet;
      if (!item.lastKeluar || t.createdAt > item.lastKeluar.at) {
        item.lastKeluar = { at: t.createdAt, tanggal: t.tanggal, jumlah: t.jumlah, lokasi: t.lokasi, pemilik: t.pemilik, qtyPerPallet: t.qtyPerPallet, jumlahPallet: t.jumlahPallet, operator: t.operator };
      }
    }
    if (t.updatedAt > item.updated) item.updated = t.updatedAt;
  });
  return Object.values(map).sort((a, b) => a.nama.localeCompare(b.nama));
}

// Susun barang menjadi KARTU per kombinasi unik Kode Barang + Supplier +
// Pemilik (bukan per kode barang saja). Ini yang dipakai Katalog Barang
// (mode 'barang') supaya barang yang sama tapi beda supplier/pemilik TIDAK
// digabung jadi satu kartu — sedangkan kedatangan (batch masuk) yang
// kombinasi ketiganya persis sama TETAP digabung/dinetkan jadi satu kartu,
// baru rinciannya per-batch terlihat saat kartu itu diklik.
function buildBarangComboList(entries) {
  const map = {};
  entries.forEach(t => {
    const kode = t.kodeBarang || t.namaBarang;
    const supplier = t.supplier || '-';
    const pemilik = t.pemilik || '-';
    const key = [kode, supplier, pemilik].join('␟');
    if (!map[key]) {
      map[key] = {
        kode: t.kodeBarang, nama: t.namaBarang, supplier, pemilik,
        masuk: 0, keluar: 0, masukPallet: 0, keluarPallet: 0,
        lokasiSet: new Set(), history: [], updated: 0,
      };
    }
    const c = map[key];
    c.history.push(t);
    if (t.lokasi) c.lokasiSet.add(t.lokasi);
    if (t.jenis === 'masuk') {
      c.masuk += t.jumlah;
      if (t.jumlahPallet != null) c.masukPallet += t.jumlahPallet;
    } else {
      c.keluar += t.jumlah;
      if (t.jumlahPallet != null) c.keluarPallet += t.jumlahPallet;
    }
    if (t.updatedAt > c.updated) c.updated = t.updatedAt;
  });
  return Object.values(map).sort((a, b) => {
    const byNama = a.nama.localeCompare(b.nama);
    if (byNama !== 0) return byNama;
    const bySupplier = a.supplier.localeCompare(b.supplier);
    if (bySupplier !== 0) return bySupplier;
    return a.pemilik.localeCompare(b.pemilik);
  });
}

function buildLocationStock(entries) {
  const map = {};
  entries.forEach(t => {
    if (!t.lokasi) return;
    // trim() di sini PENTING: kalau ada transaksi lama yang lokasinya
    // kesimpan dengan spasi nyasar di depan/belakang (mis. " B-16-01" atau
    // "B-16-01 "), tanpa trim itu akan dianggap kunci BERBEDA dari
    // "B-16-01" yang bersih — bikin lokasi yang sama kelihatan "pecah" jadi
    // baris terpisah di Katalog, dan teksnya kelihatan menjorok ke kanan
    // di kartu (karena white-space: nowrap menampilkan spasi itu apa
    // adanya, bukan cuma masalah CSS).
    const lokasiKey = String(t.lokasi).trim().replace(/\s+/g, ' ');
    if (!lokasiKey) return;
    const key = t.kodeBarang || t.namaBarang;
    if (!map[lokasiKey]) map[lokasiKey] = { items: {}, lastActivity: 0, tanggalKedatangan: null, totalPallet: 0 };
    const loc = map[lokasiKey];
    if (!loc.items[key]) {
      loc.items[key] = {
        kode: t.kodeBarang, nama: t.namaBarang, qty: 0, pallet: 0, tanggalKedatangan: null,
        supplierSet: new Set(), pemilikSet: new Set(), lastActivity: 0,
      };
    }
    const it = loc.items[key];
    const arah = t.jenis === 'masuk' ? 1 : -1;
    it.qty += arah * t.jumlah;
    if (t.jumlahPallet != null) {
      it.pallet += arah * t.jumlahPallet;
      loc.totalPallet += arah * t.jumlahPallet;
    }
    if (t.supplier) it.supplierSet.add(t.supplier);
    if (t.pemilik) it.pemilikSet.add(t.pemilik);
    if (t.createdAt > it.lastActivity) it.lastActivity = t.createdAt;
    if (t.createdAt > loc.lastActivity) loc.lastActivity = t.createdAt;
    // Tanggal kedatangan = tanggal transaksi MASUK paling awal untuk
    // barang ini di lokasi ini (per item) dan untuk lokasi secara
    // keseluruhan (barang paling lama yang masih tercatat di rak ini).
    if (t.jenis === 'masuk' && t.tanggal) {
      if (!it.tanggalKedatangan || t.tanggal < it.tanggalKedatangan) it.tanggalKedatangan = t.tanggal;
      if (!loc.tanggalKedatangan || t.tanggal < loc.tanggalKedatangan) loc.tanggalKedatangan = t.tanggal;
    }
  });
  const result = Object.entries(map).map(([lokasi, locData]) => {
    const list = Object.values(locData.items).filter(it => it.qty !== 0).sort((a, b) => b.qty - a.qty);
    const totalQty = list.reduce((s, it) => s + it.qty, 0);
    return {
      lokasi, items: list, totalQty, itemCount: list.length, lastActivity: locData.lastActivity,
      tanggalKedatangan: locData.tanggalKedatangan, totalPallet: locData.totalPallet,
    };
  }).filter(l => l.itemCount > 0).sort((a, b) => a.lokasi.localeCompare(b.lokasi));
  return result;
}

// Menambahkan sheet transaksi 1 bulan ke workbook ExcelJS, sudah dengan
// styling rapi: header berwarna, kolom angka & tanggal terformat asli,
// badge Jenis/Tipe berwarna, border, zebra, freeze header, dan autofilter.
function addMonthSheet(workbook, sheetName, entries) {
  const ws = workbook.addWorksheet(sheetName, { views: [{ showGridLines: false }] });
  ws.columns = MONTH_HEADERS.map((h, i) => ({ header: h, width: MONTH_COL_WIDTHS[i] }));

  entries.forEach(t => {
    ws.addRow([
      t.jenis === 'masuk' ? (isoDateToLocalDate(t.tanggal) || t.tanggal) : null,
      t.jenis === 'keluar' ? (isoDateToLocalDate(t.tanggal) || t.tanggal) : null,
      t.jenis === 'masuk' ? 'MASUK' : 'KELUAR',
      t.tipe === 'penyesuaian' ? 'PENYESUAIAN' : 'TRANSAKSI',
      t.operator,
      t.kodeBarang,
      t.namaBarang,
      t.supplier,
      t.pemilik,
      t.lokasi,
      t.jumlah,
      t.qtyPerPallet != null ? t.qtyPerPallet : null,
      t.jumlahPallet != null ? t.jumlahPallet : null,
      t.keterangan || '',
      new Date(t.createdAt),
      new Date(t.updatedAt),
      t.id,
    ]);
  });

  const lastRow = entries.length + 1;
  for (let r = 2; r <= lastRow; r++) {
    const row = ws.getRow(r);
    row.getCell(1).numFmt = 'dd/mm/yyyy';
    row.getCell(2).numFmt = 'dd/mm/yyyy';
    row.getCell(11).numFmt = '#,##0';
    row.getCell(12).numFmt = '#,##0';
    row.getCell(13).numFmt = '#,##0';
    row.getCell(15).numFmt = 'dd/mm/yyyy hh:mm';
    row.getCell(16).numFmt = 'dd/mm/yyyy hh:mm';
    row.getCell(11).alignment = { horizontal: 'right' };
    row.getCell(12).alignment = { horizontal: 'right' };
    row.getCell(13).alignment = { horizontal: 'right' };
    const t = entries[r - 2];
    colorizeBadgeCell(row.getCell(3), t.jenis === 'masuk' ? 'masuk' : 'keluar');
    if (t.tipe === 'penyesuaian') colorizeBadgeCell(row.getCell(4), 'penyesuaian');
    else { row.getCell(4).alignment = { horizontal: 'center' }; row.getCell(4).font = { color: { argb: EXCEL_THEME.abu }, size: 10.5 }; }
  }

  styleExcelSheet(ws, { lastCol: MONTH_HEADERS.length, firstDataRow: 2, lastDataRow: lastRow });
  return ws;
}

// Menambahkan sheet "Ringkasan Stok" ke workbook ExcelJS: stok saat ini
// diberi warna (hijau jika positif, merah jika minus) supaya selisih stok
// langsung kelihatan tanpa perlu buka aplikasi.
function addStokSheet(workbook, sheetName, entries) {
  const items = buildStokList(entries);
  const ws = workbook.addWorksheet(sheetName, { views: [{ showGridLines: false }] });
  ws.columns = STOK_HEADERS.map((h, i) => ({ header: h, width: STOK_COL_WIDTHS[i] }));

  items.forEach(it => {
    // Tanggal & jumlah terakhir masuk/keluar ditaruh di kolom TERPISAH
    // (bukan digabung jadi satu teks "2026-01-05 (12500 pcs)") supaya
    // Excel bisa memformat tanggal dan angkanya sendiri-sendiri — jadi
    // gampang dibaca, gampang di-sort, dan angka besar otomatis dapat
    // pemisah ribuan alih-alih ditulis mentah di dalam teks.
    ws.addRow([
      it.kode,
      it.nama,
      Array.from(it.lokasi).join(', '),
      it.masuk,
      it.keluar,
      it.masuk - it.keluar,
      it.lastMasuk ? isoToExcelDate(it.lastMasuk.tanggal) : null,
      it.lastMasuk ? it.lastMasuk.jumlah : null,
      it.lastKeluar ? isoToExcelDate(it.lastKeluar.tanggal) : null,
      it.lastKeluar ? it.lastKeluar.jumlah : null,
      it.updated ? new Date(it.updated) : '-',
    ]);
  });

  const lastRow = items.length + 1;
  for (let r = 2; r <= lastRow; r++) {
    const row = ws.getRow(r);
    [4, 5, 6, 8, 10].forEach(c => { row.getCell(c).numFmt = '#,##0'; row.getCell(c).alignment = { horizontal: 'right' }; });
    [7, 9].forEach(c => { if (row.getCell(c).value instanceof Date) { row.getCell(c).numFmt = 'dd/mm/yyyy'; row.getCell(c).alignment = { horizontal: 'right' }; } });
    if (row.getCell(11).value instanceof Date) row.getCell(11).numFmt = 'dd/mm/yyyy hh:mm';
    const stokCell = row.getCell(6);
    const stok = items[r - 2].masuk - items[r - 2].keluar;
    stokCell.font = { bold: true, color: { argb: stok < 0 ? EXCEL_THEME.merah : stok > 0 ? EXCEL_THEME.hijau : EXCEL_THEME.abu } };
  }

  styleExcelSheet(ws, { lastCol: STOK_HEADERS.length, firstDataRow: 2, lastDataRow: lastRow });
  return ws;
}

// Memicu unduhan file .xlsx dari workbook ExcelJS di browser (tanpa
// perlu library tambahan seperti FileSaver).
async function downloadExcelWorkbook(workbook, filename) {
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---- UI Connection Status ---- */
const elConnecting = document.getElementById('connect-connecting');
const elConnected = document.getElementById('connect-connected');
const elConnectError = document.getElementById('connect-error');
const operatorNotReady = document.getElementById('operator-not-ready');
const headerStatusPill = document.getElementById('header-status-pill');
const headerStatusDot = document.getElementById('header-status-dot');
const headerStatusText = document.getElementById('header-status-text');

/* ==========================================================================
   MENU NAVIGASI OPERATOR — pindah antar panel (Buat Laporan / Katalog
   Barang / Riwayat Laporan) tanpa perlu scroll panjang. Hanya berlaku
   untuk role operator; tampilan admin tidak dipengaruhi fungsi ini.
========================================================================== */
const opNav = document.getElementById('op-nav');
const opPanels = {
  laporan: document.getElementById('op-panel-laporan'),
  katalog: document.getElementById('op-panel-katalog'),
  riwayat: document.getElementById('op-panel-riwayat'),
};

function switchOperatorPanel(panel) {
  if (!opPanels[panel]) return;
  Object.keys(opPanels).forEach(key => {
    if (opPanels[key]) opPanels[key].hidden = key !== panel;
  });
  if (opNav) {
    opNav.querySelectorAll('.op-nav-btn').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.opPanel === panel);
    });
  }
  if (panel === 'riwayat') renderRiwayatOperator();
}

if (opNav) {
  opNav.querySelectorAll('.op-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchOperatorPanel(btn.dataset.opPanel));
  });
}

/* ==========================================================================
   MENU NAVIGASI ADMIN — pindah antar panel (Dashboard / Katalog & Stok /
   Operator / Riwayat) supaya halaman admin tidak jadi satu scroll panjang
   berisi semua section sekaligus. Panel "Katalog & Stok" khusus admin
   memakai #admin-panel-katalog-stok sendiri (lihat KATALOG & STOK — ADMIN
   di bawah) — TIDAK lagi memakai ulang #op-panel-katalog punya operator,
   supaya tampilan filter+tabel admin bisa berbeda dari folder-browse
   operator tanpa saling mempengaruhi.
========================================================================== */
const adminNav = document.getElementById('admin-nav');
const adminPanels = {
  dashboard: document.getElementById('admin-panel-dashboard'),
  katalog: document.getElementById('admin-panel-katalog-stok'),
  operator: document.getElementById('admin-panel-operator'),
  riwayat: document.getElementById('admin-panel-riwayat'),
  kelola: document.getElementById('admin-panel-katalog'),
};

function switchAdminPanel(panel) {
  if (!adminPanels[panel]) return;
  Object.keys(adminPanels).forEach(key => {
    if (adminPanels[key]) adminPanels[key].hidden = key !== panel;
  });
  document.querySelectorAll('.admin-nav-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.adminPanel === panel);
  });
  if (panel === 'operator') renderAkunOperator();
  if (panel === 'riwayat') renderRiwayat();
  if (panel === 'katalog') renderKdsPanel();
}

document.querySelectorAll('.admin-nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchAdminPanel(btn.dataset.adminPanel));
});

function currentRole() {
  const s = getSession();
  return s ? s.role : null;
}

let lastConnectState = 'connecting';

function applyHeaderStatusPill(state) {
  if (!headerStatusPill) return;
  headerStatusPill.dataset.state = state;
  headerStatusDot.classList.toggle('dot-connecting', state === 'connecting');
  headerStatusDot.classList.toggle('dot-error', state === 'error');
  headerStatusText.textContent = state === 'connected' ? 'Tersambung real-time'
    : state === 'error' ? 'Gagal tersambung'
    : 'Menyambungkan...';
}

function setConnectUI(state) {
  elConnecting.hidden = state !== 'connecting';
  elConnected.hidden = state !== 'connected';
  elConnectError.hidden = state !== 'error';

  lastConnectState = state;
  applyHeaderStatusPill(state);

  // Firestore boleh dianggap "siap" (bisa dipakai untuk kirim laporan)
  // begitu listener pertama berhasil — baik itu langsung dari server
  // (online) MAUPUN dari cache lokal (offline, tapi pernah online
  // sebelumnya). Makanya tombol kirim TIDAK lagi diblok cuma karena HP
  // sedang offline; laporan tetap boleh dikirim dan otomatis tersimpan
  // dulu ke perangkat (lihat updatePendingSyncUI & submit handler).
  const submitBtn = document.getElementById('btn-submit');
  if (submitBtn) submitBtn.disabled = state !== 'connected';

  if (currentRole() === 'operator') {
    operatorNotReady.hidden = state === 'connected';
  } else {
    operatorNotReady.hidden = true;
  }

  updatePendingSyncUI();
}

/* ==========================================================================
   MODE OFFLINE & ANTRIAN SINKRONISASI
   Firestore (dengan persistentLocalCache, lihat firebase-config.js) tetap
   menyimpan laporan baru ke perangkat walau internet mati, lalu otomatis
   mengirimkannya ke server begitu koneksi kembali. Bagian ini cuma
   mengurus TAMPILANNYA: kasih tahu operator/admin kalau lagi offline, dan
   berapa banyak laporan yang masih menunggu terkirim.
========================================================================== */
const pendingSyncBadge = document.getElementById('pending-sync-badge');
const offlineBanner = document.getElementById('offline-banner');

function updatePendingSyncUI() {
  const isOnline = navigator.onLine;

  if (pendingSyncBadge) {
    if (pendingSyncCount > 0) {
      pendingSyncBadge.hidden = false;
      pendingSyncBadge.textContent = `${pendingSyncCount} laporan menunggu sinkron`;
    } else {
      pendingSyncBadge.hidden = true;
    }
  }

  if (offlineBanner) {
    if (!isOnline) {
      offlineBanner.hidden = false;
      offlineBanner.textContent = pendingSyncCount > 0
        ? `📡 Mode offline — ${pendingSyncCount} laporan tersimpan di perangkat, akan otomatis terkirim saat internet kembali.`
        : '📡 Mode offline — laporan yang dikirim tetap tersimpan di perangkat dan otomatis terkirim saat internet kembali.';
    } else if (pendingSyncCount > 0) {
      offlineBanner.hidden = false;
      offlineBanner.textContent = `🔄 Menyinkronkan ${pendingSyncCount} laporan ke server...`;
    } else {
      offlineBanner.hidden = true;
    }
  }

  // Pil status di header: kalau lagi offline, tampilkan itu dulu
  // (lebih relevan buat operator daripada status listener Firestore).
  // Begitu online lagi, kembalikan ke status koneksi Firestore yang
  // sebenarnya (connected/connecting/error).
  if (!isOnline) {
    if (headerStatusPill) {
      headerStatusPill.dataset.state = 'offline';
      headerStatusDot.classList.remove('dot-connecting', 'dot-error');
      headerStatusDot.classList.add('dot-offline');
      headerStatusText.textContent = pendingSyncCount > 0 ? `Offline · ${pendingSyncCount} menunggu` : 'Mode offline';
    }
  } else {
    if (headerStatusDot) headerStatusDot.classList.remove('dot-offline');
    applyHeaderStatusPill(lastConnectState);
  }
}

window.addEventListener('online', updatePendingSyncUI);
window.addEventListener('offline', updatePendingSyncUI);


// Ambang batas "stok menipis" — barang dengan stok di bawah angka ini
// (tapi masih di atas 0) dianggap perlu diperhatikan. Barang dengan stok
// pas 0 selalu dianggap "kosong" apapun ambang batasnya. Gampang diubah
// kalau nanti mau beda per jenis barang — untuk sekarang satu angka global.
const AMBANG_STOK_MENIPIS = 20;

function renderStokWarning() {
  if (currentRole() !== 'admin') return;
  const wrap = document.getElementById('stok-warning');
  const listEl = document.getElementById('stok-warning-list');
  const countEl = document.getElementById('stok-warning-count');
  if (!wrap || !listEl || !countEl) return;

  const items = buildStokList(currentEntries);
  const perluPerhatian = items
    .map(it => ({ ...it, stok: it.masuk - it.keluar }))
    .filter(it => it.stok <= AMBANG_STOK_MENIPIS)
    .sort((a, b) => a.stok - b.stok);

  updateAdminNavBadge('katalog', perluPerhatian.length);

  if (perluPerhatian.length === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  countEl.textContent = perluPerhatian.length.toLocaleString('id-ID');
  listEl.innerHTML = perluPerhatian.slice(0, 8).map(it => {
    const kosong = it.stok <= 0;
    return `
      <button type="button" class="stok-warning-item${kosong ? ' kosong' : ''}" data-kode="${escapeHtml(it.kode || '')}">
        <span class="stok-warning-item-nama">${escapeHtml(it.nama)}</span>
        <span class="stok-warning-item-kode mono">${escapeHtml(it.kode || '-')}</span>
        <span class="stok-warning-item-qty">${it.stok.toLocaleString('id-ID')} pcs</span>
      </button>
    `;
  }).join('');
  if (perluPerhatian.length > 8) {
    listEl.innerHTML += `<div class="stok-warning-more">+${(perluPerhatian.length - 8).toLocaleString('id-ID')} barang lainnya — buka tab Katalog & Stok untuk lihat semua.</div>`;
  }
  listEl.querySelectorAll('.stok-warning-item').forEach(btn => {
    btn.addEventListener('click', () => {
      switchAdminPanel('katalog');
      openItemModal(btn.dataset.kode);
    });
  });
}

// Badge angka kecil di tombol menu admin (mis. "Katalog & Stok 3") —
// dipakai buat nunjukin ada berapa barang yang perlu perhatian tanpa
// admin harus buka tabnya dulu.
function updateAdminNavBadge(panel, count) {
  document.querySelectorAll(`.admin-nav-btn[data-admin-panel="${panel}"]`).forEach(btn => {
    let badge = btn.querySelector('.admin-nav-badge');
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'admin-nav-badge';
        btn.appendChild(badge);
      }
      badge.textContent = count > 99 ? '99+' : count;
    } else if (badge) {
      badge.remove();
    }
  });
}

function renderAll() {
  renderRingkasan();
  renderStokWarning();
  renderKatalog();
  renderRiwayat();
  renderRiwayatOperator();
  renderAkunOperator();
  renderKdsPanel();
}

let currentOperatorAccounts = [];
let unsubscribeOperatorAccounts = null;
let pendingSyncCount = 0;

function initFirestoreConnection() {
  setConnectUI('connecting');

  function startListening() {
    const fb = window.gudangFirebase;
    if (!fb) { setConnectUI('error'); return; }

    if (unsubscribeLaporan) unsubscribeLaporan();

    // includeMetadataChanges: true — supaya kita juga dapat notifikasi saat
    // status "pending write" sebuah dokumen berubah (misalnya barusan
    // tersinkron ke server), bukan cuma saat isi datanya berubah. Ini yang
    // dipakai untuk menghitung & menampilkan badge "N laporan menunggu
    // sinkron" saat operator sedang offline.
    unsubscribeLaporan = fb.onSnapshot(
      fb.laporanCol,
      { includeMetadataChanges: true },
      (snapshot) => {
        const semuaDokumen = snapshot.docs.map(d => {
          const data = d.data();
          return { id: d.id, ...data, _pending: d.metadata.hasPendingWrites };
        });
        // "dihapus" itu SOFT DELETE (bukan beneran dihapus dari Firestore) —
        // dokumennya tetap ada, cuma ditandai + dikeluarkan dari
        // currentEntries (dipakai di seluruh perhitungan stok & tampilan
        // normal). currentEntriesRaw menyimpan SEMUA dokumen (termasuk yang
        // ditandai terhapus) khusus untuk panel "Jejak Edit/Hapus", supaya
        // riwayat siapa-menghapus-apa tetap bisa ditelusuri.
        currentEntriesRaw = semuaDokumen;
        currentEntries = semuaDokumen.filter(t => !t.dihapus);
        pendingSyncCount = currentEntries.filter(t => t._pending).length;
        firestoreReady = true;
        setConnectUI('connected');
        updatePendingSyncUI();
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

    // PENTING: listener barangBaru & pemilikBaru DIPINDAH ke sini (dari
    // dulunya dipanggil langsung di top-level file, lihat catatan di
    // definisi fungsinya di bawah). Rules Firestore mensyaratkan
    // isAppUser() (auth != null && role di token), jadi listener ini HANYA
    // boleh dipasang SETELAH user beneran login — bukan saat script.js
    // pertama kali dimuat (waktu itu auth.currentUser masih null, jadi
    // langsung kena permission-denied dan listener-nya mati permanen,
    // tidak pernah nyambung lagi walau user berhasil login sesudahnya).
    // CATATAN: startBarangBaruListener() SUDAH DIHAPUS (duplikat dengan
    // listener barangBaru di startAllOverlayListeners() / subscribeToUpdates()
    // di bawah — lihat catatan di bekas lokasi fungsinya).
    // CATATAN v3.2: startPemilikBaruListener() JUGA DIHAPUS dari sini — ini
    // listener onSnapshot(fb.pemilikBaruCol) KEDUA yang berjalan bersamaan
    // dengan listener pemilikBaru di startAllOverlayListeners() (dipanggil
    // dari katalogManager.subscribeToUpdates() di bawah), sama persis
    // dengan bug lama startBarangBaruListener(). Listener yang dihapus ini
    // juga TIDAK memfilter dokumen deleted:true, jadi setiap kali dua
    // listener ini balapan menerima snapshot, hasil edit/hapus pemilik bisa
    // "keteper" balik oleh listener lama yang membawa data belum ter-update
    // — inilah sebab edit/hapus pemilik kelihatan "berhasil" (toast sukses,
    // tulisan Firestore benar) tapi tidak berubah/hilang di layar.
    // Subscription katalog (panel Pengelolaan Barang/Pemilik) juga baru
    // aman dipasang di sini, SETELAH login — lihat catatan di
    // KatalogManager.subscribeToUpdates().
    katalogManager.subscribeToUpdates();
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

// SOFT DELETE — dokumennya TIDAK dihapus dari Firestore, cuma ditandai
// dihapus + dicatat siapa & kapan. Ini penting untuk akuntabilitas gudang:
// kalau suatu saat ada selisih stok yang harus ditelusuri, riwayat siapa
// yang menghapus laporan apa tetap ada, gak hilang begitu saja.
async function softDeleteEntryFromFirestore(id, oleh) {
  const fb = window.gudangFirebase;
  await fb.updateDoc(fb.doc(fb.db, 'laporan', id), {
    dihapus: true,
    dihapusOleh: oleh,
    dihapusAt: Date.now(),
  });
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
  el.className = 'toast' + (type === 'error' ? ' error' : type === 'info' ? ' info' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3400);
}

// Modal konfirmasi custom — pengganti confirm() bawaan browser supaya
// tampilannya konsisten dengan desain aplikasi (bukan popup polos bawaan
// OS/browser). Dipakai dengan: await showConfirmModal({ title, message }).
// Mengembalikan Promise<boolean> — true kalau user klik "Ya, Lanjutkan",
// false kalau user klik "Batal", tekan Esc, atau klik di luar modal.
function showConfirmModal({ title = 'Konfirmasi', message = '', confirmText = 'Ya, Lanjutkan', cancelText = 'Batal' } = {}) {
  const modal = document.getElementById('confirm-modal');
  const titleEl = document.getElementById('confirm-modal-title');
  const messageEl = document.getElementById('confirm-modal-message');
  const btnOk = document.getElementById('confirm-modal-ok');
  const btnCancel = document.getElementById('confirm-modal-cancel');
  if (!modal || !titleEl || !messageEl || !btnOk || !btnCancel) {
    // Fallback kalau markup modal entah kenapa tidak ada — tetap jangan
    // sampai aksi hapus berjalan tanpa konfirmasi sama sekali.
    return Promise.resolve(confirm(message || title));
  }

  titleEl.textContent = title;
  messageEl.textContent = message;
  btnOk.textContent = confirmText;
  btnCancel.textContent = cancelText;
  modal.hidden = false;

  return new Promise(resolve => {
    const cleanup = (result) => {
      modal.hidden = true;
      btnOk.removeEventListener('click', onOk);
      btnCancel.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlayClick = (e) => { if (e.target === modal) cleanup(false); };
    const onKeydown = (e) => { if (e.key === 'Escape') cleanup(false); };
    btnOk.addEventListener('click', onOk);
    btnCancel.addEventListener('click', onCancel);
    modal.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeydown);
    btnOk.focus();
  });
}

/* ==========================================================================
   BARANG BARU / DIUBAH / DIHAPUS — overlay Firestore koleksi "barangBaru"
   (lihat blok komentar "OVERLAY MASTER DATA" di atas file untuk konsep
   lengkapnya). Hanya admin yang boleh menulis ke sini (lihat
   firestore.rules) — panel "Pengelolaan Barang" adalah satu-satunya
   pemakai penulisan koleksi ini sekarang.
========================================================================== */

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

// CATATAN: startBarangBaruListener() yang dulu ada di sini SUDAH DIHAPUS —
// itu listener onSnapshot(fb.barangBaruCol) KEDUA yang berjalan bersamaan
// dengan listener di startAllOverlayListeners() (di bawah), saling
// balapan pada setiap perubahan data. Listener itu juga TIDAK memfilter
// dokumen deleted:true, jadi ikut berkontribusi pada total barang yang
// suka berubah-ubah (kadang beda jumlah) tergantung listener mana yang
// selesai duluan. Sekarang barangBaru cukup satu listener saja, di
// startAllOverlayListeners().

/* ==========================================================================
   PEMILIK BARANG (PABRIK) — diambil dari MASTER_DATA.pemilik (data.js),
   sama seperti barang/supplier/lokasi. Operator/admin tetap bisa mengetik
   nama pemilik baru langsung dari dropdown ("+ Tambah baru..."). Begitu
   ditambahkan, tersimpan ke koleksi Firestore "pemilikBaru" sehingga semua
   device lain otomatis melihat nama pemilik baru itu juga di dropdown
   mereka — TIDAK perlu mengedit file data.js secara manual setiap kali
   ada pabrik baru.
========================================================================== */
// Daftar awal pemilik barang/pabrik — dari data.js. Boleh dikosongkan
// sepenuhnya di data.js — isi manual lewat dropdown form akan otomatis
// tersimpan & tersinkron.
// Catatan: PEMILIK_OPTIONS di bawah ini sudah tidak dipakai lagi setelah
// perbaikan v3.2 (rebuildPemilikOptions() sekarang pakai computeSimpleMerged
// yang baca MASTER_DATA.pemilik langsung) — dibiarkan saja, tidak berbahaya.
const PEMILIK_OPTIONS = MASTER_DATA.pemilik || [];

let customPemilik = [];

// CATATAN: `selPemilik` TIDAK dideklarasikan ulang di sini — sudah ada di
// baris ~48-50 (bareng selBarang/selSupplier) untuk alasan TDZ yang sama.
// Deklarasi kedua yang dulu ada di sini adalah sisa refactor lama dan
// menyebabkan `SyntaxError: Identifier 'selPemilik' has already been
// declared` — yang bikin SELURUH script.js gagal dimuat browser (makanya
// semua tombol, termasuk "show password" di layar login, ikut mati total).

// PENTING v3.2: sebelumnya fungsi ini cuma MENGHITUNG daftar gabungan dan
// mengembalikannya (dipakai buat ngisi dropdown), TAPI TIDAK PERNAH
// menyimpan hasilnya ke variabel module-level PEMILIK_OPTIONS_MERGED —
// padahal itulah variabel yang dibaca tabel "Pengelolaan Pemilik" di panel
// admin (lihat renderSimpleList()). Akibatnya tabel admin itu selamanya
// menampilkan daftar statis awal (MASTER_DATA.pemilik), walau tulisan ke
// Firestore sudah sukses dan listener real-time-nya jalan — persis gejala
// "berhasil tapi nggak kegantt/kehapus di layar". Sekarang dipakai
// computeSimpleMerged() yang sama seperti supplier/lokasi, supaya juga
// otomatis menyembunyikan entri deleted:true dan konsisten datanya.
function rebuildPemilikOptions() {
  PEMILIK_OPTIONS_MERGED = computeSimpleMerged('pemilik');
  if (selPemilik && selPemilik.updateOptions) selPemilik.updateOptions(PEMILIK_OPTIONS_MERGED);
  // PENTING: sama seperti rebuildBarangOptions(), tabel "Pengelolaan Barang"
  // (tab Pemilik Barang) di panel admin HARUS ikut di-refresh di sini.
  // Sebelumnya baris ini tidak ada, jadi tulisan ke Firestore (tambah/edit/
  // hapus pemilik) sukses tapi tabelnya di layar tidak pernah berubah
  // sampai user pindah tab atau ngetik ulang di kolom pencarian.
  if (typeof katalogManager !== 'undefined' && katalogManager.renderPemilikList) {
    katalogManager.renderPemilikList(document.getElementById('search-pemilik')?.value || '');
  }
  return PEMILIK_OPTIONS_MERGED;
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

// CATATAN v3.2: startPemilikBaruListener() (listener onSnapshot kedua untuk
// pemilikBaru, duplikat dengan listener di startAllOverlayListeners() di
// bawah) SUDAH DIHAPUS dari sini — lihat catatan di startListening()
// (dekat awal file) untuk detail bug yang ditimbulkannya.

/* ==========================================================================
   UNIFIED OVERLAY LISTENERS & HELPERS — barang, supplier, pemilik, lokasi
========================================================================== */

// Listener subscription handles
let unsubscribeSupplierBaru = null;
let unsubscribeLokasiBaruListener = null;
let customSupplier = [];
let customLokasi = [];

// Helper: upsert dokumen overlay, dengan hati-hati tidak resend createdAt saat update
async function upsertOverlayDoc(collectionName, docId, data) {
  const fb = await waitForFirebase();
  if (!collectionName || !docId) throw new Error('Collection dan doc ID harus diisi.');
  
  const docRef = fb.doc(fb.db, collectionName, docId);
  const existingDoc = await fb.getDoc(docRef);
  
  if (existingDoc.exists()) {
    // Update: jangan include createdAt supaya rules tidak menolak
    const updateData = { ...data };
    delete updateData.createdAt;
    await fb.updateDoc(docRef, updateData);
  } else {
    // Create: WAJIB include createdAt (syarat rules create), tapi
    // pemanggil edit/hapus TIDAK selalu menyertakannya karena mengira
    // dokumennya pasti sudah ada (padahal item dari katalog dasar/data.js
    // yang belum pernah di-overlay belum punya dokumen sama sekali).
    // Isi otomatis di sini supaya edit/hapus item dari katalog dasar
    // tidak gagal dengan "Missing or insufficient permissions".
    const createData = { ...data };
    if (createData.createdAt === undefined) {
      createData.createdAt = Date.now();
    }
    await fb.setDoc(docRef, createData);
  }
}

// Compute merged barang options (base + overlay).
// PENTING: overlay HARUS bisa menimpa/menyembunyikan item dari katalog
// dasar (MASTER_DATA.barang) — bukan cuma menambah item baru. Sebelumnya
// versi ini asal concat base+overlay tanpa cek override, jadi edit/hapus
// terhadap barang bawaan katalog dasar TIDAK PERNAH kelihatan efeknya di
// layar walau tulisannya ke Firestore sudah sukses.
function computeBarangMerged() {
  const base = MASTER_DATA.barang || [];
  const seen = new Set();
  const result = [];
  base.forEach(b => {
    seen.add(b.kode);
    const o = barangOverlay.get(b.kode);
    if (o) {
      if (!o.deleted) result.push({ kode: b.kode, nama: o.nama });
      // kalau o.deleted true, item ini sengaja TIDAK dimasukkan (sudah dihapus admin)
    } else {
      result.push(b);
    }
  });
  barangOverlay.forEach((o, kode) => {
    if (!seen.has(kode) && !o.deleted) result.push({ kode, nama: o.nama });
  });
  return result;
}

// PENTING v3.3: computeSimpleMerged() SEBELUMNYA cuma menerima daftar nama
// yang MASIH AKTIF (deleted:false) dari listener (lihat customSupplier/
// customPemilik/customLokasi) — begitu sebuah item DASAR (dari data.js)
// dihapus, catatan bahwa item itu pernah "dihapus" langsung hilang total
// dari memori (listener-nya memang sengaja tidak memasukkan dokumen
// deleted:true ke array itu). Akibatnya computeSimpleMerged() TIDAK PERNAH
// bisa tahu kalau item dasar tertentu harus disembunyikan — item itu selalu
// muncul lagi dari MASTER_DATA[entity], walau tulisan deleted:true ke
// Firestore-nya sendiri sukses. Sama juga untuk RENAME: nama lama dari
// katalog dasar tidak pernah ketutup oleh nama barunya.
// Sekarang dipakai overlay Map (supplierOverlay/pemilikOverlay/
// lokasiOverlay, id = sanitizeMasterId(nama)) yang menyimpan SEMUA
// dokumen overlay APAPUN status deleted-nya — persis pola yang sudah benar
// dipakai barangOverlay + computeBarangMerged() di atas.
function computeSimpleMerged(entity) {
  const base = MASTER_DATA[entity] || [];
  const overlay = entity === 'supplier' ? supplierOverlay :
                  entity === 'pemilik' ? pemilikOverlay :
                  entity === 'lokasi' ? lokasiOverlay : new Map();
  const seenIds = new Set();
  const result = [];
  base.forEach(b => {
    const id = sanitizeMasterId(b);
    seenIds.add(id);
    const o = overlay.get(id);
    if (o) {
      if (!o.deleted) result.push(o.nama);
      // kalau o.deleted true, item dasar ini sengaja TIDAK dimasukkan
      // (sudah dihapus admin) — sebelumnya versi ini tidak pernah sampai
      // ke titik ini karena overlay yang deleted tidak pernah tersimpan.
    } else {
      result.push(b);
    }
  });
  overlay.forEach((o, id) => {
    if (!seenIds.has(id) && !o.deleted) result.push(o.nama);
  });
  return result.sort();
}

function rebuildSupplierOptions() {
  SUPPLIER_OPTIONS = computeSimpleMerged('supplier');
  if (selSupplier && selSupplier.updateOptions) selSupplier.updateOptions(SUPPLIER_OPTIONS);
  // PENTING: sama seperti rebuildBarangOptions(), tabel "Pengelolaan Barang"
  // (tab Supplier) di panel admin HARUS ikut di-refresh di sini — sebelumnya
  // baris ini tidak ada, jadi tambah/edit/hapus supplier sukses ditulis ke
  // Firestore tapi tabelnya di layar tidak pernah ikut berubah.
  if (typeof katalogManager !== 'undefined' && katalogManager.renderSupplierList) {
    katalogManager.renderSupplierList(document.getElementById('search-supplier')?.value || '');
  }
}

function rebuildLokasiOptions() {
  LOKASI_OPTIONS = computeSimpleMerged('lokasi');
  LOKASI_SET = new Set(LOKASI_OPTIONS);
  const dl = document.getElementById('dl-lokasi');
  if (dl) {
    dl.innerHTML = '';
    const frag = document.createDocumentFragment();
    LOKASI_OPTIONS.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l;
      frag.appendChild(opt);
    });
    dl.appendChild(frag);
  }
  // PENTING: sama seperti rebuildBarangOptions(), tabel "Pengelolaan Barang"
  // (tab Lokasi) di panel admin HARUS ikut di-refresh di sini — sebelumnya
  // baris ini tidak ada, jadi tambah/edit/hapus lokasi sukses ditulis ke
  // Firestore tapi tabelnya di layar tidak pernah ikut berubah.
  if (typeof katalogManager !== 'undefined' && katalogManager.renderLokasiList) {
    katalogManager.renderLokasiList(document.getElementById('search-lokasi')?.value || '');
  }
}

// rebuildBarangOptions() dipanggil setiap kali listener barangBaru
// menerima update. HARUS ikut me-refresh tabel "Pengelolaan Barang" di
// panel admin (bukan cuma dropdown input laporan) — sebelumnya versi ini
// cuma update dropdown, jadi tabel admin nggak pernah auto-refresh setelah
// edit/hapus/tambah, kelihatannya "nggak jalan" padahal tulisan Firestore
// sudah sukses.
function rebuildBarangOptions() {
  BARANG_OPTIONS = computeBarangMerged();
  if (selBarang && selBarang.updateOptions) {
    selBarang.updateOptions(BARANG_OPTIONS);
  }
  if (typeof katalogManager !== 'undefined' && katalogManager.renderBarangList) {
    katalogManager.renderBarangList(document.getElementById('search-barang')?.value || '');
  }
}

// Start listening to all 4 overlay collections
function startAllOverlayListeners() {
  const fb = window.gudangFirebase;
  if (!fb) return;

  // Barang
  if (fb.barangBaruCol) {
    if (unsubscribeBarangBaru) unsubscribeBarangBaru();
    unsubscribeBarangBaru = fb.onSnapshot(fb.barangBaruCol, (snapshot) => {
      barangOverlay.clear();
      snapshot.docs.forEach(d => {
        const data = d.data();
        barangOverlay.set(data.kode, { kode: data.kode, nama: data.nama, deleted: data.deleted || false });
      });
      rebuildBarangOptions();
    }, (err) => {
      console.error('Gagal memuat daftar barang baru:', err);
    });
  }

  // Supplier
  if (fb.supplierBaruCol) {
    if (unsubscribeSupplierBaru) unsubscribeSupplierBaru();
    unsubscribeSupplierBaru = fb.onSnapshot(fb.supplierBaruCol, (snapshot) => {
      customSupplier = [];
      supplierOverlay.clear();
      snapshot.docs.forEach(d => {
        const data = d.data();
        supplierOverlay.set(d.id, { nama: data.nama, deleted: data.deleted || false });
        if (!data.deleted) customSupplier.push(data.nama);
      });
      rebuildSupplierOptions();
    }, (err) => {
      console.error('Gagal memuat daftar supplier baru:', err);
    });
  }

  // Pemilik
  if (fb.pemilikBaruCol) {
    if (unsubscribePemilikBaru) unsubscribePemilikBaru();
    unsubscribePemilikBaru = fb.onSnapshot(fb.pemilikBaruCol, (snapshot) => {
      customPemilik = [];
      pemilikOverlay.clear();
      snapshot.docs.forEach(d => {
        const data = d.data();
        pemilikOverlay.set(d.id, { nama: data.nama, deleted: data.deleted || false });
        if (!data.deleted) customPemilik.push(data.nama);
      });
      rebuildPemilikOptions();
    }, (err) => {
      console.error('Gagal memuat daftar pemilik baru:', err);
    });
  }

  // Lokasi
  if (fb.lokasiBaruCol) {
    if (unsubscribeLokasiBaruListener) unsubscribeLokasiBaruListener();
    unsubscribeLokasiBaruListener = fb.onSnapshot(fb.lokasiBaruCol, (snapshot) => {
      customLokasi = [];
      lokasiOverlay.clear();
      snapshot.docs.forEach(d => {
        const data = d.data();
        lokasiOverlay.set(d.id, { nama: data.nama, deleted: data.deleted || false });
        if (!data.deleted) customLokasi.push(data.nama);
      });
      rebuildLokasiOptions();
    }, (err) => {
      console.error('Gagal memuat daftar lokasi baru:', err);
    });
  }
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

  // Label & hint field tanggal berubah sesuai jenis laporan:
  // - MASUK  -> "Tanggal Kedatangan" (tanggal barang tiba di gudang, dipakai
  //             untuk urutan FIFO stok).
  // - KELUAR -> "Tanggal Penginputan" (tanggal form barang keluar ini
  //             dilaporkan/diinput — TIDAK sama dengan tanggal kedatangan
  //             batch stok yang diambil; tanggal kedatangan batch tetap
  //             bisa dilihat di kartu "Stok Tersedia" / "📅 Datang").
  const labelTanggalText = document.getElementById('label-tanggal-text');
  const tanggalHint = document.getElementById('tanggal-hint');
  if (labelTanggalText) labelTanggalText.textContent = j === 'keluar' ? 'Tanggal Penginputan' : 'Tanggal Kedatangan';
  if (tanggalHint) tanggalHint.hidden = j !== 'keluar';
  // Tanggal penginputan defaultnya hari ini (bukan tanggal kedatangan
  // batch) — operator tetap bisa mengubahnya kalau perlu backdate laporan.
  if (j === 'keluar' && typeof inputTanggal !== 'undefined' && inputTanggal && !inputTanggal.value) {
    inputTanggal.value = todayISO();
  }

  kombinasiTerkunci = null;
  if (typeof selSupplier !== 'undefined') selSupplier.reset();
  if (typeof selPemilik !== 'undefined') selPemilik.reset();
  if (typeof selLokasi !== 'undefined') selLokasi.reset();
  if (typeof selBarang !== 'undefined') {
    const barangDipilih = selBarang.getValue();
    refreshKombinasiUI(barangDipilih ? barangDipilih.kode : null);
  }
}

// kombinasiTerkunci = kombinasi (supplier+pemilik+lokasi) yang sedang
// dipilih operator dari daftar "Stok Tersedia" saat lapor barang KELUAR.
// null berarti belum ada yang dipilih / sedang mode MASUK (bebas pilih).
let kombinasiTerkunci = null;

selBarang = setupSearchableSelect({
  id: 'sel-barang',
  options: BARANG_OPTIONS,
  getLabel: o => o.nama,
  getSub: o => o.kode,
  placeholder: 'Pilih barang...',
  // "+ Tambah baru" khusus DIHAPUS dari form input laporan (dipakai
  // operator) — operator tidak boleh menambah barang baru sendiri.
  // Kalau ada barang yang belum ada di daftar, operator harus minta admin
  // menambahkannya lewat menu Katalog (atau lewat form Sesuaikan Stok yang
  // memang khusus admin). allowAdd/onAdd sengaja TIDAK diisi di sini.
  onSelect: (o) => {
    document.getElementById('kode-box').hidden = false;
    document.getElementById('kode-value').textContent = o.kode;
    kombinasiTerkunci = null;
    selSupplier.reset();
    selPemilik.reset();
    selLokasi.reset();
    refreshKombinasiUI(o.kode);
  },
});

selSupplier = setupSearchableSelect({
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
  // Sama seperti sel-barang di atas: operator TIDAK boleh menambah pemilik
  // barang/pabrik baru sendiri dari form input laporan. Hanya admin yang
  // bisa (lewat menu Katalog).
  onSelect: () => {},
});

/* ==========================================================================
   KATALOG & STOK — ADMIN
   Panel filter + tabel hasil pencarian, satu baris = satu kedatangan
   (transaksi jenis "masuk"). Klik "Detail" membuka modal detail kedatangan,
   dari situ admin bisa lanjut ke modal Riwayat Kedatangan (semua kedatangan
   untuk kombinasi barang+supplier+pemilik yang sama).
========================================================================== */
const kdsBarangValueEl = document.getElementById('kds-sel-barang-value');
let kdsSelBarang, kdsSelSupplier, kdsSelPemilik, kdsSelLokasi, kdsSelOperator;

if (kdsBarangValueEl) {
  kdsSelBarang = setupSearchableSelect({
    id: 'kds-sel-barang', options: BARANG_OPTIONS,
    getLabel: o => o.nama, getSub: o => o.kode,
    placeholder: 'Semua barang...', onSelect: () => {},
  });
  kdsSelSupplier = setupSearchableSelect({
    id: 'kds-sel-supplier', options: MASTER_DATA.supplier || [],
    getLabel: o => o, placeholder: 'Semua supplier...', onSelect: () => {},
  });
  kdsSelPemilik = setupSearchableSelect({
    id: 'kds-sel-pemilik', options: rebuildPemilikOptions(),
    getLabel: o => o, placeholder: 'Semua pemilik...', onSelect: () => {},
  });
  kdsSelLokasi = setupSearchableSelect({
    id: 'kds-sel-lokasi', options: LOKASI_OPTIONS,
    getLabel: o => o, placeholder: 'Pilih lokasi rak...', onSelect: () => {},
  });
  kdsSelOperator = setupSearchableSelect({
    id: 'kds-sel-operator', options: [],
    getLabel: o => o, placeholder: 'Pilih operator...', onSelect: () => {},
  });
}

// Filter yang SEDANG DITERAPKAN (hanya berubah saat klik "Terapkan Filter"
// atau "Reset Filter" / "Bersihkan semua filter") — dipisah dari nilai
// mentah di masing-masing dropdown supaya admin bisa ganti-ganti pilihan
// dropdown dulu tanpa hasil tabel langsung berubah-ubah.
let kdsAppliedFilters = {};
let kdsSortMode = 'tanggal-desc';
let kdsPage = 1;
let kdsPageSize = 10;

const AMBANG_STOK_HABIS = 0;

// ===== AGREGASI PER KOMBINASI BARANG =====
// Dipakai untuk popup Detail (openKdsDetailModalForCombo) — menghitung
// ringkasan 1 kombinasi (1 kombinasi = 1 barang + supplier + pemilik +
// lokasi) meskipun tabel utama sekarang menampilkan transaksi individual.

// Menghitung statistik untuk 1 kombinasi: total masuk, total keluar, stok saat ini, pallet.
function kdsBuildCombinationStats(combo) {
  const allTransactions = currentEntries;
  
  // Filter semua transaksi yang sesuai kombinasi ini
  const relatedTx = allTransactions.filter(t => 
    t.kodeBarang === combo.kodeBarang && 
    t.supplier === combo.supplier && 
    t.pemilik === combo.pemilik && 
    t.lokasi === combo.lokasi
  );
  
  // Hitung statistik
  const totalMasuk = relatedTx
    .filter(t => t.jenis === 'masuk')
    .reduce((s, t) => s + (t.jumlah || 0), 0);
  
  const totalKeluar = relatedTx
    .filter(t => t.jenis === 'keluar')
    .reduce((s, t) => s + (t.jumlah || 0), 0);
  
  const stokSaatIni = totalMasuk - totalKeluar;
  
  const totalPallet = relatedTx
    .filter(t => t.jumlahPallet != null)
    .reduce((s, t) => s + (t.jenis === 'masuk' ? t.jumlahPallet : -t.jumlahPallet), 0);

  // Tanggal kedatangan (transaksi MASUK paling awal) untuk kombinasi ini —
  // ditampilkan sebagai kolom "Tanggal Kedatangan" di tabel Katalog & Stok.
  const tanggalKedatangan = getTanggalKedatanganKombinasi(allTransactions, combo.kodeBarang, combo.supplier, combo.pemilik, combo.lokasi);
  
  // Tentukan status stok
  let status = 'tersedia';
  if (stokSaatIni <= AMBANG_STOK_HABIS) status = 'habis';
  else if (stokSaatIni < AMBANG_STOK_MENIPIS) status = 'menipis';
  
  return {
    ...combo,
    totalMasuk,
    totalKeluar,
    stokSaatIni,
    totalPallet,
    tanggalKedatangan,
    status,
    transactionCount: relatedTx.length
  };
}

// ===== /AGREGASI PER KOMBINASI BARANG =====

function kdsStatusLevel(t) {
  const stok = getStokKombinasi(currentEntries, t.kodeBarang, t.supplier, t.pemilik, t.lokasi);
  if (stok <= AMBANG_STOK_HABIS) return 'habis';
  if (stok < AMBANG_STOK_MENIPIS) return 'menipis';
  return 'tersedia';
}

// Dulu cuma ambil baris barang MASUK (arrival). Sekarang panel ini
// menampilkan SEMUA transaksi (masuk & keluar) — persis seperti operator
// yang laporannya juga mencatat dua jenis itu — supaya admin bisa lihat
// pergerakan barang keluar juga, bukan cuma kedatangannya saja. Filter
// "Jenis Transaksi" (lihat kdsApplyFilters) yang menentukan mana yang
// tampil kalau admin mau mempersempit ke salah satu jenis saja.
function kdsGetArrivalRows() {
  return currentEntries.filter(t => t.jenis === 'masuk' || t.jenis === 'keluar');
}

function kdsApplyFilters(rows, f) {
  return rows.filter(t => {
    if (f.barang && t.kodeBarang !== f.barang.kode) return false;
    if (f.supplier && t.supplier !== f.supplier) return false;
    if (f.pemilik && t.pemilik !== f.pemilik) return false;
    if (f.lokasi && t.lokasi !== f.lokasi) return false;
    if (f.operator && t.operator !== f.operator) return false;
    if (f.dari && t.tanggal && t.tanggal < f.dari) return false;
    if (f.sampai && t.tanggal && t.tanggal > f.sampai) return false;
    if (f.status && f.status !== 'semua' && kdsStatusLevel(t) !== f.status) return false;
    if (f.jenis && f.jenis !== 'semua' && t.jenis !== f.jenis) return false;
    return true;
  });
}

function kdsSortRows(rows, mode) {
  const sorted = [...rows];
  switch (mode) {
    case 'tanggal-asc':
      sorted.sort((a, b) => (a.tanggal || '').localeCompare(b.tanggal || '') || a.createdAt - b.createdAt);
      break;
    case 'nama-asc':
      sorted.sort((a, b) => (a.namaBarang || '').localeCompare(b.namaBarang || ''));
      break;
    case 'pcs-desc':
      sorted.sort((a, b) => (b.jumlah || 0) - (a.jumlah || 0));
      break;
    case 'pallet-desc':
      sorted.sort((a, b) => (b.jumlahPallet || 0) - (a.jumlahPallet || 0));
      break;
    case 'tanggal-desc':
    default:
      sorted.sort((a, b) => (b.tanggal || '').localeCompare(a.tanggal || '') || b.createdAt - a.createdAt);
  }
  return sorted;
}

function kdsFilterLabel(key, f) {
  switch (key) {
    case 'barang': return `Nama Barang: ${f.barang.nama}`;
    case 'supplier': return `Supplier: ${f.supplier}`;
    case 'pemilik': return `Pemilik Barang: ${f.pemilik}`;
    case 'lokasi': return `Lokasi Rak: ${f.lokasi}`;
    case 'operator': return `Operator Input: ${f.operator}`;
    case 'dari': return `Dari: ${formatTanggal(f.dari)}`;
    case 'sampai': return `Sampai: ${formatTanggal(f.sampai)}`;
    case 'status': return `Status Stok: ${f.status.charAt(0).toUpperCase() + f.status.slice(1)}`;
    case 'jenis': return `Jenis Transaksi: ${f.jenis === 'masuk' ? 'Barang Masuk' : 'Barang Keluar'}`;
    default: return '';
  }
}

function kdsRemoveFilter(key) {
  const clearMap = {
    barang: () => { delete kdsAppliedFilters.barang; kdsSelBarang && kdsSelBarang.reset(); },
    supplier: () => { delete kdsAppliedFilters.supplier; kdsSelSupplier && kdsSelSupplier.reset(); },
    pemilik: () => { delete kdsAppliedFilters.pemilik; kdsSelPemilik && kdsSelPemilik.reset(); },
    lokasi: () => { delete kdsAppliedFilters.lokasi; kdsSelLokasi && kdsSelLokasi.reset(); },
    operator: () => { delete kdsAppliedFilters.operator; kdsSelOperator && kdsSelOperator.reset(); },
    dari: () => { delete kdsAppliedFilters.dari; const el = document.getElementById('kds-tanggal-dari'); if (el) el.value = ''; },
    sampai: () => { delete kdsAppliedFilters.sampai; const el = document.getElementById('kds-tanggal-sampai'); if (el) el.value = ''; },
    status: () => { delete kdsAppliedFilters.status; const el = document.getElementById('kds-status-stok'); if (el) el.value = 'semua'; },
    jenis: () => { delete kdsAppliedFilters.jenis; const el = document.getElementById('kds-jenis-transaksi'); if (el) el.value = 'semua'; },
  };
  if (clearMap[key]) clearMap[key]();
  kdsPage = 1;
  renderKdsResults();
}

function kdsRenderActiveFilters() {
  const wrap = document.getElementById('kds-active-filters');
  const clearAllBtn = document.getElementById('kds-btn-clear-all');
  if (!wrap) return;
  const keys = Object.keys(kdsAppliedFilters).filter(k => kdsAppliedFilters[k]);
  if (keys.length === 0) {
    wrap.innerHTML = '<span class="kds-no-filter">Belum ada filter yang diterapkan.</span>';
    if (clearAllBtn) clearAllBtn.hidden = true;
    return;
  }
  if (clearAllBtn) clearAllBtn.hidden = false;
  wrap.innerHTML = keys.map(k => `
    <span class="kds-chip" data-key="${k}">
      ${escapeHtml(kdsFilterLabel(k, kdsAppliedFilters))}
      <button type="button" data-remove-key="${k}" aria-label="Hapus filter">&times;</button>
    </span>
  `).join('');
  wrap.querySelectorAll('[data-remove-key]').forEach(btn => {
    btn.addEventListener('click', () => kdsRemoveFilter(btn.dataset.removeKey));
  });
}

function kdsRenderPagination(totalPages, totalItems) {
  const controls = document.getElementById('kds-page-controls');
  const info = document.getElementById('kds-page-info');
  if (!controls || !info) return;

  const startItem = totalItems === 0 ? 0 : (kdsPage - 1) * kdsPageSize + 1;
  const endItem = Math.min(kdsPage * kdsPageSize, totalItems);
  info.textContent = `Menampilkan ${startItem.toLocaleString('id-ID')} - ${endItem.toLocaleString('id-ID')} dari ${totalItems.toLocaleString('id-ID')} hasil`;

  controls.innerHTML = '';
  const mkBtn = (label, page, opts = {}) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'kds-page-btn' + (opts.active ? ' is-active' : '');
    b.textContent = label;
    b.disabled = !!opts.disabled;
    if (!opts.disabled) b.addEventListener('click', () => { kdsPage = page; renderKdsResults(); });
    return b;
  };

  controls.appendChild(mkBtn('«', kdsPage - 1, { disabled: kdsPage <= 1 }));
  const maxButtons = 5;
  let start = Math.max(1, kdsPage - Math.floor(maxButtons / 2));
  let end = Math.min(totalPages, start + maxButtons - 1);
  start = Math.max(1, end - maxButtons + 1);
  for (let p = start; p <= end; p++) {
    controls.appendChild(mkBtn(String(p), p, { active: p === kdsPage }));
  }
  controls.appendChild(mkBtn('»', kdsPage + 1, { disabled: kdsPage >= totalPages }));
}

// Label + kelas badge untuk status stok (tersedia/menipis/habis), dipakai
// bareng oleh kolom "Stok Saat Ini" di tabel Katalog & Stok maupun filter
// Status Stok, supaya keduanya selalu konsisten satu sama lain.
function kdsStatusLabel(level) {
  return level === 'habis' ? 'Habis' : level === 'menipis' ? 'Menipis' : 'Tersedia';
}

// Build HTML row dari SATU transaksi individual (masuk ATAU keluar) — gaya
// Excel: tabel menampilkan semua transaksi apa adanya per baris, tanpa
// digabung/diagregat dulu. Tombol "Detail" tetap membuka popup gabungan
// (kombinasi Kode Barang + Supplier + Pemilik + Lokasi) lewat
// openKdsDetailModalForCombo, supaya ringkasan kombinasi masih bisa dilihat
// kalau dibutuhkan.
// t = 1 baris transaksi { jenis, namaBarang, kodeBarang, supplier, pemilik, lokasi, tanggal, jumlah, jumlahPallet, operator }
function kdsBuildRow(t) {
  const isMasuk = t.jenis === 'masuk';
  const comboKey = `${t.kodeBarang}||${t.supplier}||${t.pemilik}||${t.lokasi}`;
  const palletDisplay = t.jumlahPallet ? roundPalletDisplay(t.jumlahPallet) : '0';

  return `
    <tr>
      <td><span class="badge-jenis ${isMasuk ? 'badge-masuk' : 'badge-keluar'}">${isMasuk ? 'MASUK' : 'KELUAR'}</span></td>
      <td class="kds-th-nama">
        <div class="kds-item-box">
          <span class="kds-item-icon">📦</span>
          <div>
            <div class="kds-item-nama">${escapeHtml(t.namaBarang || '-')}</div>
            <div class="kds-item-kode">Kode Barang: ${escapeHtml(t.kodeBarang || '-')}</div>
          </div>
        </div>
      </td>
      <td>${escapeHtml(t.supplier || '-')}</td>
      <td>${escapeHtml(t.pemilik || '-')}</td>
      <td class="mono">${escapeHtml(t.lokasi || '-')}</td>
      <td>${t.tanggal ? formatTanggal(t.tanggal) : '-'}</td>
      <td class="kds-td-num">${(t.jumlah || 0).toLocaleString('id-ID')} pcs</td>
      <td class="kds-td-num">${palletDisplay} pallet</td>
      <td>
        <span class="akun-operator-avatar kds-avatar-sm">${escapeHtml(getInitials(t.operator))}</span>
        ${escapeHtml(t.operator || '-')}
      </td>
      <td class="kds-th-aksi">
        <button type="button" class="kds-btn-detail" data-combo-key="${escapeHtml(comboKey)}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>
          Detail
        </button>
      </td>
    </tr>
  `;
}

function renderKdsResults() {
  const tbody = document.getElementById('kds-table-body');
  const empty = document.getElementById('kds-empty');
  const tableWrap = document.getElementById('kds-table-wrap');
  const countBadge = document.getElementById('kds-result-count');
  if (!tbody) return;

  // Tampilkan SEMUA transaksi (masuk & keluar) sebagai baris individual —
  // gaya Excel, tanpa digabung/diagregat per kombinasi dulu. Ringkasan
  // kombinasi tetap bisa dilihat lewat popup "Detail" per baris.
  const allTransactions = kdsGetArrivalRows();
  const filtered = kdsSortRows(kdsApplyFilters(allTransactions, kdsAppliedFilters), kdsSortMode);

  countBadge.textContent = `${filtered.length.toLocaleString('id-ID')} hasil`;

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    tableWrap.hidden = true;
    empty.hidden = false;
  } else {
    tableWrap.hidden = false;
    empty.hidden = true;
    const totalPages = Math.max(1, Math.ceil(filtered.length / kdsPageSize));
    if (kdsPage > totalPages) kdsPage = totalPages;
    const startIdx = (kdsPage - 1) * kdsPageSize;
    const pageRows = filtered.slice(startIdx, startIdx + kdsPageSize);
    tbody.innerHTML = pageRows.map(kdsBuildRow).join('');
    tbody.querySelectorAll('[data-combo-key]').forEach(btn => {
      btn.addEventListener('click', () => openKdsDetailModalForCombo(btn.dataset.comboKey));
    });
    kdsRenderPagination(totalPages, filtered.length);
  }

  // Ringkasan hasil filter — dihitung dari transaksi individual yang terfilter
  const totalPcsMasuk = filtered.filter(t => t.jenis === 'masuk').reduce((s, t) => s + (t.jumlah || 0), 0);
  const totalPcsKeluar = filtered.filter(t => t.jenis === 'keluar').reduce((s, t) => s + (t.jumlah || 0), 0);
  const lokasiSet = new Set(filtered.map(t => t.lokasi).filter(Boolean));
  setText('kds-sum-pcs', `${totalPcsMasuk.toLocaleString('id-ID')} pcs`);
  setText('kds-sum-pcs-keluar', `${totalPcsKeluar.toLocaleString('id-ID')} pcs`);
  setText('kds-sum-kedatangan', `${filtered.length.toLocaleString('id-ID')} transaksi`);
  setText('kds-sum-lokasi', `${lokasiSet.size.toLocaleString('id-ID')} lokasi`);

  // Stok Saat Ini (Total) — jumlahkan stok NET per kombinasi UNIK (Kode
  // Barang + Supplier + Pemilik + Lokasi) yang muncul di hasil filter.
  // Dihitung dari SELURUH transaksi (bukan cuma yang lolos filter), supaya
  // angka stok tetap akurat walau filter tanggal/jenis mempersempit tampilan.
  const uniqueCombos = new Map();
  filtered.forEach(t => {
    const key = `${t.kodeBarang}||${t.supplier}||${t.pemilik}||${t.lokasi}`;
    if (!uniqueCombos.has(key)) uniqueCombos.set(key, t);
  });
  const totalStokSaatIni = Array.from(uniqueCombos.values())
    .reduce((s, t) => s + getStokKombinasi(currentEntries, t.kodeBarang, t.supplier, t.pemilik, t.lokasi), 0);
  setText('kds-sum-stok-saat-ini', `${totalStokSaatIni.toLocaleString('id-ID')} pcs`);

  kdsRenderActiveFilters();
}

function kdsReadFiltersFromInputs() {
  const f = {};
  const barang = kdsSelBarang && kdsSelBarang.getValue();
  const supplier = kdsSelSupplier && kdsSelSupplier.getValue();
  const pemilik = kdsSelPemilik && kdsSelPemilik.getValue();
  const lokasi = kdsSelLokasi && kdsSelLokasi.getValue();
  const operator = kdsSelOperator && kdsSelOperator.getValue();
  const dari = document.getElementById('kds-tanggal-dari')?.value || '';
  const sampai = document.getElementById('kds-tanggal-sampai')?.value || '';
  const status = document.getElementById('kds-status-stok')?.value || 'semua';
  const jenis = document.getElementById('kds-jenis-transaksi')?.value || 'semua';
  if (barang) f.barang = barang;
  if (supplier) f.supplier = supplier;
  if (pemilik) f.pemilik = pemilik;
  if (lokasi) f.lokasi = lokasi;
  if (operator) f.operator = operator;
  if (dari) f.dari = dari;
  if (sampai) f.sampai = sampai;
  if (status && status !== 'semua') f.status = status;
  if (jenis && jenis !== 'semua') f.jenis = jenis;
  return f;
}

function kdsResetFilterInputs() {
  kdsSelBarang && kdsSelBarang.reset();
  kdsSelSupplier && kdsSelSupplier.reset();
  kdsSelPemilik && kdsSelPemilik.reset();
  kdsSelLokasi && kdsSelLokasi.reset();
  kdsSelOperator && kdsSelOperator.reset();
  const dari = document.getElementById('kds-tanggal-dari');
  const sampai = document.getElementById('kds-tanggal-sampai');
  const status = document.getElementById('kds-status-stok');
  const jenis = document.getElementById('kds-jenis-transaksi');
  if (dari) dari.value = '';
  if (sampai) sampai.value = '';
  if (status) status.value = 'semua';
  if (jenis) jenis.value = 'semua';
}

// Refresh opsi dropdown filter dari data terbaru (barang/supplier/pemilik/
// lokasi bisa berubah lewat menu Pengelolaan Barang, operator bisa
// bertambah lewat laporan baru) — dipanggil tiap kali panel dibuka.
function kdsRefreshFilterOptions() {
  if (!kdsSelBarang) return;
  kdsSelBarang.updateOptions(BARANG_OPTIONS);
  kdsSelSupplier.updateOptions(MASTER_DATA.supplier || []);
  kdsSelPemilik.updateOptions(rebuildPemilikOptions());
  kdsSelLokasi.updateOptions(LOKASI_OPTIONS);
  const operatorNames = Array.from(new Set(currentEntries.filter(t => (t.jenis === 'masuk' || t.jenis === 'keluar') && t.operator).map(t => t.operator))).sort((a, b) => a.localeCompare(b));
  kdsSelOperator.updateOptions(operatorNames);
}

function renderKdsPanel() {
  if (currentRole() !== 'admin') return;
  kdsRefreshFilterOptions();
  renderKdsResults();
}

const kdsBtnTerapkan = document.getElementById('kds-btn-terapkan');
if (kdsBtnTerapkan) {
  kdsBtnTerapkan.addEventListener('click', () => {
    kdsAppliedFilters = kdsReadFiltersFromInputs();
    kdsPage = 1;
    renderKdsResults();
  });
}

const kdsBtnReset = document.getElementById('kds-btn-reset');
if (kdsBtnReset) {
  kdsBtnReset.addEventListener('click', () => {
    kdsResetFilterInputs();
    kdsAppliedFilters = {};
    kdsPage = 1;
    renderKdsResults();
  });
}

const kdsBtnClearAll = document.getElementById('kds-btn-clear-all');
if (kdsBtnClearAll) {
  kdsBtnClearAll.addEventListener('click', () => {
    kdsResetFilterInputs();
    kdsAppliedFilters = {};
    kdsPage = 1;
    renderKdsResults();
  });
}

const kdsBtnSimpan = document.getElementById('kds-btn-simpan');
if (kdsBtnSimpan) {
  kdsBtnSimpan.addEventListener('click', () => {
    const current = kdsReadFiltersFromInputs();
    if (Object.keys(current).length === 0) {
      showToast('Pilih setidaknya satu filter dulu sebelum disimpan.', 'error');
      return;
    }
    showToast('Filter ini tersimpan untuk sesi Anda saat ini.');
  });
}

const kdsSortSelect = document.getElementById('kds-sort');
if (kdsSortSelect) {
  kdsSortSelect.addEventListener('change', () => {
    kdsSortMode = kdsSortSelect.value;
    kdsPage = 1;
    renderKdsResults();
  });
}

const kdsPageSizeSelect = document.getElementById('kds-page-size');
if (kdsPageSizeSelect) {
  kdsPageSizeSelect.addEventListener('change', () => {
    kdsPageSize = parseInt(kdsPageSizeSelect.value, 10) || 10;
    kdsPage = 1;
    renderKdsResults();
  });
}

const kdsBtnExport = document.getElementById('kds-btn-export');
if (kdsBtnExport) {
  kdsBtnExport.addEventListener('click', () => {
    const rows = kdsSortRows(kdsApplyFilters(kdsGetArrivalRows(), kdsAppliedFilters), kdsSortMode);
    if (rows.length === 0) {
      showToast('Tidak ada data untuk diunduh.', 'error');
      return;
    }
    const aoa = [
      ['Nama Barang', 'Jenis', 'Kode Barang', 'Supplier', 'Pemilik Barang', 'Jumlah PCS', 'Jumlah Pallet', 'Lokasi', 'Tanggal Kedatangan', 'Tanggal Penginputan', 'Operator Input'],
      ...rows.map(t => [
        t.namaBarang || '-', t.jenis === 'masuk' ? 'Masuk' : 'Keluar', t.kodeBarang || '-', t.supplier || '-', t.pemilik || '-',
        t.jumlah || 0, t.jumlahPallet ? roundPalletDisplay(t.jumlahPallet) : 0,
        t.lokasi || '-',
        t.jenis === 'masuk' ? formatTanggal(t.tanggal) : '-',
        t.jenis === 'keluar' ? formatTanggal(t.tanggal) : '-',
        t.operator || '-',
      ]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Katalog & Stok');
    XLSX.writeFile(wb, `katalog-stok-${todayISO()}.xlsx`);
  });
}

/* ---- MODAL: DETAIL KEDATANGAN BARANG ---- */
const kdsDetailModal = document.getElementById('kds-detail-modal');
const kdsDetailBody = document.getElementById('kds-detail-body');
const kdsRiwayatModal = document.getElementById('kds-riwayat-modal');
const kdsRiwayatBody = document.getElementById('kds-riwayat-body');

function closeKdsDetailModal() { if (kdsDetailModal) kdsDetailModal.hidden = true; }
function closeKdsRiwayatModal() { if (kdsRiwayatModal) kdsRiwayatModal.hidden = true; }

if (kdsDetailModal) {
  document.getElementById('kds-detail-close').addEventListener('click', closeKdsDetailModal);
  kdsDetailModal.addEventListener('click', (e) => { if (e.target === kdsDetailModal) closeKdsDetailModal(); });
}
if (kdsRiwayatModal) {
  document.getElementById('kds-riwayat-close').addEventListener('click', closeKdsRiwayatModal);
  kdsRiwayatModal.addEventListener('click', (e) => { if (e.target === kdsRiwayatModal) closeKdsRiwayatModal(); });
}

// PERUBAHAN: Fungsi baru untuk membuka detail modal dari kombinasi barang
// (bukan dari transaksi individual). Menampilkan ringkasan kombinasi + button ke riwayat.
function openKdsDetailModalForCombo(comboKey) {
  if (!kdsDetailBody || !comboKey) return;
  
  // Parse key format: "kodeBarang||supplier||pemilik||lokasi"
  const parts = comboKey.split('||');
  if (parts.length < 4) return;
  
  const kodeBarang = parts[0];
  const supplier = parts[1];
  const pemilik = parts[2];
  const lokasi = parts[3];
  
  // Cari transaksi pertama untuk kombinasi ini (untuk nama barang, dll)
  const firstTx = currentEntries.find(t =>
    t.kodeBarang === kodeBarang && t.supplier === supplier &&
    t.pemilik === pemilik && t.lokasi === lokasi
  );
  if (!firstTx) return;
  
  // Hitung statistik kombinasi
  const stats = kdsBuildCombinationStats({
    kodeBarang, namaBarang: firstTx.namaBarang, supplier, pemilik, lokasi
  });
  
  kdsDetailBody.innerHTML = `
    <div class="kds-modal-head">
      <div class="kds-modal-head-icon">📦</div>
      <div class="kds-modal-head-info">
        <div class="kds-mh-nama">${escapeHtml(firstTx.namaBarang || '-')}</div>
        <div class="kds-mh-row"><strong>Kode Barang</strong><br>${escapeHtml(kodeBarang || '-')}</div>
        <div class="kds-mh-row"><strong>Supplier</strong><br>${escapeHtml(supplier || '-')}</div>
        <div class="kds-mh-row"><strong>Pemilik Barang</strong><br>📍 ${escapeHtml(pemilik || '-')}</div>
        <div class="kds-mh-row"><strong>Lokasi Rak</strong><br>📍 ${escapeHtml(lokasi || '-')}</div>
      </div>
    </div>

    <div class="kds-detail-section">
      <div class="kds-detail-section-title" style="border-top:none; padding-top:0;">Ringkasan Stok</div>
      <div class="kds-detail-grid">
        <div class="kds-detail-item">
          <span>Total Masuk</span>
          <strong>${(stats.totalMasuk || 0).toLocaleString('id-ID')} pcs</strong>
        </div>
        <div class="kds-detail-item">
          <span>Total Keluar</span>
          <strong>${(stats.totalKeluar || 0).toLocaleString('id-ID')} pcs</strong>
        </div>
        <div class="kds-detail-item">
          <span>Stok Saat Ini</span>
          <strong class="kds-stok-highlight">${stats.stokSaatIni.toLocaleString('id-ID')} pcs</strong>
        </div>
        <div class="kds-detail-item">
          <span>Total Pallet</span>
          <strong>${stats.totalPallet ? roundPalletDisplay(stats.totalPallet) : 0} pallet</strong>
        </div>
        <div class="kds-detail-item">
          <span>Status Stok</span>
          <strong>
            <span class="kds-stok-badge ${stats.status}" style="display:inline-block;">
              ${stats.status === 'habis' ? 'Habis' : stats.status === 'menipis' ? 'Menipis' : 'Tersedia'}
            </span>
          </strong>
        </div>
        <div class="kds-detail-item">
          <span>Jumlah Transaksi</span>
          <strong>${stats.transactionCount.toLocaleString('id-ID')} transaksi</strong>
        </div>
      </div>
    </div>

    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="kds-btn-lihat-riwayat-combo">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>
        Lihat Riwayat Lengkap
      </button>
      <button type="button" class="btn-secondary modal-cancel" id="kds-btn-tutup-detail">Tutup</button>
    </div>
  `;
  kdsDetailBody.querySelector('#kds-btn-tutup-detail').addEventListener('click', closeKdsDetailModal);
  kdsDetailBody.querySelector('#kds-btn-lihat-riwayat-combo').addEventListener('click', () => {
    openKdsRiwayatModalForCombo(kodeBarang, supplier, pemilik, lokasi);
  });

  kdsDetailModal.hidden = false;
}

function openKdsDetailModal(entryId) {
  const t = currentEntries.find(e => e.id === entryId);
  if (!t || !kdsDetailBody) return;

  const isMasuk = t.jenis === 'masuk';
  kdsDetailBody.innerHTML = `
    <div class="kds-modal-head">
      <div class="kds-modal-head-icon">📦</div>
      <div class="kds-modal-head-info">
        <div class="kds-mh-nama">
          ${escapeHtml(t.namaBarang || '-')}
          <span class="badge-jenis ${isMasuk ? 'badge-masuk' : 'badge-keluar'}" style="margin-left:8px;">${isMasuk ? 'MASUK' : 'KELUAR'}</span>
        </div>
        <div class="kds-mh-row"><strong>Kode Barang</strong><br>${escapeHtml(t.kodeBarang || '-')}</div>
        <div class="kds-mh-row"><strong>Supplier</strong><br>${escapeHtml(t.supplier || '-')}</div>
        <div class="kds-mh-row"><strong>Pemilik Barang</strong><br>📍 ${escapeHtml(t.pemilik || '-')}</div>
      </div>
    </div>

    <div class="kds-detail-section">
      <div class="kds-detail-section-title" style="border-top:none; padding-top:0;">${isMasuk ? 'Detail Kedatangan' : 'Detail Barang Keluar'}</div>
      <div class="kds-detail-grid">
        <div class="kds-detail-item">
          <span>${isMasuk ? 'Tanggal Kedatangan' : 'Tanggal Penginputan'}</span>
          <strong>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
            ${formatTanggal(t.tanggal)}
          </strong>
        </div>
        <div class="kds-detail-item">
          <span>Lokasi Rak</span>
          <strong>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
            ${escapeHtml(t.lokasi || '-')}
          </strong>
        </div>
        <div class="kds-detail-item">
          <span>Jumlah PCS</span>
          <strong>${(t.jumlah || 0).toLocaleString('id-ID')} pcs</strong>
        </div>
        <div class="kds-detail-item">
          <span>PCS per Pallet</span>
          <strong>${t.qtyPerPallet ? Number(t.qtyPerPallet).toLocaleString('id-ID') : '-'} pcs/pallet</strong>
        </div>
        <div class="kds-detail-item">
          <span>Total Pallet</span>
          <strong>${t.jumlahPallet ? roundPalletDisplay(t.jumlahPallet) : 0} pallet</strong>
        </div>
        <div class="kds-detail-item">
          <span>Operator Input</span>
          <strong>
            <span class="akun-operator-avatar kds-avatar-sm">${escapeHtml(getInitials(t.operator))}</span>
            ${escapeHtml(t.operator || '-')}
          </strong>
        </div>
      </div>
    </div>

    <div class="kds-detail-section">
      <div class="kds-detail-section-title">Catatan</div>
      <p class="kds-detail-note">${t.keterangan ? escapeHtml(t.keterangan) : '-'}</p>
    </div>

    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="kds-btn-lihat-riwayat">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>
        Riwayat Kedatangan
      </button>
      <button type="button" class="btn-secondary modal-cancel" id="kds-btn-tutup-detail">Tutup</button>
    </div>
  `;
  kdsDetailBody.querySelector('#kds-btn-tutup-detail').addEventListener('click', closeKdsDetailModal);
  kdsDetailBody.querySelector('#kds-btn-lihat-riwayat').addEventListener('click', () => {
    openKdsRiwayatModal(t.kodeBarang, t.supplier, t.pemilik);
  });

  kdsDetailModal.hidden = false;
}

// PERUBAHAN: Fungsi baru untuk menampilkan riwayat LENGKAP kombinasi (masuk + keluar)
// dengan parameter lokasi. Dipanggil dari detail modal kombinasi.
function openKdsRiwayatModalForCombo(kodeBarang, supplier, pemilik, lokasi) {
  if (!kdsRiwayatBody) return;
  
  // Ambil SEMUA transaksi (masuk + keluar) untuk kombinasi ini
  const allHistory = currentEntries
    .filter(t => t.kodeBarang === kodeBarang && t.supplier === supplier && 
                  t.pemilik === pemilik && t.lokasi === lokasi)
    .sort((a, b) => (b.tanggal || '').localeCompare(a.tanggal || '') || b.createdAt - a.createdAt);
  
  const first = allHistory[0] || currentEntries.find(t => t.kodeBarang === kodeBarang);
  const namaBarang = first ? first.namaBarang : kodeBarang;
  
  const totalPcsMasuk = allHistory
    .filter(t => t.jenis === 'masuk')
    .reduce((s, t) => s + (t.jumlah || 0), 0);
  const totalPcsKeluar = allHistory
    .filter(t => t.jenis === 'keluar')
    .reduce((s, t) => s + (t.jumlah || 0), 0);
  const totalPallet = allHistory
    .filter(t => t.jumlahPallet != null)
    .reduce((s, t) => s + (t.jenis === 'masuk' ? t.jumlahPallet : -t.jumlahPallet), 0);
  
  kdsRiwayatBody.innerHTML = `
    <div class="kds-modal-head">
      <div class="kds-modal-head-icon">📦</div>
      <div class="kds-modal-head-info">
        <div class="kds-mh-nama">${escapeHtml(namaBarang || '-')}</div>
        <div class="kds-mh-row"><strong>Kode Barang</strong><br>${escapeHtml(kodeBarang || '-')}</div>
        <div class="kds-mh-row"><strong>Supplier</strong><br>${escapeHtml(supplier || '-')}</div>
        <div class="kds-mh-row"><strong>Pemilik Barang</strong><br>${escapeHtml(pemilik || '-')}</div>
        <div class="kds-mh-row"><strong>Lokasi Rak</strong><br>${escapeHtml(lokasi || '-')}</div>
      </div>
    </div>

    <div class="kds-detail-section-title" style="border-top:none; padding-top:0;">Riwayat Transaksi (${allHistory.length.toLocaleString('id-ID')})</div>
    <div class="kds-riwayat-table-wrap">
      <table class="kds-riwayat-table">
        <thead>
          <tr>
            <th>No</th>
            <th>Jenis</th>
            <th>Tanggal</th>
            <th>Jumlah PCS</th>
            <th>PCS/Pallet</th>
            <th>Total Pallet</th>
            <th>Operator Input</th>
          </tr>
        </thead>
        <tbody>
          ${allHistory.length ? allHistory.map((t, i) => `
            <tr>
              <td>${i + 1}</td>
              <td><span class="badge-jenis ${t.jenis === 'masuk' ? 'badge-masuk' : 'badge-keluar'}">${t.jenis === 'masuk' ? 'MASUK' : 'KELUAR'}</span></td>
              <td>${formatTanggal(t.tanggal)}</td>
              <td>${(t.jumlah || 0).toLocaleString('id-ID')} pcs</td>
              <td>${t.qtyPerPallet ? Number(t.qtyPerPallet).toLocaleString('id-ID') : '-'}</td>
              <td>${t.jumlahPallet ? roundPalletDisplay(t.jumlahPallet) : '-'}</td>
              <td>${escapeHtml(t.operator || '-')}</td>
            </tr>
          `).join('') : `<tr><td colspan="7" class="empty-state">Belum ada transaksi.</td></tr>`}
        </tbody>
      </table>
    </div>

    <div class="kds-summary-panel">
      <div class="kds-summary-grid">
        <div class="kds-summary-item"><span>Total Transaksi</span><strong>${allHistory.length.toLocaleString('id-ID')} kali</strong></div>
        <div class="kds-summary-item"><span>Total PCS Masuk</span><strong>${totalPcsMasuk.toLocaleString('id-ID')} pcs</strong></div>
        <div class="kds-summary-item"><span>Total PCS Keluar</span><strong>${totalPcsKeluar.toLocaleString('id-ID')} pcs</strong></div>
        <div class="kds-summary-item"><span>Saldo Pallet</span><strong>${roundPalletDisplay(totalPallet)} pallet</strong></div>
      </div>
    </div>

    <div class="modal-actions">
      <button type="button" class="btn-secondary modal-cancel" id="kds-btn-tutup-riwayat">Tutup</button>
    </div>
  `;
  kdsRiwayatBody.querySelector('#kds-btn-tutup-riwayat').addEventListener('click', closeKdsRiwayatModal);

  kdsRiwayatModal.hidden = false;
}

/* ---- MODAL: RIWAYAT KEDATANGAN BARANG ---- */
function openKdsRiwayatModal(kodeBarang, supplier, pemilik) {
  if (!kdsRiwayatBody) return;
  const history = currentEntries
    .filter(t => t.jenis === 'masuk' && t.kodeBarang === kodeBarang && t.supplier === supplier && t.pemilik === pemilik)
    .sort((a, b) => (b.tanggal || '').localeCompare(a.tanggal || '') || b.createdAt - a.createdAt);

  const first = history[0] || currentEntries.find(t => t.kodeBarang === kodeBarang);
  const namaBarang = first ? first.namaBarang : kodeBarang;

  const totalPcs = history.reduce((s, t) => s + (t.jumlah || 0), 0);
  const totalPallet = history.reduce((s, t) => s + (t.jumlahPallet || 0), 0);
  const lokasiSet = new Set(history.map(t => t.lokasi).filter(Boolean));

  kdsRiwayatBody.innerHTML = `
    <div class="kds-modal-head">
      <div class="kds-modal-head-icon">📦</div>
      <div class="kds-modal-head-info">
        <div class="kds-mh-nama">${escapeHtml(namaBarang || '-')}</div>
        <div class="kds-mh-row"><strong>Kode Barang</strong><br>${escapeHtml(kodeBarang || '-')}</div>
        <div class="kds-mh-row"><strong>Supplier</strong><br>${escapeHtml(supplier || '-')}</div>
        <div class="kds-mh-row"><strong>Pemilik Barang</strong><br>${escapeHtml(pemilik || '-')}</div>
      </div>
    </div>

    <div class="kds-detail-section-title" style="border-top:none; padding-top:0;">Riwayat Kedatangan (${history.length.toLocaleString('id-ID')})</div>
    <div class="kds-riwayat-table-wrap">
      <table class="kds-riwayat-table">
        <thead>
          <tr>
            <th>No</th>
            <th>Tanggal Kedatangan</th>
            <th>Lokasi Rak</th>
            <th>Jumlah PCS</th>
            <th>PCS/Pallet</th>
            <th>Total Pallet</th>
            <th>Operator Input</th>
          </tr>
        </thead>
        <tbody>
          ${history.length ? history.map((t, i) => `
            <tr>
              <td>${i + 1}</td>
              <td>${formatTanggal(t.tanggal)}</td>
              <td class="mono">${escapeHtml(t.lokasi || '-')}</td>
              <td>${(t.jumlah || 0).toLocaleString('id-ID')} pcs</td>
              <td>${t.qtyPerPallet ? Number(t.qtyPerPallet).toLocaleString('id-ID') : '-'}</td>
              <td>${t.jumlahPallet ? roundPalletDisplay(t.jumlahPallet) : '-'}</td>
              <td>${escapeHtml(t.operator || '-')}</td>
            </tr>
          `).join('') : `<tr><td colspan="7" class="empty-state">Belum ada riwayat kedatangan.</td></tr>`}
        </tbody>
      </table>
    </div>

    <div class="kds-summary-panel">
      <div class="kds-summary-grid">
        <div class="kds-summary-item"><span>Total Kedatangan</span><strong>${history.length.toLocaleString('id-ID')} kali</strong></div>
        <div class="kds-summary-item"><span>Total PCS</span><strong>${totalPcs.toLocaleString('id-ID')} pcs</strong></div>
        <div class="kds-summary-item"><span>Total Pallet</span><strong>${roundPalletDisplay(totalPallet)} pallet</strong></div>
        <div class="kds-summary-item"><span>Lokasi Tersebar</span><strong>${lokasiSet.size.toLocaleString('id-ID')} lokasi</strong></div>
      </div>
    </div>

    <div class="modal-actions">
      <button type="button" class="btn-secondary modal-cancel" id="kds-btn-tutup-riwayat">Tutup</button>
    </div>
  `;
  kdsRiwayatBody.querySelector('#kds-btn-tutup-riwayat').addEventListener('click', closeKdsRiwayatModal);

  kdsRiwayatModal.hidden = false;
}

// Kunci/buka tombol dropdown Supplier & Pemilik. Dikunci saat mode KELUAR
// dan barang sudah dipilih — supaya operator TIDAK bisa mengetik bebas
// kombinasi supplier/pemilik sendiri, harus lewat kartu "Stok Tersedia".
function setSupplierPemilikLocked(locked) {
  const supplierBtn = document.getElementById('sel-supplier-btn');
  const pemilikBtn = document.getElementById('sel-pemilik-btn');
  [supplierBtn, pemilikBtn].forEach(b => { if (b) b.disabled = !!locked; });
}

// Render kartu "Stok Tersedia" — daftar kombinasi supplier+pemilik+lokasi
// (beserta sisa stok & pallet) untuk barang yang dipilih. Hanya tampil
// saat jenis === 'keluar'. Klik satu kartu = mengikat supplier+pemilik
// sekaligus (lokasi tetap wajib dikonfirmasi lewat scan barcode fisik,
// supaya tetap ada verifikasi barang benar-benar ada di rak tsb).
function refreshKombinasiUI(kodeBarang) {
  const box = document.getElementById('kombinasi-box');
  const list = document.getElementById('kombinasi-list');
  if (!box || !list) return;

  if (jenis !== 'keluar' || !kodeBarang) {
    box.hidden = true;
    list.innerHTML = '';
    setSupplierPemilikLocked(false);
    return;
  }

  const combos = getKombinasiTersedia(currentEntries, kodeBarang);
  box.hidden = false;
  setSupplierPemilikLocked(true);

  if (combos.length === 0) {
    list.innerHTML = '<div class="no-result">Belum ada stok barang ini yang tercatat masuk dengan kombinasi supplier/pemilik/lokasi apa pun. Barang keluar tidak bisa dilaporkan.</div>';
    return;
  }

  list.innerHTML = combos.map((c, i) => {
    // Rincian per batch kedatangan (FIFO) yang masih tersisa dalam stok
    // gabungan ini — supaya operator tidak bingung "stok segini datangnya
    // dari kapan aja", terutama kalau kombinasi ini pernah kedatangan
    // lebih dari sekali di tanggal yang berbeda-beda.
    const breakdown = getBatchBreakdownKombinasi(currentEntries, kodeBarang, c.supplier, c.pemilik, c.lokasi);
    const breakdownHtml = breakdown.length > 1
      ? `<div class="kombinasi-chip-batch-list">
          ${breakdown.map(b => `<div class="kombinasi-chip-batch-item">📅 ${formatTanggal(b.tanggal)} <span class="kombinasi-chip-sep">→</span> ${b.sisa.toLocaleString('id-ID')} pcs</div>`).join('')}
        </div>`
      : `<span class="kombinasi-chip-sub">📅 Datang: ${c.tanggalKedatangan ? formatTanggal(c.tanggalKedatangan) : '-'}</span>`;
    return `
    <button type="button" class="kombinasi-chip" data-idx="${i}">
      <span class="kombinasi-chip-main">🏭 ${escapeHtml(c.supplier)} <span class="kombinasi-chip-sep">·</span> 🏢 ${escapeHtml(c.pemilik)}</span>
      <span class="kombinasi-chip-sub">📍 ${escapeHtml(c.lokasi)} <span class="kombinasi-chip-sep">·</span> <b>${c.stok.toLocaleString('id-ID')} pcs</b>${c.pallet ? ` <span class="kombinasi-chip-sep">·</span> ${roundPalletDisplay(c.pallet)} pallet` : ''}</span>
      ${breakdownHtml}
    </button>
  `;
  }).join('');

  list.querySelectorAll('.kombinasi-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const c = combos[Number(btn.dataset.idx)];
      kombinasiTerkunci = c;
      selSupplier.setValue(c.supplier);
      selPemilik.setValue(c.pemilik);
      selLokasi.reset();

      // CATATAN: field Tanggal SENGAJA TIDAK ikut diisi otomatis dengan
      // tanggal kedatangan kombinasi yang dipilih. Untuk laporan KELUAR,
      // field tersebut berarti "Tanggal Penginputan" (tanggal form ini
      // dilaporkan) — konsepnya beda dari tanggal kedatangan batch stok,
      // jadi keduanya tidak boleh saling menimpa. Tanggal kedatangan batch
      // tetap terlihat di kartu kombinasi ini ("📅 Datang: ...").
      //
      // Jumlah Barang SENGAJA TIDAK diisi otomatis (walau tersedia di data
      // c.stok) — operator WAJIB mengetik sendiri jumlah pcs yang benar-benar
      // keluar. Ini untuk menghindari risiko operator lupa mengubah angka
      // dan tanpa sadar melaporkan SELURUH sisa stok sebagai keluar padahal
      // yang keluar sebenarnya cuma sebagian.

      list.querySelectorAll('.kombinasi-chip').forEach(b => b.classList.remove('is-selected'));
      btn.classList.add('is-selected');
      showToast(`Kombinasi dipilih (sisa stok ${Number(c.stok || 0).toLocaleString('id-ID')} pcs). Masukkan jumlah pcs yang keluar, lalu scan barcode lokasi ${c.lokasi} untuk konfirmasi.`, 'info');
    });
  });
}

// Lokasi Penyimpanan BUKAN dropdown pilihan manual — nilainya hanya bisa
// diisi lewat hasil scan barcode (lihat onScanSuccess di bawah).
const lokasiValueEl = document.getElementById('sel-lokasi-value');
const capacityInfoBox = document.getElementById('capacity-info');

// Fungsi untuk memperbarui display kapasitas pallet berdasarkan lokasi SPESIFIK yang dipilih
// Setiap lokasi (A-01-01, B-05-03, dll) punya batas tersendiri: 43 pallet (A-F) atau 47 pallet (G-L)
function updateCapacityDisplay(lokasi) {
  if (!lokasi || !capacityInfoBox) return;
  
  const cek = cekKapasitasBlok(lokasi, 0, currentEntries);
  const capacityCurrentEl = document.getElementById('capacity-current');
  const capacityMaxEl = document.getElementById('capacity-max');
  const capacityRemainingEl = document.getElementById('capacity-remaining');
  const capacityBarFill = document.getElementById('capacity-bar-fill');
  
  if (cek.batas) {
    // Hapus atribut hidden untuk menampilkan info
    capacityInfoBox.removeAttribute('hidden');
    
    // Update nilai kapasitas lokasi
    if (capacityCurrentEl) capacityCurrentEl.textContent = roundPalletDisplay(cek.sekarang);
    if (capacityMaxEl) capacityMaxEl.textContent = cek.batas.toLocaleString('id-ID');
    if (capacityRemainingEl) {
      capacityRemainingEl.textContent = roundPalletDisplay(cek.sisa);
      
      // Update kelas warna berdasarkan persentase penggunaan
      capacityRemainingEl.classList.remove('warning', 'danger');
      const persenTerpakai = (cek.sekarang / cek.batas) * 100;
      if (persenTerpakai >= 90) {
        capacityRemainingEl.classList.add('danger');  // Merah: >90%
      } else if (persenTerpakai >= 70) {
        capacityRemainingEl.classList.add('warning'); // Kuning: 70-89%
      }
      // Hijau (normal): <70% — tidak perlu class khusus
    }
    
    // Update progress bar dengan warna gradient
    if (capacityBarFill) {
      const persenTerpakai = Math.min(100, (cek.sekarang / cek.batas) * 100);
      capacityBarFill.style.width = persenTerpakai + '%';
    }
  } else {
    // Lokasi tidak terdaftar dalam sistem batasan, sembunyikan info
    capacityInfoBox.setAttribute('hidden', '');
  }
}

const selLokasi = {
  _value: null,
  getValue: () => selLokasi._value,
  reset: () => {
    selLokasi._value = null;
    if (lokasiValueEl) {
      lokasiValueEl.textContent = 'Belum di-scan...';
      lokasiValueEl.classList.remove('has-value');
    }
    // Sembunyikan kapasitas info saat lokasi di-reset
    if (capacityInfoBox) capacityInfoBox.setAttribute('hidden', '');
  },
  setValue: (v) => {
    selLokasi._value = v;
    if (lokasiValueEl) {
      lokasiValueEl.textContent = v;
      lokasiValueEl.classList.add('has-value');
    }
    // Update display kapasitas saat lokasi berubah
    updateCapacityDisplay(v);
  },
};

const inputOperator = document.getElementById('input-operator');
const inputTanggal = document.getElementById('input-tanggal');
const inputJumlah = document.getElementById('input-jumlah');
const inputQtyPallet = document.getElementById('input-qty-pallet');
const inputJumlahPallet = document.getElementById('input-jumlah-pallet');
const formError = document.getElementById('form-error');
const form = document.getElementById('form-laporan');

/* ==========================================================================
   FORMAT ANGKA RIBUAN — Jumlah Barang & Qty per Pallet
   Input tetap type="text" (bukan number) supaya bisa menampilkan titik
   pemisah ribuan ala format Indonesia (1.000, bukan 1000) sambil operator
   mengetik. Nilai aslinya (tanpa titik) selalu bisa diambil ulang lewat
   parseFormattedNumber() saat validasi/hitung/simpan.
========================================================================== */
function parseFormattedNumber(str) {
  if (str == null) return NaN;
  const cleaned = String(str).trim().replace(/\./g, '').replace(/,/g, '.');
  if (cleaned === '') return NaN;
  return parseFloat(cleaned);
}

function attachThousandsFormatting(input) {
  input.addEventListener('input', () => {
    const digitsOnly = input.value.replace(/[^\d]/g, '');
    input.value = digitsOnly ? Number(digitsOnly).toLocaleString('id-ID') : '';
  });
}
attachThousandsFormatting(inputJumlah);
attachThousandsFormatting(inputQtyPallet);

function hitungJumlahPallet() {
  const jumlah = parseFormattedNumber(inputJumlah.value);
  const qtyPallet = parseFormattedNumber(inputQtyPallet.value);
  if (!jumlah || !qtyPallet || qtyPallet <= 0) {
    inputJumlahPallet.value = '';
    return;
  }
  const hasil = jumlah / qtyPallet;
  // tampilkan maks 2 angka desimal, buang nol yang tidak perlu, dengan
  // pemisah ribuan juga (mis. 1.250,5)
  const dibulatkan = Math.round(hasil * 100) / 100;
  inputJumlahPallet.value = dibulatkan.toLocaleString('id-ID', { maximumFractionDigits: 2 });
}
inputJumlah.addEventListener('input', hitungJumlahPallet);
inputQtyPallet.addEventListener('input', hitungJumlahPallet);

// Helper untuk menampilkan angka jumlah pallet (bisa desimal, mis. hasil
// bagi jumlah barang / qty per pallet) di kartu Ringkasan. Dibulatkan ke
// maksimal 2 angka desimal dan diformat dengan pemisah ribuan ala Indonesia
// (mis. 1.250,5), sama seperti cara input-jumlah-pallet diisi otomatis di
// hitungJumlahPallet() di atas.
function roundPalletDisplay(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  const dibulatkan = Math.round(num * 100) / 100;
  return dibulatkan.toLocaleString('id-ID', { maximumFractionDigits: 2 });
}

/* ==========================================================================
   SCAN BARCODE — LOKASI (Input Laporan)
========================================================================== */
const btnScanLokasi = document.getElementById('btn-scan-lokasi');
const scanModal = document.getElementById('scan-modal');
const scanModalClose = document.getElementById('scan-modal-close');
const scanStatus = document.getElementById('scan-status');
const scanErrorBox = document.getElementById('scan-error');

// CATATAN: LOKASI_SET TIDAK dideklarasikan ulang di sini — sudah ada di
// baris ~40 (dari MASTER_DATA.lokasi yang sama). Deklarasi kedua yang
// dulu ada di sini menyebabkan SyntaxError yang mematikan seluruh script.
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
  const matched = findMatchingLokasi(decodedText);

  if (matched) {
    // Kalau sedang mode KELUAR dan operator sudah mengunci satu kombinasi
    // (supplier+pemilik) dari kartu "Stok Tersedia", lokasi yang di-scan
    // WAJIB persis sama dengan lokasi kombinasi itu. Ini menutup celah di
    // mana operator bisa memilih kombinasi Gudang 1 tapi scan barcode
    // Gudang 2 — yang akan membuat laporan keluar dengan kombinasi yang
    // sebenarnya tidak pernah tercatat masuk.
    if (jenis === 'keluar' && kombinasiTerkunci && matched !== kombinasiTerkunci.lokasi) {
      scanErrorBox.hidden = false;
      scanErrorBox.textContent = `Barcode ini adalah lokasi "${matched}", tapi kombinasi yang dipilih ada di lokasi "${kombinasiTerkunci.lokasi}". Scan barcode lokasi ${kombinasiTerkunci.lokasi}, atau pilih ulang kombinasi yang sesuai lokasi ini.`;
      return;
    }
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
  kombinasiTerkunci = null;
  const kombinasiBox = document.getElementById('kombinasi-box');
  if (kombinasiBox) kombinasiBox.hidden = true;
  setSupplierPemilikLocked(false);
  inputJumlah.value = '';
  inputQtyPallet.value = '';
  inputJumlahPallet.value = '';
  inputTanggal.value = todayISO();
  setJenis('masuk');
  hideError();
}

let isSubmittingLaporan = false;

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();

  // Guard anti-submit-dobel: kalau ada proses kirim yang masih berjalan
  // (misalnya operator nge-tap tombol "Kirim" 2x cepat), abaikan tap
  // kedua sepenuhnya. Ini dicek PALING AWAL, sebelum validasi apa pun,
  // supaya benar-benar tidak ada celah dua laporan identik tercatat.
  if (isSubmittingLaporan) return;

  if (!firestoreReady) return showError('Sistem belum siap menerima laporan. Coba lagi sebentar.');

  const operator = inputOperator.value.trim();
  const barang = selBarang.getValue();
  const supplier = selSupplier.getValue();
  const pemilik = selPemilik.getValue();
  const lokasi = selLokasi.getValue();
  const tanggal = inputTanggal.value;
  const jumlahParsed = parseFormattedNumber(inputJumlah.value);
  const jumlah = Number.isFinite(jumlahParsed) ? Math.trunc(jumlahParsed) : NaN;
  const qtyPerPalletRaw = inputQtyPallet.value.trim();
  const qtyPerPalletParsed = parseFormattedNumber(qtyPerPalletRaw);
  const qtyPerPallet = qtyPerPalletRaw ? qtyPerPalletParsed : null;
  const jumlahPalletParsed = parseFormattedNumber(inputJumlahPallet.value);
  const jumlahPallet = inputJumlahPallet.value ? jumlahPalletParsed : null;

  if (!operator) return showError('Nama operator wajib diisi.');
  if (!barang) return showError('Pilih nama barang terlebih dahulu.');
  if (!supplier) return showError('Pilih supplier terlebih dahulu.');
  if (!pemilik) return showError('Pilih pemilik barang (pabrik) terlebih dahulu.');
  if (!lokasi) return showError('Scan barcode lokasi penyimpanan terlebih dahulu.');
  if (!tanggal) return showError(jenis === 'keluar' ? 'Tanggal penginputan wajib diisi.' : 'Tanggal kedatangan wajib diisi.');
  if (!jumlah || jumlah <= 0) return showError('Jumlah barang harus berupa angka lebih dari 0.');
  if (!qtyPerPalletRaw || !qtyPerPallet || qtyPerPallet <= 0) return showError('Qty per pallet wajib diisi dengan angka lebih dari 0.');

  if (jenis === 'keluar') {
    // Wajib sudah pilih satu kombinasi dari kartu "Stok Tersedia" — ini
    // jaring pengaman terakhir sebelum data tersimpan, kalau-kalau ada
    // cara lain form ini terisi tanpa lewat klik kartu kombinasi.
    if (!kombinasiTerkunci) {
      return showError('Pilih salah satu kombinasi supplier/pemilik dari daftar "Stok Tersedia" terlebih dahulu.');
    }
    // Pastikan supplier, pemilik, DAN lokasi yang benar-benar akan
    // disimpan masih persis sama dengan kombinasi yang dikunci — bukan
    // cuma dicek stoknya, tapi identitas kombinasinya sendiri.
    if (supplier !== kombinasiTerkunci.supplier || pemilik !== kombinasiTerkunci.pemilik || lokasi !== kombinasiTerkunci.lokasi) {
      return showError('Kombinasi supplier/pemilik/lokasi berubah. Pilih ulang kombinasinya dari daftar "Stok Tersedia" dan scan ulang lokasinya.');
    }
    // Cek stok HANYA dari kombinasi kode+supplier+pemilik+lokasi yang
    // persis sama (satu ikat) — bukan total stok kode barang di lokasi
    // itu saja, supaya kombinasi lain di lokasi yang sama tidak ikut
    // "menutupi" kekurangan stok kombinasi ini.
    const stokKombinasi = getStokKombinasi(currentEntries, barang.kode, supplier, pemilik, lokasi);
    if (jumlah > stokKombinasi) {
      return showError(`Jumlah keluar (${jumlah.toLocaleString('id-ID')} pcs) melebihi stok kombinasi ini (supplier ${supplier}, pemilik ${pemilik}, lokasi ${lokasi}): ${stokKombinasi.toLocaleString('id-ID')} pcs. Kombinasi lain di lokasi yang sama tidak bisa dipakai untuk menutupi kekurangan ini.`);
    }
  }

  // ---- BLOKIR KAPASITAS LOKASI — khusus BARANG MASUK ----
  // Sebelum laporan disimpan, cek apakah pallet baru ini akan membuat
  // total pallet di LOKASI SPESIFIK tujuan melebihi batas kapasitas lokasi
  // (43 pallet untuk lorong A-F, 47 untuk G-L).
  // Kalau melebihi, laporan DIBLOKIR TOTAL — tidak bisa disimpan sama sekali sampai
  // operator pilih lokasi lain yang masih ada sisa kapasitas.
  if (jenis === 'masuk') {
    const cek = cekKapasitasBlok(lokasi, jumlahPallet || 0);
    if (!cek.ok) {
      return showError(
        `❌ Kapasitas Lokasi ${escapeHtml(cek.lokasi)} tidak mencukupi.\n` +
        `Pallet saat ini: ${roundPalletDisplay(cek.sekarang)}, batas: ${cek.batas.toLocaleString('id-ID')} pallet\n` +
        `(sisa kapasitas: ${roundPalletDisplay(cek.sisa)} pallet).\n\n` +
        `Laporan ini butuh ${roundPalletDisplay(jumlahPallet || 0)} pallet — melebihi sisa kapasitas di ${escapeHtml(cek.lokasi)}.\n` +
        `Pilih lokasi lain di lorong yang sama atau kurangi jumlah barang.`
      );
    }
  }

  isSubmittingLaporan = true;
  const submitBtn = document.getElementById('btn-submit');
  const submitText = document.getElementById('btn-submit-text');
  submitBtn.disabled = true;
  const originalText = submitText.textContent;
  submitText.textContent = 'MENYIMPAN...';

  try {
    const now = Date.now();
    const entryData = {
      jenis, tipe: 'transaksi', operator, kodeBarang: barang.kode, namaBarang: barang.nama,
      supplier, pemilik, lokasi, jumlah, qtyPerPallet, jumlahPallet, keterangan: '', tanggal, createdAt: now, updatedAt: now,
    };

    // PENTING soal offline: addEntryToFirestore() menyimpan laporan ke
    // cache lokal SECARA INSTAN (langsung muncul di daftar via listener
    // real-time), tapi promise-nya baru benar-benar resolve setelah
    // server membalas — kalau sedang offline itu bisa lama sekali/
    // menggantung sampai koneksi kembali. Makanya di sini kita TIDAK
    // menunggu (await) promise itu untuk memberi feedback ke operator;
    // form langsung direset & toast langsung muncul begitu tersimpan di
    // perangkat. Kegagalan asli (misalnya izin ditolak) tetap ditangani
    // di belakang layar lewat .catch() dan operator diberi tahu lewat toast.
    const writePromise = addEntryToFirestore(entryData);

    resetForm();
    inputOperator.value = operator;

    if (navigator.onLine) {
      showToast('Laporan berhasil disimpan.');
    } else {
      showToast('Laporan tersimpan di perangkat. Akan otomatis terkirim saat internet kembali.', 'info');
    }

    writePromise.catch((err) => {
      console.error('Gagal menyinkronkan laporan ke server:', err);
      showToast('Salah satu laporan gagal terkirim ke server: ' + err.message, 'error');
    });
  } catch (err) {
    showError('Gagal menyimpan laporan: ' + err.message);
  } finally {
    isSubmittingLaporan = false;
    submitBtn.disabled = !firestoreReady;
    submitText.textContent = originalText;
  }
});

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
  if (mode === 'tahunan') {
    const y = d.getFullYear();
    const first = new Date(y, 0, 1);
    const last = new Date(y, 11, 31);
    return { startISO: isoOfDate(first), endISO: isoOfDate(last), label: `Tahun ${y}` };
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
  if (mode === 'tahunan') {
    const prev = new Date(d.getFullYear() - 1, 0, 1);
    return getPeriodRange('tahunan', isoOfDate(prev));
  }
  return null;
}

function inPeriod(entry, range) {
  if (!range.startISO) return true;
  return entry.tanggal >= range.startISO && entry.tanggal <= range.endISO;
}

// Ada 2 lokasi tombol periode (Harian/Mingguan/Bulanan/Tahunan): satu di
// Dashboard, satu lagi di Riwayat Laporan (supaya admin bisa filter riwayat
// per hari/minggu/bulan/tahun tanpa pindah tab). Keduanya berbagi state
// periodMode & periodDate yang sama — setPeriodMode/setPeriodDate menyamakan
// tampilan kedua set tombol itu tiap kali salah satunya diubah.
const periodTabWraps = [
  document.getElementById('period-tabs'),
  document.getElementById('period-tabs-riwayat')
].filter(Boolean);
const periodDatePickers = [
  document.getElementById('period-date-picker'),
  document.getElementById('period-date-picker-riwayat')
].filter(Boolean);

function syncPeriodControls() {
  periodTabWraps.forEach(wrap => {
    wrap.querySelectorAll('.period-tab').forEach(b => {
      b.classList.toggle('is-active', b.dataset.mode === periodMode);
    });
  });
  periodDatePickers.forEach(picker => { picker.value = periodDate; });
}

function setPeriodMode(mode) {
  periodMode = mode;
  syncPeriodControls();
  renderRingkasan();
  renderRiwayat();
}

function setPeriodDate(dateISO) {
  periodDate = dateISO || todayISO();
  syncPeriodControls();
  renderRingkasan();
  renderRiwayat();
}

periodTabWraps.forEach(wrap => {
  wrap.querySelectorAll('.period-tab').forEach(btn => {
    btn.addEventListener('click', () => setPeriodMode(btn.dataset.mode));
  });
});

periodDatePickers.forEach(picker => {
  picker.addEventListener('change', () => setPeriodDate(picker.value));
});

syncPeriodControls();

// ---- BATAS KAPASITAS PALLET PER BLOK ----
// Jumlah maksimal pallet yang boleh ditampung tiap Blok gudang (A–L).
// Dipakai untuk (1) menampilkan progress kapasitas di dashboard "Ringkasan
// Pallet per Blok", dan (2) memperingatkan operator saat input BARANG MASUK
// yang membuat suatu Blok melebihi batas ini (lihat pengecekan di
// form.addEventListener('submit', ...) untuk jenis === 'masuk').
// Ubah angka di bawah ini kalau batas kapasitas gudang berubah.
// ---- Batasan Kapasitas Per Lokasi ----
// Setiap lokasi individual (A-01-01, A-01-02, dll) punya batasan pallet maksimal.
// Lorong A-F: max 43 pallet per lokasi
// Lorong G-L: max 47 pallet per lokasi
function getBatasLokasiPallet(lokasi) {
  if (!lokasi) return null;
  const lorong = String(lokasi).trim().charAt(0).toUpperCase();
  if (['A', 'B', 'C', 'D', 'E', 'F'].includes(lorong)) return 43;
  if (['G', 'H', 'I', 'J', 'K', 'L'].includes(lorong)) return 47;
  return null;  // Lorong lain tidak punya batasan
}

// CATATAN PERBAIKAN: dulu ada peta batas kapasitas per-BLOK terpisah
// (BATAS_PALLET_BLOK) yang dipakai di openBlokModal() & mode "Blok" Katalog,
// tapi sudah tidak pernah didefinisikan di file ini (sisa dari desain lama
// sebelum pindah ke batas PER LOKASI lewat getBatasLokasiPallet() di atas) —
// akibatnya kode itu crash (ReferenceError) tiap kali blok dibuka, lalu
// sempat "ditambal" jadi objek kosong supaya tidak crash — tapi itu artinya
// info kapasitas & peringatan "kapasitas terlampaui" per Blok jadi tidak
// pernah muncul sama sekali.
//
// PERBAIKAN SEBENARNYA: kapasitas total satu Blok = (jumlah lokasi/rak yang
// terdaftar di Blok itu di data master) × (kapasitas pallet per lokasi —
// 43 untuk Blok A-F, 47 untuk Blok G-L). Jumlah lokasi per Blok TIDAK selalu
// sama (lihat data.js: Blok A & G cuma 5 lorong x 7 tingkat = 35 lokasi,
// tapi Blok B/C/E/H/I/K punya 17 lorong x 7 tingkat = 119 lokasi, Blok D/J
// 15 lorong = 105 lokasi, Blok F/L 16 lorong = 112 lokasi) — jadi kapasitas
// totalnya dihitung dinamis dari data master, bukan angka tetap per blok.
function getBatasPalletBlok(blok) {
  const masterLokasi = (typeof MASTER_DATA !== 'undefined' && MASTER_DATA.lokasi) ? MASTER_DATA.lokasi : [];
  const lokasiDiBlok = masterLokasi.filter(l => getBlokFromLokasi(l) === blok);
  if (lokasiDiBlok.length === 0) return null;
  const kapasitasPerLokasi = getBatasLokasiPallet(lokasiDiBlok[0]);
  if (!kapasitasPerLokasi) return null; // Blok di luar A-L tidak punya batasan
  return lokasiDiBlok.length * kapasitasPerLokasi;
}

// ---- Helper terpusat: cek sisa kapasitas pallet suatu LOKASI ----
// Dipakai di SEMUA jalur yang bisa menambah pallet ke suatu lokasi (form
// laporan Barang Masuk, Edit Laporan admin) supaya tidak ada celah satu
// jalur ke-cek sementara jalur lain tidak.
//   lokasi          -> kode lokasi tujuan spesifik (mis. A-01-01, B-05-03, dll)
//   deltaPallet     -> jumlah pallet yang MAU ditambahkan (0 kalau cuma mau tahu kondisi lokasi saat ini)
//   entriesUntukHitung -> basis data transaksi yang dipakai (default currentEntries).
//                          Dipakai saat simulasi edit laporan, di mana entri yang
//                          sedang diedit sengaja dikeluarkan dulu dari daftar supaya
//                          tidak dihitung dobel (kontribusi lama + kontribusi baru).
// Kalau lokasi tidak terdaftar di batas lorong, dianggap tidak ada batas (ok: true).
function cekKapasitasBlok(lokasi, deltaPallet, entriesUntukHitung) {
  const batas = getBatasLokasiPallet(lokasi);
  if (!batas) return { ok: true, lokasi, batas: null, sekarang: 0, sisa: null, setelah: 0 };
  
  // Hitung pallet yang sudah ada di LOKASI SPESIFIK ini (bukan seluruh blok)
  const sekarang = (entriesUntukHitung || currentEntries)
    .filter(t => t.lokasi === lokasi && t.jumlahPallet != null)
    .reduce((s, t) => s + (t.jenis === 'masuk' ? t.jumlahPallet : -t.jumlahPallet), 0);
  
  const setelah = sekarang + (deltaPallet || 0);
  const lorong = String(lokasi).trim().charAt(0).toUpperCase();
  return {
    ok: setelah <= batas, lokasi, lorong, batas, sekarang,
    sisa: Math.max(batas - sekarang, 0), setelah,
  };
}

// Ambil kode "blok" dari kode lokasi — blok = huruf/segmen pertama sebelum
// tanda pemisah pertama (mis. lokasi "A-01-01" -> blok "A"). Kalau lokasi
// tidak memakai tanda pemisah, ambil karakter pertama saja sebagai fallback.
function getBlokFromLokasi(lokasi) {
  if (!lokasi) return '(Tanpa Blok)';
  const str = String(lokasi).trim();
  const match = str.match(/^([A-Za-z0-9]+)[-_./\s]/);
  return (match ? match[1] : str.charAt(0)).toUpperCase();
}

// Bandingkan setiap kode lokasi (rak/slot) dari MASTER_DATA.lokasi dengan
// posisi stok SEKARANG (buildLocationStock) untuk menandai TERISI (masih
// ada stok tercatat) atau KOSONG (belum/sudah tidak ada stok) — supaya
// admin bisa langsung lihat rak mana yang masih kosong untuk barang baru,
// dan rak mana yang sudah terisi. Lokasi yang pernah dipakai transaksi tapi
// belum ada di MASTER_DATA.lokasi (mis. lokasi baru yang di-scan sebelum
// sempat ditambahkan admin) tetap ikut dihitung, supaya tidak "hilang".
function buildLokasiOccupancy(entries) {
  const locStock = buildLocationStock(entries);
  const stockMap = new Map(locStock.map(l => [l.lokasi, l]));
  const masterLokasi = (typeof MASTER_DATA !== 'undefined' && MASTER_DATA.lokasi) ? MASTER_DATA.lokasi : [];
  const allLokasi = new Set(masterLokasi);
  entries.forEach(t => { if (t.lokasi) allLokasi.add(t.lokasi); });

  const bloks = {};
  allLokasi.forEach(lokasi => {
    const blok = getBlokFromLokasi(lokasi);
    if (!bloks[blok]) bloks[blok] = { blok, slots: [], terisi: 0, kosong: 0, totalPallet: 0 };
    const b = bloks[blok];
    const stok = stockMap.get(lokasi);
    const isTerisi = !!(stok && stok.totalQty > 0);
    b.slots.push({
      lokasi,
      status: isTerisi ? 'terisi' : 'kosong',
      qty: stok ? stok.totalQty : 0,
      pallet: stok ? stok.totalPallet : 0,
      itemCount: stok ? stok.itemCount : 0,
      tanggalKedatangan: stok ? stok.tanggalKedatangan : null,
    });
    if (isTerisi) { b.terisi++; b.totalPallet += (stok.totalPallet || 0); } else { b.kosong++; }
  });

  Object.values(bloks).forEach(b => {
    b.slots.sort((x, y) => x.lokasi.localeCompare(y.lokasi, undefined, { numeric: true }));
  });
  return Object.values(bloks).sort((a, b) => a.blok.localeCompare(b.blok));
}

// ---- Modal peta lokasi per blok — grid kecil semua rak di blok tsb,
// ditandai TERISI (ada stok) / KOSONG (belum ada stok), klik satu rak untuk
// lihat detail (kalau terisi) atau info singkat (kalau kosong).
function openBlokModal(blok) {
  const blokData = buildLokasiOccupancy(currentEntries);
  const data = blokData.find(b => b.blok === blok);
  if (!data) return;
  const total = data.terisi + data.kosong;
  const batasBlok = getBatasPalletBlok(data.blok);
  const isOver = batasBlok ? data.totalPallet > batasBlok : false;

  modalBody.innerHTML = `
    <div class="modal-item-head">
      <div class="modal-item-kode">BLOK GUDANG</div>
      <h2 class="modal-item-nama mono">Blok ${escapeHtml(data.blok)}</h2>
    </div>
    <div class="modal-stat-grid">
      <div class="modal-stat"><span>Total Lokasi</span><strong>${total}</strong></div>
      <div class="modal-stat"><span>Terisi</span><strong>${data.terisi}</strong></div>
      <div class="modal-stat"><span>Kosong</span><strong>${data.kosong}</strong></div>
      <div class="modal-stat"><span>Total Pallet</span><strong class="modal-stat-small${isOver ? ' is-over-text' : ''}">${data.totalPallet ? roundPalletDisplay(data.totalPallet) : '-'}${batasBlok ? ` / ${batasBlok.toLocaleString('id-ID')}` : ''}</strong></div>
    </div>
    ${isOver ? `<div class="bar-row-warning">⚠️ Kapasitas Blok ${escapeHtml(data.blok)} terlampaui — batas ${batasBlok.toLocaleString('id-ID')} pallet.</div>` : ''}
    <div class="modal-section">
      <h4>Peta Lokasi (klik untuk detail)</h4>
      <div class="lokasi-map-legend">
        <span class="lokasi-map-legend-item"><i class="lokasi-map-dot is-terisi"></i>Terisi</span>
        <span class="lokasi-map-legend-item"><i class="lokasi-map-dot is-kosong"></i>Kosong</span>
      </div>
      <div class="lokasi-map-grid" id="lokasi-map-grid"></div>
    </div>
  `;
  const grid = modalBody.querySelector('#lokasi-map-grid');
  data.slots.forEach(s => {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = `lokasi-map-cell is-${s.status}`;
    // Tampilkan bagian kode lokasi setelah huruf blok saja (lebih ringkas
    // di dalam grid kecil), tapi title tetap kode lengkap.
    const shortLabel = s.lokasi.replace(new RegExp('^' + data.blok + '[-_./\\s]?'), '') || s.lokasi;
    cell.title = s.status === 'terisi'
      ? `${s.lokasi} — Terisi (${s.qty.toLocaleString('id-ID')} pcs${s.pallet ? `, ${roundPalletDisplay(s.pallet)} pallet` : ''})`
      : `${s.lokasi} — Kosong`;
    cell.textContent = shortLabel;
    cell.addEventListener('click', () => {
      if (s.status === 'terisi') {
        openLokasiModal(s.lokasi);
      } else {
        showToast(`Lokasi ${s.lokasi} masih kosong — belum ada stok tercatat.`, 'info');
      }
    });
    grid.appendChild(cell);
  });
  itemModal.hidden = false;
}

/* ---- MODAL "SEMUA BLOK" ----
   Dipakai tombol "Lihat semua blok →" di kartu "Blok/Rak Terpadat"
   dashboard admin. Sebelumnya tombol ini cuma manggil goToKatalog('blok'),
   yang untuk admin ternyata TIDAK terhubung ke apa-apa (panel "Katalog &
   Stok" admin adalah panel filter kedatangan barang yang beda total dari
   tampilan blok/lokasi operator) — jadi klik tombol itu tidak menampilkan
   apa-apa yang berguna. Modal ini menampilkan SEMUA blok gudang (bukan
   cuma Top 5), diurutkan dari yang paling penuh, satu tampilan yang sama
   persis dengan kartu dashboard tapi lengkap. Klik satu blok -> buka
   detail rak per blok lewat openBlokModal (peta lokasi terisi/kosong). */
function openAllBlokModal() {
  const blokData = buildLokasiOccupancy(currentEntries);
  const blokRanked = blokData
    .map(b => {
      const total = b.terisi + b.kosong;
      const batasBlok = getBatasPalletBlok(b.blok);
      const isOver = batasBlok ? b.totalPallet > batasBlok : false;
      const pct = batasBlok
        ? Math.round((b.totalPallet / batasBlok) * 100)
        : (total > 0 ? Math.round((b.terisi / total) * 100) : 0);
      return { ...b, total, batasBlok, isOver, pct };
    })
    .filter(b => b.total > 0)
    .sort((a, b) => a.blok.localeCompare(b.blok));

  modalBody.innerHTML = `
    <div class="modal-item-head">
      <div class="modal-item-kode">SEMUA BLOK GUDANG</div>
      <h2 class="modal-item-nama">Semua Blok (A–L)</h2>
    </div>
    <div class="modal-section">
      ${blokRanked.length === 0 ? '<p class="vis-empty">Belum ada data lokasi/blok tercatat.</p>' : `
        <div class="bar-list" id="all-blok-list" style="max-height:420px; overflow-y:auto; padding-right:2px;"></div>
      `}
    </div>
  `;
  if (blokRanked.length > 0) {
    const list = modalBody.querySelector('#all-blok-list');
    blokRanked.forEach(b => {
      // Blok yang sudah penuh/lewat kapasitas SELALU merah — tidak pernah
      // hijau/oranye lagi meski persentasenya diukur di bawah ambang biasa.
      const lvl = (b.isOver || b.pct >= 100) ? 'dash-lvl-tinggi' : (b.pct >= 40 ? 'dash-lvl-sedang' : 'dash-lvl-rendah');
      const row = document.createElement('div');
      row.className = 'dash-blok-row' + (b.isOver ? ' is-over' : '');
      row.style.cursor = 'pointer';
      row.innerHTML = `
        <div class="dash-blok-top">
          <span class="dash-blok-name">Blok ${escapeHtml(b.blok)} <span class="muted">(${b.terisi}/${b.total} terisi)</span></span>
          <span class="dash-blok-pct">${b.pct}%</span>
        </div>
        <div class="dash-blok-track"><div class="dash-blok-fill ${lvl}" style="width:${Math.max(Math.min(b.pct, 100), b.terisi > 0 ? 4 : 0)}%"></div></div>
        <div class="dash-blok-pallet-info muted" style="font-size:12px; margin-top:4px;">
          ${roundPalletDisplay(b.totalPallet)}${b.batasBlok ? ` / ${b.batasBlok.toLocaleString('id-ID')}` : ''} pallet
        </div>
        ${b.isOver ? `<div class="bar-row-warning">⚠️ Kapasitas terlampaui (batas ${b.batasBlok.toLocaleString('id-ID')} pallet)</div>` : ''}
      `;
      row.addEventListener('click', () => openBlokModal(b.blok));
      list.appendChild(row);
    });
  }
  itemModal.hidden = false;
}

/* ==========================================================================
   DASHBOARD ADMIN — "Pergerakan Barang", "Kondisi Stok Saat Ini", "Barang
   dengan Stok Terbanyak", "Blok/Rak Terpadat", "Jenis Barang Masuk &
   Keluar", "Aktivitas Operator Hari Ini", dan "Aktivitas Terbaru". Semua
   dihitung langsung dari currentEntries/MASTER_DATA (tidak ada data
   contoh/hardcode) — renderRingkasan() dipanggil tiap kali data berubah
   (renderAll) atau tiap kali periode/tanggal diganti lewat #period-tabs.
========================================================================== */
const dashMoveDate = document.getElementById('dash-move-date');

// Warna badge avatar operator — dipilih siklis dari nama supaya konsisten
// tiap kali dirender ulang (bukan acak).
const DASH_AVATAR_COLORS = ['#276B44', '#A85417', '#0F2038', '#9E1015', '#5A6B8C'];
function dashAvatarColor(nama) {
  const str = String(nama || '?');
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return DASH_AVATAR_COLORS[hash % DASH_AVATAR_COLORS.length];
}
function dashInisial(nama) {
  const parts = String(nama || '?').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// Tren naik/turun/sama dibanding periode sebelumnya — dipakai berulang di
// kartu "Pergerakan Barang" (jumlah laporan, qty pcs, dan jumlah pallet).
function setDashTrend(el, current, previous, hasPrev) {
  if (!el) return;
  if (!hasPrev || (current === 0 && previous === 0)) { el.hidden = true; return; }
  el.hidden = false;
  const pct = previous === 0 ? 100 : Math.round(((current - previous) / previous) * 100);
  if (pct > 0) { el.className = 'dash-move-trend up'; el.textContent = `▲ ${pct}% dari kemarin`; }
  else if (pct < 0) { el.className = 'dash-move-trend down'; el.textContent = `▼ ${Math.abs(pct)}% dari kemarin`; }
  else { el.className = 'dash-move-trend flat'; el.textContent = 'Sama dari kemarin'; }
}

// Berpindah ke tab Katalog & Stok dengan mode tertentu (dipakai tombol
// "Lihat semua barang / lokasi / detail stok" di kartu dashboard).
function goToKatalog(mode) {
  if (katalogModeTabs) {
    katalogModeTabs.querySelectorAll('.period-tab').forEach(b => {
      b.classList.toggle('is-active', b.dataset.mode === mode);
    });
  }
  katalogMode = mode;
  if (searchKatalog) searchKatalog.value = '';
  switchAdminPanel('katalog');
  renderKatalog();
}

// Modal ringkas "Top 5 Barang Masuk/Keluar" pada periode terpilih — dipakai
// tombol "Lihat detail" di kartu Jenis Barang Masuk & Keluar.
function openTopBarangJenisModal(jenis, range) {
  const count = {};
  const kodeMap = {};
  currentEntries.forEach(t => {
    if (t.jenis === jenis && inPeriod(t, range)) {
      count[t.namaBarang] = (count[t.namaBarang] || 0) + t.jumlah;
      kodeMap[t.namaBarang] = t.kodeBarang;
    }
  });
  const top5 = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const judul = jenis === 'masuk' ? 'Top 5 Barang Masuk' : 'Top 5 Barang Keluar';
  modalBody.innerHTML = `
    <div class="modal-item-head">
      <div class="modal-item-kode">${escapeHtml(range.label.toUpperCase())}</div>
      <h2 class="modal-item-nama">${judul}</h2>
    </div>
    <div class="modal-section">
      ${top5.length === 0 ? '<p class="vis-empty">Belum ada data pada periode ini.</p>' : `
        <div class="bar-list">
          ${top5.map(([nama, jml], i) => `
            <div class="bar-row" data-kode="${escapeHtml(kodeMap[nama] || '')}">
              <div class="bar-row-top">
                <span class="bar-row-name">${i + 1}. ${escapeHtml(nama)}</span>
                <span class="bar-row-val">${jml.toLocaleString('id-ID')} pcs</span>
              </div>
              <div class="bar-row-track"><div class="bar-row-fill" style="width:${Math.max(6, Math.round((jml / top5[0][1]) * 100))}%"></div></div>
            </div>
          `).join('')}
        </div>
      `}
    </div>
  `;
  modalBody.querySelectorAll('.bar-row[data-kode]').forEach(row => {
    if (row.dataset.kode) row.addEventListener('click', () => openItemModal(row.dataset.kode));
  });
  itemModal.hidden = false;
}

function renderDashActivity() {
  const listEl = document.getElementById('dash-activity-list');
  const emptyEl = document.getElementById('dash-activity-empty');
  if (!listEl || !emptyEl) return;
  const terbaru = currentEntries.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  listEl.innerHTML = '';
  if (terbaru.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  terbaru.forEach(t => {
    const isMasuk = t.jenis === 'masuk';
    // Label tanggal dibuat eksplisit per jenis supaya tidak rancu — baris
    // tanggal di sini BUKAN "waktu kejadian" campur aduk, tapi benar-benar
    // menunjukkan field yang sesuai jenis transaksinya:
    // - MASUK  -> "Datang" = Tanggal Kedatangan barang.
    // - KELUAR -> "Input"  = Tanggal Penginputan form barang keluar.
    // Jam di baris bawah SELALU waktu asli laporan disimpan ke sistem
    // (createdAt) — bisa beda hari dari tanggal di baris atas kalau
    // operator input tanggal mundur/lain hari, makanya diberi label
    // "Disimpan" + tooltip supaya jelas ini bukan jam dari tanggal di atasnya.
    const tanggalLabel = isMasuk ? 'Datang' : 'Input';
    const tanggalTitle = isMasuk ? 'Tanggal Kedatangan' : 'Tanggal Penginputan';
    const row = document.createElement('div');
    row.className = 'dash-activity-item';
    row.innerHTML = `
      <div class="dash-activity-icon ${isMasuk ? 'dash-c-hijau' : 'dash-c-merah'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          ${isMasuk ? '<path d="M12 3v14"/><path d="M6 13l6 6 6-6"/><path d="M5 21h14"/>' : '<path d="M12 21V7"/><path d="M18 11l-6-6-6 6"/><path d="M5 3h14"/>'}
        </svg>
      </div>
      <div class="dash-activity-body">
        <div class="dash-activity-title">${isMasuk ? 'Barang Masuk' : 'Barang Keluar'}</div>
        <div class="dash-activity-sub" title="${escapeHtml(t.namaBarang)}">${escapeHtml(t.namaBarang)}</div>
      </div>
      <div class="dash-activity-date">
        <span class="dash-activity-date-main" title="${tanggalTitle}">${tanggalLabel} ${escapeHtml(formatTanggal(t.tanggal))}</span>
        <span class="dash-activity-date-sub" title="Waktu laporan ini disimpan ke sistem">Disimpan ${escapeHtml(formatJam(t.createdAt))}</span>
      </div>
    `;
    row.addEventListener('click', () => openItemModal(t.kodeBarang, t.namaBarang));
    listEl.appendChild(row);
  });
}

function renderRingkasan() {
  if (currentRole() !== 'admin') return;
  const range = getPeriodRange(periodMode, periodDate);
  const prevRange = getPreviousPeriodRange(periodMode, periodDate);
  if (dashMoveDate) dashMoveDate.textContent = `(${range.label})`;

  /* ---- 1) PERGERAKAN BARANG — hitung periode ini & periode sebelumnya ---- */
  function hitungPeriode(r) {
    let masukQty = 0, masukCount = 0, keluarQty = 0, keluarCount = 0, palletMasuk = 0, palletKeluar = 0;
    if (!r) return { masukQty, masukCount, keluarQty, keluarCount, palletMasuk, palletKeluar };
    currentEntries.forEach(t => {
      if (!inPeriod(t, r)) return;
      if (t.jenis === 'masuk') {
        masukQty += t.jumlah; masukCount++;
        if (t.jumlahPallet != null) palletMasuk += t.jumlahPallet;
      } else {
        keluarQty += t.jumlah; keluarCount++;
        if (t.jumlahPallet != null) palletKeluar += t.jumlahPallet;
      }
    });
    return { masukQty, masukCount, keluarQty, keluarCount, palletMasuk, palletKeluar };
  }

  const now = hitungPeriode(range);
  const prev = hitungPeriode(prevRange);
  const hasPrev = !!prevRange;

  setText('dash-masuk-count', now.masukCount.toLocaleString('id-ID'));
  setText('dash-keluar-count', now.keluarCount.toLocaleString('id-ID'));
  setText('dash-masuk-qty', now.masukQty.toLocaleString('id-ID'));
  setText('dash-keluar-qty', now.keluarQty.toLocaleString('id-ID'));
  setText('dash-pallet-masuk', roundPalletDisplay(now.palletMasuk));
  setText('dash-pallet-keluar', roundPalletDisplay(now.palletKeluar));

  setDashTrend(document.getElementById('dash-masuk-count-trend'), now.masukCount, prev.masukCount, hasPrev);
  setDashTrend(document.getElementById('dash-keluar-count-trend'), now.keluarCount, prev.keluarCount, hasPrev);
  setDashTrend(document.getElementById('dash-masuk-qty-trend'), now.masukQty, prev.masukQty, hasPrev);
  setDashTrend(document.getElementById('dash-keluar-qty-trend'), now.keluarQty, prev.keluarQty, hasPrev);
  setDashTrend(document.getElementById('dash-pallet-masuk-trend'), now.palletMasuk, prev.palletMasuk, hasPrev);
  setDashTrend(document.getElementById('dash-pallet-keluar-trend'), now.palletKeluar, prev.palletKeluar, hasPrev);

  /* ---- 2) KONDISI STOK SAAT INI — posisi stok sekarang, semua waktu ---- */
  const stokItems = buildStokList(currentEntries).map(it => ({
    ...it, stok: it.masuk - it.keluar, stokPallet: it.masukPallet - it.keluarPallet,
  }));
  const totalPcs = stokItems.reduce((s, it) => s + Math.max(it.stok, 0), 0);
  const totalPalletSaatIni = stokItems.reduce((s, it) => s + Math.max(it.stokPallet, 0), 0);
  const totalJenis = stokItems.filter(it => it.stok > 0).length;
  setText('dash-total-pcs', totalPcs.toLocaleString('id-ID'));
  setText('dash-total-pallet', roundPalletDisplay(totalPalletSaatIni));
  setText('dash-total-jenis', totalJenis.toLocaleString('id-ID'));
  setText('dash-total-supplier', (MASTER_DATA.supplier || []).length.toLocaleString('id-ID'));
  setText('dash-total-pemilik', (MASTER_DATA.pemilik || []).length.toLocaleString('id-ID'));

  const btnStok = document.getElementById('dash-btn-stok');
  if (btnStok) btnStok.onclick = () => goToKatalog('barang');

  /* ---- 3) BARANG DENGAN STOK TERBANYAK (Top 5) ---- */
  const topStok = stokItems.filter(it => it.stok > 0).sort((a, b) => b.stok - a.stok).slice(0, 5);
  const topBarangList = document.getElementById('dash-top-barang-list');
  const topBarangEmpty = document.getElementById('dash-top-barang-empty');
  if (topBarangList && topBarangEmpty) {
    topBarangList.innerHTML = '';
    if (topStok.length === 0) {
      topBarangEmpty.hidden = false;
    } else {
      topBarangEmpty.hidden = true;
      topStok.forEach((it, i) => {
        const row = document.createElement('div');
        row.className = 'dash-rank-row';
        row.innerHTML = `
          <span class="dash-rank-num">${i + 1}</span>
          <span class="dash-rank-name" title="${escapeHtml(it.nama)}">${escapeHtml(it.nama)}</span>
          <span class="dash-rank-val">${it.stok.toLocaleString('id-ID')} pcs</span>
        `;
        row.addEventListener('click', () => openItemModal(it.kode, it.nama));
        topBarangList.appendChild(row);
      });
    }
  }
  const btnBarang = document.getElementById('dash-btn-barang');
  if (btnBarang) btnBarang.onclick = () => goToKatalog('barang');

  /* ---- 3b) BARANG DENGAN PALLET TERBANYAK (Top 5) ---- */
  const topPallet = stokItems.filter(it => it.stokPallet > 0).sort((a, b) => b.stokPallet - a.stokPallet).slice(0, 5);
  const topPalletList = document.getElementById('dash-top-pallet-list');
  const topPalletEmpty = document.getElementById('dash-top-pallet-empty');
  if (topPalletList && topPalletEmpty) {
    topPalletList.innerHTML = '';
    if (topPallet.length === 0) {
      topPalletEmpty.hidden = false;
    } else {
      topPalletEmpty.hidden = true;
      topPallet.forEach((it, i) => {
        const row = document.createElement('div');
        row.className = 'dash-rank-row';
        row.innerHTML = `
          <span class="dash-rank-num">${i + 1}</span>
          <span class="dash-rank-name" title="${escapeHtml(it.nama)}">${escapeHtml(it.nama)}</span>
          <span class="dash-rank-val">${roundPalletDisplay(it.stokPallet)} pallet</span>
        `;
        row.addEventListener('click', () => openItemModal(it.kode, it.nama));
        topPalletList.appendChild(row);
      });
    }
  }
  const btnPallet = document.getElementById('dash-btn-pallet');
  if (btnPallet) btnPallet.onclick = () => goToKatalog('barang');

  /* ---- 4) BLOK / RAK TERPADAT (Top 5) — berdasar persentase kapasitas
     PALLET terisi (bukan cuma jumlah lokasi terisi), supaya blok yang
     pallet-nya sudah penuh/lewat kapasitas selalu tampil MERAH, tidak
     ketiban warna hijau/oranye hanya karena jumlah lokasi (rak) yang
     kepakai masih sedikit padahal pallet-nya sudah menumpuk penuh. ---- */
  const blokData = buildLokasiOccupancy(currentEntries);
  const blokRanked = blokData
    .map(b => {
      const total = b.terisi + b.kosong;
      const batasBlok = getBatasPalletBlok(b.blok);
      const isOver = batasBlok ? b.totalPallet > batasBlok : false;
      // Kalau kapasitas pallet blok ini diketahui, pakai itu sebagai acuan
      // "penuh" (persentase pallet terhadap batas). Kalau tidak ada data
      // batas pallet, fallback ke persentase lokasi terisi seperti semula.
      const pct = batasBlok
        ? Math.round((b.totalPallet / batasBlok) * 100)
        : (total > 0 ? Math.round((b.terisi / total) * 100) : 0);
      return { ...b, total, batasBlok, isOver, pct };
    })
    .filter(b => b.total > 0)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 5);
  const topBlokList = document.getElementById('dash-top-blok-list');
  const topBlokEmpty = document.getElementById('dash-top-blok-empty');
  if (topBlokList && topBlokEmpty) {
    topBlokList.innerHTML = '';
    if (blokRanked.length === 0) {
      topBlokEmpty.hidden = false;
    } else {
      topBlokEmpty.hidden = true;
      blokRanked.forEach(b => {
        // Blok yang sudah penuh/lewat kapasitas (isOver, atau pct >= 100
        // walau batas belum tercatat) SELALU merah, tidak peduli angka
        // ambang biasa — supaya tidak pernah salah kelihatan hijau/aman.
        const lvl = (b.isOver || b.pct >= 100) ? 'dash-lvl-tinggi' : (b.pct >= 40 ? 'dash-lvl-sedang' : 'dash-lvl-rendah');
        const row = document.createElement('div');
        row.className = 'dash-blok-row' + (b.isOver ? ' is-over' : '');
        row.innerHTML = `
          <div class="dash-blok-top">
            <span class="dash-blok-name">Blok ${escapeHtml(b.blok)}</span>
            <span class="dash-blok-pct">${b.pct}%</span>
          </div>
          <div class="dash-blok-track"><div class="dash-blok-fill ${lvl}" style="width:${Math.max(Math.min(b.pct, 100), b.terisi > 0 ? 4 : 0)}%"></div></div>
        `;
        row.addEventListener('click', () => openBlokModal(b.blok));
        topBlokList.appendChild(row);
      });
    }
  }
  const btnBlok = document.getElementById('dash-btn-blok');
  if (btnBlok) btnBlok.onclick = () => openAllBlokModal();

  /* ---- 5) JENIS BARANG MASUK & KELUAR — jenis unik pada periode terpilih ---- */
  const kodeMasukSet = new Set(), kodeKeluarSet = new Set();
  currentEntries.forEach(t => {
    if (!inPeriod(t, range)) return;
    const key = t.kodeBarang || t.namaBarang;
    if (t.jenis === 'masuk') kodeMasukSet.add(key); else kodeKeluarSet.add(key);
  });
  setText('dash-jenis-masuk', kodeMasukSet.size.toLocaleString('id-ID'));
  setText('dash-jenis-keluar', kodeKeluarSet.size.toLocaleString('id-ID'));
  const btnJenisMasuk = document.getElementById('dash-btn-jenis-masuk');
  const btnJenisKeluar = document.getElementById('dash-btn-jenis-keluar');
  if (btnJenisMasuk) btnJenisMasuk.onclick = () => openTopBarangJenisModal('masuk', range);
  if (btnJenisKeluar) btnJenisKeluar.onclick = () => openTopBarangJenisModal('keluar', range);

  /* ---- 6) AKTIVITAS OPERATOR — jumlah laporan masuk/keluar per operator, periode terpilih ---- */
  const opMap = {};
  currentEntries.forEach(t => {
    if (!inPeriod(t, range)) return;
    const nama = t.operator || 'Tanpa Nama';
    if (!opMap[nama]) opMap[nama] = { masuk: 0, keluar: 0 };
    if (t.jenis === 'masuk') opMap[nama].masuk++; else opMap[nama].keluar++;
  });
  const opRanked = Object.entries(opMap)
    .map(([nama, v]) => ({ nama, ...v, total: v.masuk + v.keluar }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);
  const opTbody = document.getElementById('dash-operator-tbody');
  const opEmpty = document.getElementById('dash-operator-empty');
  if (opTbody && opEmpty) {
    opTbody.innerHTML = '';
    if (opRanked.length === 0) {
      opEmpty.hidden = false;
    } else {
      opEmpty.hidden = true;
      opRanked.forEach(o => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><span class="dash-op-name"><span class="dash-op-avatar" style="background:${dashAvatarColor(o.nama)}">${escapeHtml(dashInisial(o.nama))}</span>${escapeHtml(o.nama)}</span></td>
          <td class="dash-op-masuk">${o.masuk.toLocaleString('id-ID')}</td>
          <td class="dash-op-keluar">${o.keluar.toLocaleString('id-ID')}</td>
        `;
        opTbody.appendChild(tr);
      });
    }
  }
  const btnOperator = document.getElementById('dash-btn-operator');
  if (btnOperator) btnOperator.onclick = () => switchAdminPanel('operator');

  /* ---- 7) AKTIVITAS TERBARU — 5 laporan paling baru, semua waktu ---- */
  renderDashActivity();
  const btnAktivitas = document.getElementById('dash-btn-aktivitas');
  if (btnAktivitas) btnAktivitas.onclick = () => switchAdminPanel('riwayat');
}

/* ==========================================================================
   KATALOG & STOK — jelajah gabungan (admin & operator)
   Satu daftar "folder" yang bisa dilihat dari 4 sisi berbeda:
   - barang    -> pakai buildStokList()      (sudah ada)
   - lokasi    -> pakai buildLocationStock() (sudah ada)
   - supplier  -> pakai buildAttributeBreakdown(entries, 'supplier')
   - pemilik   -> pakai buildAttributeBreakdown(entries, 'pemilik')
   Keempat mode dirender dengan gaya baris yang sama (appendStokRow) supaya
   konsisten & gampang dipahami — klik baris mana pun membuka modal detail
   yang sesuai.
========================================================================== */
const katalogSection = document.getElementById('katalog');
const katalogList = document.getElementById('katalog-list');
const katalogEmpty = document.getElementById('katalog-empty');
const searchKatalog = document.getElementById('search-katalog');
const katalogHint = document.getElementById('katalog-hint');
const katalogModeTabs = document.getElementById('katalog-mode-tabs');

let katalogMode = 'barang';

// Kelompokkan transaksi berdasarkan satu field (supplier / pemilik), dan
// hitung barang apa saja + berapa stok saat ini + di lokasi mana + kapan
// terakhir ada aktivitas untuk tiap nilai field tersebut. Dipakai untuk
// mode "Supplier" & "Pemilik" (baik daftar maupun modal detailnya).
function buildAttributeBreakdown(entries, field) {
  const map = {};
  entries.forEach(t => {
    const key = t[field];
    if (!key || key === '-') return;
    if (!map[key]) map[key] = { items: {}, lastActivity: 0 };
    const group = map[key];
    const itemKey = t.kodeBarang || t.namaBarang;
    if (!group.items[itemKey]) group.items[itemKey] = { kode: t.kodeBarang, nama: t.namaBarang, masuk: 0, keluar: 0, lokasiSet: new Set(), lastActivity: 0 };
    const it = group.items[itemKey];
    if (t.jenis === 'masuk') it.masuk += t.jumlah;
    else it.keluar += t.jumlah;
    if (t.lokasi) it.lokasiSet.add(t.lokasi);
    if (t.createdAt > it.lastActivity) it.lastActivity = t.createdAt;
    if (t.createdAt > group.lastActivity) group.lastActivity = t.createdAt;
  });
  return Object.entries(map).map(([nama, group]) => {
    const items = Object.values(group.items)
      .map(it => ({ ...it, stok: it.masuk - it.keluar }))
      .sort((a, b) => b.stok - a.stok);
    const totalStok = items.reduce((s, it) => s + it.stok, 0);
    return { nama, items, itemCount: items.length, totalStok, lastActivity: group.lastActivity };
  }).sort((a, b) => a.nama.localeCompare(b.nama));
}

// Ubah Set (lokasi / supplier / pemilik) jadi teks singkat yang gampang
// dibaca, contoh: "Gudang A, Gudang B +2 lainnya". Dipakai supaya baris
// tabel katalog tidak penuh sesak kalau satu barang tersebar di banyak
// lokasi/supplier/pemilik.
function formatSetList(set, max = 2) {
  const arr = Array.from(set || []).filter(Boolean);
  if (arr.length === 0) return '-';
  if (arr.length <= max) return arr.join(', ');
  return `${arr.slice(0, max).join(', ')} +${arr.length - max} lainnya`;
}

/* ==========================================================================
   KATALOG BARANG — tampilan gabungan "Katalog Barang" (kiri) & "Lokasi
   Penyimpanan" (kanan). Ini adalah tampilan mode 'barang' (default) yang
   dilihat operator saat membuka tab "Katalog Barang", dan juga dilihat
   admin saat memilih tab "Barang" di "Katalog & Stok".

   Alur navigasinya:
   - Klik barang di kiri  -> Detail Barang (openItemModal) -> tabel semua
     batch/lokasi barang itu -> klik satu baris -> Riwayat Transaksi
     (openRiwayatTransaksiView), lokasi & barangnya sama, tapi tampilkan
     semua transaksi (masuk & keluar) yang pernah terjadi di sana.
   - Klik lokasi di kanan -> Detail Lokasi (openLokasiModal) -> tabel semua
     barang/batch di lokasi itu -> klik salah satu baris -> Detail Barang.

   Modal detail dan Riwayat Transaksi sama-sama memakai #item-modal yang
   sudah ada (isinya diganti tiap kali pindah tampilan), konsisten dengan
   pola cross-link yang sudah dipakai modal lain di aplikasi ini — jadi
   tidak perlu modal/overlay baru.
========================================================================== */
// Kapasitas per RAK/SLOT INDIVIDUAL sengaja TIDAK dipakai lagi (dulu ada
// angka standar 30 pallet untuk semua rak, tapi itu tidak akurat — banyak
// rak yang secara wajar menampung lebih dari 30 pallet, jadi progress bar
// "Terisi" nya selalu mentok 100% dan menyesatkan). Kapasitas yang BENAR
// datanya ada di tingkat BLOK (lihat BATAS_PALLET_BLOK di atas), jadi itu
// yang dipakai untuk info kapasitas di panel & modal Lokasi Penyimpanan.
// (Kapasitas per LORONG/area belum ada data masternya — kalau nanti ada
// angkanya, tinggal ditambahkan pola yang sama seperti BATAS_PALLET_BLOK.)

let katalogSplitBarangQuery = '';
let katalogSplitLokasiQuery = '';
// Halaman katalog Barang yang sedang aktif (pagination kartu kombinasi).
// Direset ke 1 tiap kali pencarian berubah lewat cek "signature" di
// renderKatalogBarangSplit.
let katalogSplitBarangPage = 1;
let katalogSplitBarangQuerySignature = '';
const KATALOG_COMBO_PAGE_SIZE = 6;

// "Area Penyimpanan" = kode lokasi tanpa nomor slot terakhir
// (mis. "B-16-01" -> "B-16"), supaya ringkasan di Katalog Barang cukup
// menunjukkan blok+rak tanpa perlu sampai detail nomor slot.
function getAreaFromLokasi(lokasi) {
  if (!lokasi) return '-';
  const parts = String(lokasi).split('-');
  return parts.length > 1 ? parts.slice(0, -1).join('-') : lokasi;
}

function renderKatalogBarangSplit() {
  const combos = buildBarangComboList(currentEntries);
  const bq = katalogSplitBarangQuery.trim().toLowerCase();
  const filteredCombos = bq
    ? combos.filter(c =>
        c.nama.toLowerCase().includes(bq) ||
        String(c.kode).toLowerCase().includes(bq) ||
        (c.supplier || '').toLowerCase().includes(bq) ||
        (c.pemilik || '').toLowerCase().includes(bq)
      )
    : combos;

  const allLokasi = buildLocationStock(currentEntries);
  const lq = katalogSplitLokasiQuery.trim().toLowerCase();
  const filteredLokasi = lq ? allLokasi.filter(l => l.lokasi.toLowerCase().includes(lq)) : allLokasi;

  // Reset ke halaman 1 tiap kali kata kuncinya berubah, supaya operator
  // tidak "nyangkut" di halaman 3 pas hasil pencariannya cuma 1 halaman.
  if (bq !== katalogSplitBarangQuerySignature) {
    katalogSplitBarangQuerySignature = bq;
    katalogSplitBarangPage = 1;
  }
  const totalPages = Math.max(1, Math.ceil(filteredCombos.length / KATALOG_COMBO_PAGE_SIZE));
  if (katalogSplitBarangPage > totalPages) katalogSplitBarangPage = totalPages;
  if (katalogSplitBarangPage < 1) katalogSplitBarangPage = 1;
  const pageStart = (katalogSplitBarangPage - 1) * KATALOG_COMBO_PAGE_SIZE;
  const pageCombos = filteredCombos.slice(pageStart, pageStart + KATALOG_COMBO_PAGE_SIZE);

  // Satu kartu = satu kombinasi unik Barang + Supplier + Pemilik. Kedatangan
  // (batch masuk) dengan kombinasi ketiganya persis sama sudah dinetkan jadi
  // satu angka stok/pallet di sini — rincian per-batchnya baru kelihatan
  // saat kartu ini diklik (lihat openComboModal).
  const renderComboCard = (c) => {
    const stok = c.masuk - c.keluar;
    const totalPallet = (c.masukPallet || 0) - (c.keluarPallet || 0);
    const jumlahLokasi = c.lokasiSet.size;
    return `
      <button type="button" class="barang-pick-row combo-card"
        data-kode="${escapeHtml(c.kode || '')}"
        data-supplier="${escapeHtml(c.supplier || '')}"
        data-pemilik="${escapeHtml(c.pemilik || '')}">
        <div class="barang-pick-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z"/><path d="M3 7.5 12 12l9-4.5"/><path d="M12 12v9"/></svg>
        </div>
        <div class="barang-pick-info">
          <div class="barang-pick-nama" title="${escapeHtml(c.nama)}">${escapeHtml(c.nama)}</div>
          <div class="barang-pick-kode mono">Kode Barang: ${escapeHtml(c.kode || '-')}</div>
          <div class="combo-card-attrs">
            <div class="combo-card-attr"><span class="combo-card-attr-label">Supplier:</span> <span class="combo-card-attr-val">${escapeHtml(c.supplier || '-')}</span></div>
            <div class="combo-card-attr"><span class="combo-card-attr-label">Pemilik:</span> <span class="combo-card-attr-val">${escapeHtml(c.pemilik || '-')}</span></div>
          </div>
          <div class="barang-pick-meta">
            <span class="barang-pick-lokasi-badge">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s7-6.6 7-11.5A7 7 0 0 0 5 9.5C5 14.4 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.3"/></svg>
              Disimpan di ${jumlahLokasi} lokasi
            </span>
          </div>
        </div>
        <div class="barang-pick-qty">
          <span class="qty-num ${stok <= 0 ? 'neg' : ''}">${stok.toLocaleString('id-ID')} <small>pcs</small></span>
          ${totalPallet ? `<span class="qty-pallet">${roundPalletDisplay(totalPallet)} pallet</span>` : ''}
        </div>
        <svg class="barang-pick-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
      </button>
    `;
  };

  const barangRowsHtml = pageCombos.length ? pageCombos.map(renderComboCard).join('')
    : `<div class="empty-state">Tidak ada barang yang cocok dengan pencarian.</div>`;

  // Pager nomor halaman — cukup tampilkan beberapa nomor di sekitar halaman
  // aktif kalau jumlah halamannya banyak, supaya tidak terlalu panjang.
  const pagerHtml = (filteredCombos.length && totalPages > 1) ? (() => {
    const maxButtons = 5;
    let start = Math.max(1, katalogSplitBarangPage - Math.floor(maxButtons / 2));
    let end = Math.min(totalPages, start + maxButtons - 1);
    start = Math.max(1, end - maxButtons + 1);
    let numberBtns = '';
    for (let p = start; p <= end; p++) {
      numberBtns += `<button type="button" class="katalog-pager-btn${p === katalogSplitBarangPage ? ' is-active' : ''}" data-page="${p}">${p}</button>`;
    }
    return `
      <div class="katalog-pager">
        <button type="button" class="katalog-pager-btn" data-page="prev" ${katalogSplitBarangPage <= 1 ? 'disabled' : ''} aria-label="Halaman sebelumnya">«</button>
        ${numberBtns}
        <button type="button" class="katalog-pager-btn" data-page="next" ${katalogSplitBarangPage >= totalPages ? 'disabled' : ''} aria-label="Halaman berikutnya">»</button>
      </div>
    `;
  })() : '';

  // Bar kapasitas & badge status ditambahkan sebagai INFO TAMBAHAN di
  // bawah baris yang sudah ada (lokasi/total pallet/aksi tetap sama persis
  // seperti sebelumnya) — pakai helper getBatasLokasiPallet() yang sudah
  // ada & sebelumnya cuma dipakai di modal detail lokasi. Lokasi tanpa
  // batas terdaftar (lorong di luar A-L) tetap tampil apa adanya, tanpa bar.
  //
  // Ikon kotak per baris dipakai sebagai inline SVG (bukan webfont ikon
  // eksternal, mengikuti pola inline SVG yang sudah dipakai di seluruh
  // aplikasi ini) supaya warnanya bisa mengikuti status kapasitas.
  const lokasiRowsHtml = filteredLokasi.length ? filteredLokasi.map(l => {
    // PENTING: roundPalletDisplay() mengembalikan STRING terformat locale
    // id-ID (mis. "33.440,21" — titik ribuan, koma desimal). String itu
    // TIDAK BOLEH dipakai untuk perhitungan (Number("33.440,21") = NaN).
    // Jadi nilai numerik mentah (palletNum) dan teks tampilan (palletDisplay)
    // dipisah: yang satu buat hitung persen, yang satu buat ditulis di layar.
    const palletNum = Number(l.totalPallet) || 0;
    const palletDisplay = l.totalPallet ? roundPalletDisplay(l.totalPallet) : '0';
    const lokasiText = String(l.lokasi || '').trim().replace(/\s+/g, ' ');
    // "Area X" = huruf blok pertama dari kode lokasi (mis. "B-16-01" -> "Area B"),
    // dipakai sebagai sub-label kecil di bawah kode lokasi lengkap.
    const areaLetter = (lokasiText.match(/^([A-Za-z]+)/) || [])[1];
    const batas = getBatasLokasiPallet(l.lokasi);
    // Angka pallet ditulis sebagai satu baris "terpakai / batas pallet" —
    // dibungkus title="" supaya kalau angkanya sangat panjang (dan terpotong
    // dengan ellipsis oleh CSS), operator tetap bisa lihat angka lengkapnya
    // lewat hover/tap-hold, tanpa baris jadi melebar dua baris di layar.
    const palletFigure = `${palletDisplay}${batas ? ` / ${batas.toLocaleString('id-ID')}` : ''} pallet`;
    let statusClass = 'ltr-cap-none', statusLabel = 'Tanpa batas terdaftar', pct = null;
    if (batas) {
      pct = Math.min(100, Math.max(0, Math.round((palletNum / batas) * 100)));
      // Ambang "Hampir penuh" sengaja diturunkan ke 50% (bukan 70%) supaya
      // operator dapat sinyal lebih awal sebelum rak benar-benar mepet.
      statusClass = 'ltr-cap-ok'; statusLabel = 'Tersedia';
      if (pct >= 100) { statusClass = 'ltr-cap-full'; statusLabel = 'Penuh'; }
      else if (pct >= 50) { statusClass = 'ltr-cap-warn'; statusLabel = 'Hampir penuh'; }
    }
    const barFillWidth = pct == null ? 0 : pct;
    // Ikon kotak sama untuk semua status — warnanya sudah dibedakan lewat
    // .ltr-icon-box (ikuti pola inline SVG yang sudah dipakai di seluruh
    // aplikasi ini, bukan webfont ikon eksternal yang belum dimuat).
    const boxIconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z"/><path d="M3 7.5 12 12l9-4.5"/><path d="M12 12v9"/></svg>`;
    return `
      <div class="lokasi-table-row ${statusClass}" data-lokasi="${escapeHtml(l.lokasi)}" role="button" tabindex="0">
        <div class="ltr-card-head">
          <div class="ltr-icon-box ${statusClass}">${boxIconSvg}</div>
          <div class="ltr-name-block">
            <div class="ltr-lokasi mono" title="${escapeHtml(lokasiText)}">${escapeHtml(lokasiText)}</div>
            ${areaLetter ? `<div class="ltr-area">Area ${escapeHtml(areaLetter)}</div>` : ''}
          </div>
          <button type="button" class="ltr-aksi" data-lokasi-aksi="${escapeHtml(l.lokasi)}" aria-label="Lihat detail lokasi ${escapeHtml(l.lokasi)}" title="Lihat detail lokasi">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </div>
        <div class="ltr-pallet-row">
          <span class="ltr-pallet" title="${escapeHtml(palletFigure)}">${palletFigure}</span>
          <span class="ltr-capacity-pill ${statusClass}">${statusLabel}${pct != null ? ` ${pct}%` : ''}</span>
        </div>
        <div class="ltr-capacity-bar"><div class="ltr-capacity-fill ${statusClass}" style="width:${barFillWidth}%"></div></div>
      </div>
    `;
  }).join('') : `<div class="empty-state">Tidak ada lokasi yang cocok dengan pencarian.</div>`;
  const lokasiLegendHtml = filteredLokasi.length ? `
    <div class="ltr-legend">
      <span class="ltr-legend-item"><i class="ltr-legend-dot ltr-cap-ok"></i>Tersedia (&lt;50%)</span>
      <span class="ltr-legend-item"><i class="ltr-legend-dot ltr-cap-warn"></i>Hampir penuh (50–99%)</span>
      <span class="ltr-legend-item"><i class="ltr-legend-dot ltr-cap-full"></i>Penuh (100%)</span>
    </div>
  ` : '';

  katalogList.className = 'katalog-split';
  katalogList.innerHTML = `
    <div class="katalog-panel">
      <div class="katalog-panel-head">
        <h3>📦 Katalog Barang</h3>
        <div class="search-inline search-inline-mini">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input type="text" id="katalog-split-barang-search" placeholder="Cari barang, supplier, atau pemilik..." value="${escapeHtml(katalogSplitBarangQuery)}">
        </div>
      </div>
      <div class="katalog-panel-count">${filteredCombos.length} grup barang</div>
      <div class="barang-group-list">${barangRowsHtml}</div>
      ${pagerHtml}
    </div>
    <div class="katalog-panel">
      <div class="katalog-panel-head">
        <h3>📍 Lokasi Penyimpanan</h3>
        <div class="search-inline search-inline-mini">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input type="text" id="katalog-split-lokasi-search" placeholder="Cari lokasi..." value="${escapeHtml(katalogSplitLokasiQuery)}">
        </div>
      </div>
      <div class="ltr-count-badge"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21V10l9-6 9 6v11"/><path d="M9 21v-6h6v6"/></svg>Total ${allLokasi.length} lokasi</div>
      <div class="lokasi-table">
        <div class="lokasi-table-body">${lokasiRowsHtml}</div>
      </div>
      ${lokasiLegendHtml}
    </div>
  `;

  katalogList.querySelectorAll('.combo-card').forEach(row => {
    row.addEventListener('click', () => openComboModal(row.dataset.kode, row.dataset.supplier, row.dataset.pemilik));
  });
  katalogList.querySelectorAll('.katalog-pager-btn[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.page;
      if (val === 'prev') katalogSplitBarangPage = Math.max(1, katalogSplitBarangPage - 1);
      else if (val === 'next') katalogSplitBarangPage = Math.min(totalPages, katalogSplitBarangPage + 1);
      else katalogSplitBarangPage = parseInt(val, 10) || 1;
      renderKatalogBarangSplit();
    });
  });
  katalogList.querySelectorAll('.lokasi-table-row:not(.lokasi-table-head)').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.ltr-aksi')) return;
      openLokasiModal(row.dataset.lokasi);
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLokasiModal(row.dataset.lokasi); }
    });
  });
  katalogList.querySelectorAll('.ltr-aksi').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openLokasiModal(btn.dataset.lokasiAksi); });
  });

  const focusEnd = (el) => { if (el) { el.focus(); const v = el.value; el.setSelectionRange(v.length, v.length); } };

  const barangSearchInput = document.getElementById('katalog-split-barang-search');
  if (barangSearchInput) {
    barangSearchInput.addEventListener('input', () => {
      katalogSplitBarangQuery = barangSearchInput.value;
      renderKatalogBarangSplit();
      focusEnd(document.getElementById('katalog-split-barang-search'));
    });
  }
  const lokasiSearchInput = document.getElementById('katalog-split-lokasi-search');
  if (lokasiSearchInput) {
    lokasiSearchInput.addEventListener('input', () => {
      katalogSplitLokasiQuery = lokasiSearchInput.value;
      renderKatalogBarangSplit();
      focusEnd(document.getElementById('katalog-split-lokasi-search'));
    });
  }
}

// Baris tabel katalog — versi "gampang dibaca" untuk operator: nama/judul,
// subjudul kecil (kode barang ATAU label lain), stok/total saat ini (dengan
// status jelas) langsung terlihat, plus baris info tambahan yang fleksibel
// (meta) sesuai konteksnya. Dipakai bareng oleh keempat mode katalog
// (Barang/Lokasi/Supplier/Pemilik) dan modal detailnya supaya tampilannya
// konsisten & gampang dipahami. Klik baris tetap membuka modal detail untuk
// lihat lebih lanjut.
function appendStokRow(container, { nama, sub, subMono = true, stok, statusClass, statusLabel, meta, pallet, onClick }) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = `stok-row stok-row-${statusClass}`;
  const metaHtml = (meta || []).map(m => `
    <div class="stok-meta-item"><span class="stok-meta-label">${m.icon} ${escapeHtml(m.label)}</span><span class="stok-meta-val" title="${escapeHtml(m.value)}">${escapeHtml(m.value)}</span></div>
  `).join('');
  // pallet: jumlah pallet (opsional) yang ditampilkan sebagai baris kecil
  // di bawah angka stok pcs, misalnya untuk Katalog Barang.
  const palletHtml = (pallet != null && pallet !== 0)
    ? `<span class="stok-qty-pallet">${roundPalletDisplay(pallet)} pallet</span>`
    : '';
  row.innerHTML = `
    <div class="stok-row-top">
      <div class="stok-row-info">
        <div class="stok-row-nama" title="${escapeHtml(nama)}">${escapeHtml(nama)}</div>
        <div class="stok-row-kode${subMono ? ' mono' : ''}">${escapeHtml(sub || '-')}</div>
      </div>
      <div class="stok-row-qty">
        <span class="stok-qty-num ${statusClass}">${stok.toLocaleString('id-ID')}</span>
        <span class="stok-qty-status ${statusClass}">${statusLabel}</span>
        ${palletHtml}
      </div>
    </div>
    <div class="stok-row-meta">${metaHtml}</div>
  `;
  row.addEventListener('click', onClick);
  container.appendChild(row);
}

function setKatalogEmpty(msg) {
  katalogEmpty.hidden = false;
  katalogEmpty.textContent = msg;
}

function renderKatalog() {
  const q = searchKatalog.value.trim().toLowerCase();
  katalogList.innerHTML = '';
  // Keempat mode (Barang/Lokasi/Supplier/Pemilik) sama-sama pakai tabel
  // baris yang langsung menampilkan info lengkap tanpa perlu klik dulu.
  katalogList.classList.add('stok-table');
  katalogList.classList.remove('folder-grid');
  katalogList.classList.remove('bar-list');
  katalogList.classList.remove('lokasi-breakdown-list');
  // Mode 'barang' pakai tampilan gabungan Katalog Barang + Lokasi
  // Penyimpanan berdampingan (lihat renderKatalogBarangSplit) yang punya
  // search & judul sendiri per panel — sembunyikan search/hint umum di
  // atas supaya tidak dobel.
  katalogSection.classList.toggle('katalog-split-active', katalogMode === 'barang');

  if (katalogMode === 'barang') {
    katalogEmpty.hidden = true;
    renderKatalogBarangSplit();
    return;

  } else if (katalogMode === 'lokasi') {
    // PERUBAHAN: dulu tiap lokasi cuma tampil sebagai 1 kartu ringkasan
    // (total stok) yang harus DIKLIK dulu untuk lihat isinya lewat popup.
    // Sekarang rinciannya (barang apa saja, berapa jumlahnya) langsung
    // tampil di bawah nama lokasi tanpa perlu klik — gaya Excel, sama
    // seperti panel Katalog & Stok admin. l.items sudah berisi breakdown
    // per barang (netted, hasil buildLocationStock), jadi tidak perlu
    // query ulang ke currentEntries.
    const all = buildLocationStock(currentEntries);
    const filtered = q
      ? all.filter(l =>
          l.lokasi.toLowerCase().includes(q) ||
          l.items.some(it => (it.nama || '').toLowerCase().includes(q) || String(it.kode || '').toLowerCase().includes(q))
        )
      : all;
    katalogList.classList.remove('stok-table');
    katalogList.classList.add('lokasi-breakdown-list');
    if (all.length === 0) return setKatalogEmpty('Belum ada stok tercatat di lokasi manapun.');
    if (filtered.length === 0) return setKatalogEmpty('Tidak ada lokasi atau barang yang cocok dengan pencarian.');
    katalogEmpty.hidden = true;
    katalogHint.textContent = `📁 ${all.length} lokasi terisi. Rincian barang di tiap lokasi langsung tampil di bawah ini — klik nama lokasi kalau butuh riwayat kedatangan lengkapnya.`;
    filtered.forEach(l => {
      const group = document.createElement('div');
      group.className = 'lokasi-breakdown-group';
      const itemRowsHtml = l.items.map(it => `
        <div class="batch-table-row">
          <div class="btc btc-nama" title="${escapeHtml(it.nama || '-')}">${escapeHtml(it.nama || '-')}</div>
          <div class="btc mono">${escapeHtml(it.kode || '-')}</div>
          <div class="btc">${escapeHtml(formatSetList(it.supplierSet))}</div>
          <div class="btc">${escapeHtml(formatSetList(it.pemilikSet))}</div>
          <div class="btc btc-jumlah">${it.qty.toLocaleString('id-ID')} pcs</div>
          <div class="btc">${it.pallet ? roundPalletDisplay(it.pallet) : 0} pallet</div>
        </div>
      `).join('');
      group.innerHTML = `
        <div class="lokasi-breakdown-head" role="button" tabindex="0" data-lokasi="${escapeHtml(l.lokasi)}" aria-label="Lihat riwayat kedatangan lengkap lokasi ${escapeHtml(l.lokasi)}">
          <div class="lokasi-breakdown-title">
            <span class="lokasi-breakdown-nama mono">${escapeHtml(l.lokasi)}</span>
            <span class="muted">${l.itemCount} jenis barang</span>
          </div>
          <div class="lokasi-breakdown-stats">
            <span class="stok-qty-num ${l.totalQty > 0 ? 'pos' : (l.totalQty < 0 ? 'neg' : 'zero')}">${l.totalQty.toLocaleString('id-ID')} pcs</span>
            ${l.totalPallet ? `<span class="stok-qty-pallet">${roundPalletDisplay(l.totalPallet)} pallet</span>` : ''}
          </div>
        </div>
        <div class="batch-table batch-table-lokasi-items">
          <div class="batch-table-row batch-table-head">
            <div class="btc btc-nama">Barang</div>
            <div class="btc">Kode</div>
            <div class="btc">Supplier</div>
            <div class="btc">Pemilik</div>
            <div class="btc btc-jumlah">Jumlah PCS</div>
            <div class="btc">Pallet</div>
          </div>
          <div class="batch-table-body">${itemRowsHtml}</div>
        </div>
      `;
      katalogList.appendChild(group);
    });
    katalogList.querySelectorAll('.lokasi-breakdown-head').forEach(head => {
      head.addEventListener('click', () => openLokasiModal(head.dataset.lokasi));
      head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLokasiModal(head.dataset.lokasi); } });
    });

  } else if (katalogMode === 'blok') {
    // Mode BLOK — peta gudang per Blok (A–L), mirip "Status Lokasi per
    // Blok" di dashboard admin, tapi dibuka juga untuk operator supaya
    // operator bisa cari tahu sendiri rak mana yang kosong/terisi tanpa
    // perlu akses admin. Menampilkan SEMUA lokasi (termasuk yang masih
    // KOSONG), beda dari mode "Lokasi" di atas yang cuma menampilkan
    // lokasi yang sudah ada stoknya.
    const blokData = buildLokasiOccupancy(currentEntries);
    const filtered = q
      ? blokData.filter(b => b.blok.toLowerCase().includes(q) || b.slots.some(s => s.lokasi.toLowerCase().includes(q)))
      : blokData;
    katalogList.classList.remove('stok-table');
    katalogList.classList.add('bar-list');
    if (blokData.length === 0) return setKatalogEmpty('Belum ada data lokasi/blok tercatat.');
    if (filtered.length === 0) return setKatalogEmpty('Tidak ada blok yang cocok dengan pencarian.');
    katalogEmpty.hidden = true;
    katalogHint.textContent = `📁 ${blokData.length} blok gudang. Klik satu blok untuk lihat rak mana yang terisi/kosong, lalu klik rak untuk lihat barang & riwayat lengkapnya.`;
    filtered.forEach(b => {
      const total = b.terisi + b.kosong;
      const batasBlok = getBatasPalletBlok(b.blok);
      const isOver = batasBlok ? b.totalPallet > batasBlok : false;
      const pct = batasBlok
        ? Math.round((b.totalPallet / batasBlok) * 100)
        : (total > 0 ? Math.round((b.terisi / total) * 100) : 0);
      const barWidthPct = Math.min(pct, 100);
      const row = document.createElement('div');
      row.className = 'bar-row bar-row-blok' + (isOver ? ' is-over' : '');
      row.innerHTML = `
        <div class="bar-row-top">
          <span class="bar-row-name mono">Blok ${escapeHtml(b.blok)} <span class="muted">(${b.terisi}/${total} terisi · ${b.kosong} kosong)</span></span>
          <span class="bar-row-val">${roundPalletDisplay(b.totalPallet)}${batasBlok ? ` / ${batasBlok.toLocaleString('id-ID')}` : ''} pallet${batasBlok ? ` · ${pct}%` : ''}</span>
        </div>
        <div class="bar-row-track"><div class="bar-row-fill" style="width:${Math.max(barWidthPct, total > 0 && b.terisi > 0 ? 4 : 0)}%"></div></div>
        ${isOver ? `<div class="bar-row-warning">⚠️ Kapasitas terlampaui (batas ${batasBlok.toLocaleString('id-ID')} pallet)</div>` : ''}
      `;
      row.addEventListener('click', () => openBlokModal(b.blok));
      katalogList.appendChild(row);
    });

  } else if (katalogMode === 'supplier' || katalogMode === 'pemilik') {
    const field = katalogMode === 'supplier' ? 'supplier' : 'pemilik';
    const all = buildAttributeBreakdown(currentEntries, field);
    const filtered = q ? all.filter(d => d.nama.toLowerCase().includes(q)) : all;
    const labelJenis = katalogMode === 'supplier' ? 'supplier' : 'pemilik barang';
    const subLabel = katalogMode === 'supplier' ? 'Supplier' : 'Pemilik Barang (Pabrik)';
    if (all.length === 0) return setKatalogEmpty(`Belum ada data ${labelJenis}.`);
    if (filtered.length === 0) return setKatalogEmpty(`Tidak ada ${labelJenis} yang cocok dengan pencarian.`);
    katalogEmpty.hidden = true;
    katalogHint.textContent = `📁 ${all.length} ${labelJenis}. Klik baris untuk lihat barang apa saja yang terkait.`;
    filtered.forEach(d => {
      const statusClass = d.totalStok > 0 ? 'pos' : (d.totalStok < 0 ? 'neg' : 'zero');
      const statusLabel = d.totalStok > 0 ? 'Stok Tersedia' : (d.totalStok < 0 ? 'Stok Minus' : 'Stok Kosong');
      const barangUtama = d.items[0] ? d.items[0].nama : '-';
      appendStokRow(katalogList, {
        nama: d.nama, sub: subLabel, subMono: false, stok: d.totalStok, statusClass, statusLabel,
        meta: [
          { icon: '📦', label: 'Jenis Barang', value: `${d.itemCount} jenis` },
          { icon: '⭐', label: 'Barang Utama', value: barangUtama },
          { icon: '🕒', label: 'Terakhir', value: d.lastActivity ? formatWaktu(d.lastActivity) : '-' },
        ],
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

// Hitung laporan + aktivitas terakhir seorang operator dari currentEntries,
// dicocokkan lewat nama (case-insensitive) sama seperti logika lama.
function getOperatorStats(nama) {
  const key = (nama || '').trim().toLowerCase();
  const laporan = currentEntries
    .filter(t => (t.operator || '').trim().toLowerCase() === key)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return {
    laporan,
    total: laporan.length,
    masuk: laporan.filter(t => t.jenis === 'masuk').length,
    keluar: laporan.filter(t => t.jenis === 'keluar').length,
    terakhirAktif: laporan.length ? laporan[0].createdAt : null,
  };
}

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
    const stats = getOperatorStats(a.nama);
    const inisial = (a.nama || '-').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'akun-operator-item' + (opDetailState.accountId === a.id ? ' is-active' : '');
    card.dataset.accountId = a.id;
    card.innerHTML = `
      <div class="akun-operator-avatar">${escapeHtml(inisial || '?')}</div>
      <span class="akun-operator-nama">${escapeHtml(a.nama || '-')}</span>
      <span class="akun-operator-meta">ID Karyawan: <span class="mono">${escapeHtml(a.idKaryawan || '-')}</span></span>
      <span class="akun-operator-badge">${stats.total.toLocaleString('id-ID')} Laporan</span>
      <div class="akun-operator-footer">
        <span class="akun-operator-date">Terakhir aktif: ${stats.terakhirAktif ? formatWaktu(stats.terakhirAktif) : 'Belum ada aktivitas'}</span>
        <svg class="akun-operator-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 6 6 6-6 6"/></svg>
      </div>
    `;
    card.addEventListener('click', () => openOperatorDetail(a.id));
    akunOperatorListEl.appendChild(card);
  });
}

if (searchAkunOperator) searchAkunOperator.addEventListener('input', renderAkunOperator);

/* ==========================================================================
   DRAWER: DETAIL OPERATOR (admin) — dibuka dari kartu di "Akun Operator
   Terdaftar". Menampilkan ringkasan (total laporan & terakhir aktif) plus
   2 tab: Riwayat Transaksi (tabel + pagination) dan Informasi Operator
   (data akun + aksi hapus akun, dipindah ke sini dari kartu supaya kartu
   tetap ringkas).
========================================================================== */
const opDetailOverlay = document.getElementById('op-detail-overlay');
const opDetailBody = document.getElementById('op-detail-body');
const opDetailState = { accountId: null, tab: 'riwayat', page: 1, pageSize: 7 };

function closeOperatorDetail() {
  if (!opDetailOverlay) return;
  opDetailOverlay.hidden = true;
  opDetailState.accountId = null;
  renderAkunOperator();
}

if (opDetailOverlay) {
  document.getElementById('op-detail-close').addEventListener('click', closeOperatorDetail);
  opDetailOverlay.addEventListener('click', (e) => { if (e.target === opDetailOverlay) closeOperatorDetail(); });
}

function openOperatorDetail(accountId) {
  if (!opDetailOverlay || !opDetailBody) return;
  opDetailState.accountId = accountId;
  opDetailState.tab = 'riwayat';
  opDetailState.page = 1;
  opDetailOverlay.hidden = false;
  renderAkunOperator();
  renderOperatorDetail();
}

function renderOperatorDetail() {
  if (!opDetailBody) return;
  const a = currentOperatorAccounts.find(x => x.id === opDetailState.accountId);
  if (!a) { closeOperatorDetail(); return; }

  const stats = getOperatorStats(a.nama);
  const inisial = (a.nama || '-').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();

  opDetailBody.innerHTML = `
    <div class="op-detail-head">
      <div class="akun-operator-avatar op-detail-avatar">${escapeHtml(inisial || '?')}</div>
      <div>
        <div class="op-detail-nama">${escapeHtml(a.nama || '-')}</div>
        <div class="op-detail-id">ID Karyawan: ${escapeHtml(a.idKaryawan || '-')}</div>
      </div>
    </div>

    <div class="op-detail-stats">
      <div class="op-detail-stat-card">
        <div class="op-detail-stat-icon"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 2h6a1 1 0 0 1 1 1v2H8V3a1 1 0 0 1 1-1Z"/><path d="M8 4H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/></svg></div>
        <div>
          <div class="op-detail-stat-label">Total Laporan</div>
          <div class="op-detail-stat-value">${stats.total.toLocaleString('id-ID')}</div>
        </div>
      </div>
      <div class="op-detail-stat-card">
        <div class="op-detail-stat-icon"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg></div>
        <div>
          <div class="op-detail-stat-label">Terakhir Aktif</div>
          <div class="op-detail-stat-value op-detail-stat-value-sm">${stats.terakhirAktif ? formatWaktu(stats.terakhirAktif) : '-'}</div>
        </div>
      </div>
    </div>

    <div class="op-detail-tabs">
      <button type="button" class="op-detail-tab${opDetailState.tab === 'riwayat' ? ' is-active' : ''}" data-op-tab="riwayat">Riwayat Transaksi</button>
      <button type="button" class="op-detail-tab${opDetailState.tab === 'info' ? ' is-active' : ''}" data-op-tab="info">Informasi Operator</button>
    </div>

    <div id="op-detail-tab-content"></div>
  `;

  opDetailBody.querySelectorAll('[data-op-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      opDetailState.tab = btn.dataset.opTab;
      opDetailState.page = 1;
      renderOperatorDetail();
    });
  });

  const contentEl = opDetailBody.querySelector('#op-detail-tab-content');
  if (opDetailState.tab === 'riwayat') {
    renderOperatorDetailRiwayat(contentEl, stats);
  } else {
    renderOperatorDetailInfo(contentEl, a, stats);
  }
}

function renderOperatorDetailRiwayat(el, stats) {
  const totalItems = stats.laporan.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / opDetailState.pageSize));
  opDetailState.page = Math.min(opDetailState.page, totalPages);
  const start = (opDetailState.page - 1) * opDetailState.pageSize;
  const pageItems = stats.laporan.slice(start, start + opDetailState.pageSize);

  el.innerHTML = `
    <p class="op-detail-tab-hint">Daftar riwayat transaksi yang dilakukan oleh operator ini.</p>
    <div class="op-detail-table-wrap">
      <table class="op-detail-table">
        <thead>
          <tr>
            <th>Tanggal &amp; Waktu</th>
            <th>Lokasi</th>
            <th>Pemilik Barang</th>
            <th>Jumlah Item</th>
            <th>Aksi</th>
          </tr>
        </thead>
        <tbody>
          ${pageItems.length ? pageItems.map(t => `
            <tr>
              <td>${formatWaktu(t.createdAt)}</td>
              <td>${escapeHtml(t.lokasi || '-')}</td>
              <td>${escapeHtml(t.pemilik || '-')}</td>
              <td>${(t.jumlah || 0).toLocaleString('id-ID')}</td>
              <td><button type="button" class="btn-secondary op-detail-btn-detail" data-entry-id="${t.id}">Lihat Detail</button></td>
            </tr>
          `).join('') : `<tr><td colspan="5" class="empty-state">Operator ini belum memiliki riwayat transaksi.</td></tr>`}
        </tbody>
      </table>
    </div>
    ${totalItems ? `
      <div class="op-detail-pagination">
        <button type="button" class="kds-page-btn" id="op-detail-prev" ${opDetailState.page <= 1 ? 'disabled' : ''}>&lsaquo;</button>
        <button type="button" class="kds-page-btn is-active">${opDetailState.page}</button>
        <button type="button" class="kds-page-btn" id="op-detail-next" ${opDetailState.page >= totalPages ? 'disabled' : ''}>&rsaquo;</button>
      </div>
    ` : ''}
  `;

  el.querySelectorAll('.op-detail-btn-detail').forEach(btn => {
    btn.addEventListener('click', () => openKdsDetailModal(btn.dataset.entryId));
  });
  const prevBtn = el.querySelector('#op-detail-prev');
  const nextBtn = el.querySelector('#op-detail-next');
  if (prevBtn) prevBtn.addEventListener('click', () => { opDetailState.page--; renderOperatorDetailRiwayat(el, stats); });
  if (nextBtn) nextBtn.addEventListener('click', () => { opDetailState.page++; renderOperatorDetailRiwayat(el, stats); });
}

function renderOperatorDetailInfo(el, a, stats) {
  el.innerHTML = `
    <p class="op-detail-tab-hint">Data akun dan ringkasan aktivitas operator ini.</p>
    <div class="op-detail-info-grid">
      <div class="op-detail-info-item"><span>Nama Operator</span><strong>${escapeHtml(a.nama || '-')}</strong></div>
      <div class="op-detail-info-item"><span>ID Karyawan</span><strong>${escapeHtml(a.idKaryawan || '-')}</strong></div>
      <div class="op-detail-info-item"><span>Tanggal Daftar</span><strong>${a.createdAt ? formatWaktu(a.createdAt) : '-'}</strong></div>
      <div class="op-detail-info-item"><span>Terakhir Aktif</span><strong>${stats.terakhirAktif ? formatWaktu(stats.terakhirAktif) : '-'}</strong></div>
      <div class="op-detail-info-item"><span>Laporan Masuk</span><strong>${stats.masuk.toLocaleString('id-ID')}</strong></div>
      <div class="op-detail-info-item"><span>Laporan Keluar</span><strong>${stats.keluar.toLocaleString('id-ID')}</strong></div>
    </div>
    <div class="op-detail-info-danger">
      <div>
        <strong>Hapus Akun Operator</strong>
        <p>Operator ini tidak akan bisa masuk lagi sampai mendaftar ulang. Riwayat transaksi yang sudah tercatat tidak ikut terhapus.</p>
      </div>
      <button type="button" class="btn-danger-outline" id="op-detail-btn-hapus">Hapus Akun</button>
    </div>
  `;

  el.querySelector('#op-detail-btn-hapus').addEventListener('click', async () => {
    if (!await showConfirmModal({ title: 'Hapus Akun Operator', message: `Hapus akun operator "${a.nama}"? Operator ini tidak akan bisa masuk lagi sampai mendaftar ulang.` })) return;
    try {
      const fb = window.gudangFirebase;
      // TANPA Cloud Functions: ini SOFT-DELETE. Dokumen profil di
      // operator/{uid} dihapus langsung (diizinkan firestore.rules
      // untuk isAdmin()), yang membuat operator ini langsung kehilangan
      // akses ke semua data (exists() check di rules gagal). Akun
      // Firebase Auth-nya sendiri TIDAK ikut terhapus (client SDK cuma
      // bisa hapus akun sendiri) — kalau perlu dibersihkan total, hapus
      // manual lewat Firebase Console > Authentication > Users.
      // `a.id` di sini adalah UID Firebase Auth (document ID di koleksi
      // operator), bukan NIK lagi.
      await fb.deleteDoc(fb.doc(fb.db, 'operator', a.id));
      showToast('Akun operator dinonaktifkan (profil dihapus). Akun Auth-nya masih ada di sistem — bersihkan manual lewat Firebase Console kalau perlu.');
      closeOperatorDetail();
    } catch (err) {
      showToast('Gagal menghapus akun: ' + err.message, 'error');
    }
  });
}

/* ---- Modal detail lokasi ---- */
function openLokasiModal(lokasi) {
  const all = buildLocationStock(currentEntries);
  const data = all.find(l => l.lokasi === lokasi);
  if (!data) return;

  // Kapasitas per lokasi spesifik: 43 pallet (lorong A-F) atau 47 pallet (lorong G-L)
  // Setiap lokasi individual punya batasan tersendiri untuk mencegah overstock.
  const kapasitasLokasi = cekKapasitasBlok(lokasi, 0, currentEntries);
  const pctLokasi = kapasitasLokasi.batas ? Math.min(100, Math.round((kapasitasLokasi.sekarang / kapasitasLokasi.batas) * 100)) : null;

  // Baris tabel = tiap BATCH kedatangan (transaksi MASUK) di lokasi ini,
  // bukan digabung/dinetkan per barang — supaya kelihatan riwayat
  // kedatangan barang satu-satu, dan operator bisa langsung klik satu
  // baris untuk membuka Detail Barang-nya.
  const batchRows = currentEntries
    .filter(t => t.lokasi === lokasi && t.jenis === 'masuk')
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);

  modalBody.innerHTML = `
    <div class="modal-item-head">
      <div class="modal-item-kode">LOKASI PENYIMPANAN</div>
      <h2 class="modal-item-nama mono">${escapeHtml(data.lokasi)}</h2>
    </div>
    <div class="modal-stat-grid modal-stat-grid-4">
      <div class="modal-stat"><span>Total Jenis Barang</span><strong>${data.itemCount}</strong></div>
      <div class="modal-stat"><span>Total PCS</span><strong>${data.totalQty.toLocaleString('id-ID')}</strong></div>
      <div class="modal-stat"><span>Total Pallet di Lokasi Ini</span><strong>${data.totalPallet ? roundPalletDisplay(data.totalPallet) : 0}</strong></div>
      <div class="modal-stat">
        <span>Kapasitas Maksimal Lokasi</span>
        <strong class="modal-stat-small${pctLokasi !== null && pctLokasi >= 100 ? ' neg' : ''}">${kapasitasLokasi.batas ? `${roundPalletDisplay(kapasitasLokasi.sekarang)} / ${kapasitasLokasi.batas.toLocaleString('id-ID')} pallet \u00b7 ${pctLokasi}%` : 'Lorong tidak terdaftar'}</strong>
      </div>
    </div>
    <div class="modal-section">
      <h4>Barang &amp; Batch di Lokasi Ini (${batchRows.length})</h4>
      <p class="modal-history-hint muted">Diurutkan dari kedatangan paling baru. Klik salah satu baris untuk lihat Detail Barangnya.</p>
      <div class="batch-table batch-table-lokasi">
        <div class="batch-table-row batch-table-head">
          <div class="btc btc-nama">Barang</div>
          <div class="btc btc-pemilik">Pemilik</div>
          <div class="btc btc-tanggal">Tanggal Kedatangan</div>
          <div class="btc btc-supplier">Supplier</div>
          <div class="btc btc-jumlah">Jumlah PCS</div>
          <div class="btc btc-pcspal">PCS/Pallet</div>
          <div class="btc btc-pallet">Pallet</div>
          <div class="btc btc-operator">Operator</div>
          <div class="btc btc-aksi-head">Aksi</div>
        </div>
        <div class="batch-table-body">
          ${batchRows.length ? batchRows.map(t => `
            <div class="batch-table-row" data-kode="${escapeHtml(t.kodeBarang || t.namaBarang || '')}" data-supplier="${escapeHtml(t.supplier || '')}" data-pemilik="${escapeHtml(t.pemilik || '')}">
              <div class="btc btc-nama" title="${escapeHtml(t.namaBarang || '-')}">${escapeHtml(t.namaBarang || '-')}</div>
              <div class="btc btc-pemilik">${escapeHtml(t.pemilik || '-')}</div>
              <div class="btc btc-tanggal">${formatTanggal(t.tanggal)}</div>
              <div class="btc btc-supplier">${escapeHtml(t.supplier || '-')}</div>
              <div class="btc btc-jumlah">${t.jumlah.toLocaleString('id-ID')} pcs</div>
              <div class="btc btc-pcspal">${t.qtyPerPallet ? t.qtyPerPallet.toLocaleString('id-ID') : '-'}</div>
              <div class="btc btc-pallet">${t.jumlahPallet ? roundPalletDisplay(t.jumlahPallet) : '-'}</div>
              <div class="btc btc-operator">${escapeHtml(t.operator || '-')}</div>
              <button type="button" class="btc-aksi" data-kode-aksi="${escapeHtml(t.kodeBarang || t.namaBarang || '')}" data-supplier-aksi="${escapeHtml(t.supplier || '')}" data-pemilik-aksi="${escapeHtml(t.pemilik || '')}" aria-label="Lihat detail barang" title="Detail Barang">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
            </div>
          `).join('') : `<div class="empty-state">Belum ada barang masuk yang tercatat di lokasi ini.</div>`}
        </div>
      </div>
    </div>
  `;
  modalBody.querySelectorAll('.batch-table-row[data-kode]').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.btc-aksi')) return;
      const kode = row.dataset.kode;
      if (kode) openComboModal(kode, row.dataset.supplier, row.dataset.pemilik);
    });
  });
  modalBody.querySelectorAll('.btc-aksi').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const kode = btn.dataset.kodeAksi;
      if (kode) openComboModal(kode, btn.dataset.supplierAksi, btn.dataset.pemilikAksi);
    });
  });
  itemModal.hidden = false;
}

/* ---- Modal detail KARTU KATALOG (satu kombinasi Barang + Supplier +
   Pemilik) ---- Ini yang dibuka saat kartu di panel "Katalog Barang"
   diklik. Beda dari openItemModal (yang menjumlahkan SEMUA supplier/
   pemilik untuk satu kode barang), modal ini hanya menghitung & menampilkan
   batch-batch kedatangan yang kombinasi Barang+Supplier+Pemilik-nya PERSIS
   sama dengan kartu yang diklik. ---- */
function openComboModal(kode, supplier, pemilik) {
  if (!kode) return;
  const combos = buildBarangComboList(currentEntries);
  const supplierKey = supplier || '-';
  const pemilikKey = pemilik || '-';
  const combo = combos.find(c => c.kode === kode && c.supplier === supplierKey && c.pemilik === pemilikKey);
  if (!combo) return;

  const stok = combo.masuk - combo.keluar;
  const totalPallet = (combo.masukPallet || 0) - (combo.keluarPallet || 0);
  const avgPcsPerPallet = totalPallet > 0
    ? Math.round(stok / totalPallet)
    : (() => {
        const lastMasukPallet = [...combo.history]
          .filter(t => t.jenis === 'masuk' && t.qtyPerPallet)
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        return lastMasukPallet ? lastMasukPallet.qtyPerPallet : null;
      })();
  const areaSet = new Set(Array.from(combo.lokasiSet || []).map(getAreaFromLokasi));

  // Baris tabel = tiap BATCH kedatangan (transaksi MASUK) untuk kombinasi
  // ini saja — bukan digabung/dinetkan, supaya kelihatan riwayat
  // kedatangannya satu-satu. Klik satu baris membuka Riwayat Transaksi
  // lengkap (masuk & keluar) kombinasi ini di lokasi tersebut.
  const batchRows = [...combo.history]
    .filter(t => t.jenis === 'masuk')
    .sort((a, b) => b.createdAt - a.createdAt);

  // Baris tabel kedua = tiap BATCH pengeluaran (transaksi KELUAR) untuk
  // kombinasi ini — ditampilkan berdampingan dengan batch kedatangan di
  // atas, supaya pemasukan & pengeluaran sama-sama kelihatan sekaligus
  // dan tidak bikin bingung.
  const batchRowsKeluar = [...combo.history]
    .filter(t => t.jenis === 'keluar')
    .sort((a, b) => b.createdAt - a.createdAt);

  modalBody.innerHTML = `
    <div class="modal-item-head">
      <div class="modal-item-kode mono">Kode Barang: ${escapeHtml(combo.kode || '-')}</div>
      <h2 class="modal-item-nama">${escapeHtml(combo.nama)}</h2>
    </div>

    <div class="modal-section-inline">
      <div><span class="lbl">🚚 Supplier</span><span>${escapeHtml(combo.supplier || '-')}</span></div>
      <div><span class="lbl">🏭 Pemilik Barang</span><span>${escapeHtml(combo.pemilik || '-')}</span></div>
    </div>

    <div class="modal-stat-grid modal-stat-grid-4">
      <div class="modal-stat"><span>Total PCS</span><strong class="${stok <= 0 ? 'neg' : ''}">${stok.toLocaleString('id-ID')}</strong></div>
      <div class="modal-stat"><span>Total Pallet</span><strong>${totalPallet ? roundPalletDisplay(totalPallet) : 0}</strong></div>
      <div class="modal-stat"><span>PCS per Pallet (Rata-rata)</span><strong>${avgPcsPerPallet ? avgPcsPerPallet.toLocaleString('id-ID') : '-'}</strong></div>
      <div class="modal-stat"><span>Area Penyimpanan</span><strong class="modal-stat-small">${escapeHtml(formatSetList(areaSet))}</strong></div>
    </div>

    <div class="modal-section">
      <h4>Lokasi &amp; Batch Kedatangan (${batchRows.length})</h4>
      <p class="modal-history-hint muted">Setiap baris adalah satu batch kedatangan untuk kombinasi barang + supplier + pemilik ini. Klik salah satu baris untuk lihat riwayat transaksinya.</p>
      <div class="batch-table">
        <div class="batch-table-row batch-table-head">
          <div class="btc btc-lokasi">Lokasi</div>
          <div class="btc btc-tanggal">Tanggal Kedatangan</div>
          <div class="btc btc-jumlah">Jumlah PCS</div>
          <div class="btc btc-pcspal">PCS per Pallet</div>
          <div class="btc btc-pallet">Total Pallet</div>
          <div class="btc btc-operator">Operator Input</div>
          <div class="btc btc-aksi-head">Aksi</div>
        </div>
        <div class="batch-table-body">
          ${batchRows.length ? batchRows.map(t => `
            <div class="batch-table-row" data-lokasi="${escapeHtml(t.lokasi || '')}">
              <div class="btc btc-lokasi mono">${escapeHtml(t.lokasi || '-')}</div>
              <div class="btc btc-tanggal">${formatTanggal(t.tanggal)}</div>
              <div class="btc btc-jumlah">${t.jumlah.toLocaleString('id-ID')} pcs</div>
              <div class="btc btc-pcspal">${t.qtyPerPallet ? t.qtyPerPallet.toLocaleString('id-ID') : '-'}</div>
              <div class="btc btc-pallet">${t.jumlahPallet ? roundPalletDisplay(t.jumlahPallet) : '-'}</div>
              <div class="btc btc-operator">${escapeHtml(t.operator || '-')}</div>
              <button type="button" class="btc-aksi" data-batch-lokasi="${escapeHtml(t.lokasi || '')}" aria-label="Lihat riwayat transaksi" title="Riwayat Transaksi">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
            </div>
          `).join('') : `<div class="empty-state">Belum ada batch masuk yang tercatat.</div>`}
        </div>
      </div>
    </div>

    <div class="modal-section">
      <h4>Lokasi &amp; Batch Pengeluaran (${batchRowsKeluar.length})</h4>
      <p class="modal-history-hint muted">Setiap baris adalah satu batch pengeluaran untuk kombinasi barang + supplier + pemilik ini. Klik salah satu baris untuk lihat riwayat transaksinya.</p>
      <div class="batch-table batch-table-keluar">
        <div class="batch-table-row batch-table-head">
          <div class="btc btc-lokasi">Lokasi</div>
          <div class="btc btc-tanggal">Tanggal Penginputan</div>
          <div class="btc btc-jumlah">Jumlah PCS</div>
          <div class="btc btc-pcspal">PCS per Pallet</div>
          <div class="btc btc-pallet">Total Pallet</div>
          <div class="btc btc-operator">Operator Input</div>
          <div class="btc btc-aksi-head">Aksi</div>
        </div>
        <div class="batch-table-body">
          ${batchRowsKeluar.length ? batchRowsKeluar.map(t => `
            <div class="batch-table-row" data-lokasi="${escapeHtml(t.lokasi || '')}">
              <div class="btc btc-lokasi mono">${escapeHtml(t.lokasi || '-')}</div>
              <div class="btc btc-tanggal">${formatTanggal(t.tanggal)}</div>
              <div class="btc btc-jumlah">${t.jumlah.toLocaleString('id-ID')} pcs</div>
              <div class="btc btc-pcspal">${t.qtyPerPallet ? t.qtyPerPallet.toLocaleString('id-ID') : '-'}</div>
              <div class="btc btc-pallet">${t.jumlahPallet ? roundPalletDisplay(t.jumlahPallet) : '-'}</div>
              <div class="btc btc-operator">${escapeHtml(t.operator || '-')}</div>
              <button type="button" class="btc-aksi" data-batch-lokasi-keluar="${escapeHtml(t.lokasi || '')}" aria-label="Lihat riwayat transaksi" title="Riwayat Transaksi">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
            </div>
          `).join('') : `<div class="empty-state">Belum ada batch keluar yang tercatat.</div>`}
        </div>
      </div>
    </div>
  `;
  modalBody.querySelectorAll('.batch-table:not(.batch-table-keluar) .batch-table-row[data-lokasi]').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.btc-aksi')) return;
      openComboRiwayatView(combo.kode, combo.supplier, combo.pemilik, row.dataset.lokasi);
    });
  });
  modalBody.querySelectorAll('.batch-table:not(.batch-table-keluar) .btc-aksi').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openComboRiwayatView(combo.kode, combo.supplier, combo.pemilik, btn.dataset.batchLokasi);
    });
  });
  modalBody.querySelectorAll('.batch-table-keluar .batch-table-row[data-lokasi]').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.btc-aksi')) return;
      openComboRiwayatView(combo.kode, combo.supplier, combo.pemilik, row.dataset.lokasi);
    });
  });
  modalBody.querySelectorAll('.batch-table-keluar .btc-aksi').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openComboRiwayatView(combo.kode, combo.supplier, combo.pemilik, btn.dataset.batchLokasiKeluar);
    });
  });
  itemModal.hidden = false;
}

// ---- Riwayat Transaksi untuk satu KOMBINASI (Barang + Supplier + Pemilik)
// di satu lokasi ---- Sama seperti openRiwayatTransaksiView, tapi hanya
// menampilkan transaksi yang kombinasi ketiganya persis sama dengan kartu
// katalog yang sedang dibuka (bukan semua transaksi kode barang itu di
// lokasi tsb, yang bisa saja tercampur dari supplier/pemilik lain).
function openComboRiwayatView(kode, supplier, pemilik, lokasi) {
  const combos = buildBarangComboList(currentEntries);
  const supplierKey = supplier || '-';
  const pemilikKey = pemilik || '-';
  const combo = combos.find(c => c.kode === kode && c.supplier === supplierKey && c.pemilik === pemilikKey);
  if (!combo) return;

  const historyDiLokasi = combo.history
    .filter(t => t.lokasi === lokasi)
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);

  modalBody.innerHTML = `
    <button type="button" class="modal-back-link" id="riwayat-back-btn">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>
      Kembali ke Detail Barang
    </button>
    <div class="modal-item-head" style="margin-top:10px;">
      <div class="modal-item-kode mono">Lokasi: ${escapeHtml(lokasi || '-')} · Supplier: ${escapeHtml(combo.supplier || '-')} · Pemilik: ${escapeHtml(combo.pemilik || '-')}</div>
      <h2 class="modal-item-nama">Riwayat Transaksi</h2>
      <div class="modal-item-sub muted">${escapeHtml(combo.nama)} <span class="mono">(${escapeHtml(combo.kode || '-')})</span></div>
    </div>
    <div class="riwayat-tx-list">
      ${historyDiLokasi.length ? historyDiLokasi.map(t => `
        <div class="riwayat-tx-card">
          <div class="riwayat-tx-top">
            <span class="badge-jenis ${t.jenis === 'masuk' ? 'badge-masuk' : 'badge-keluar'}">${t.jenis === 'masuk' ? 'MASUK' : 'KELUAR'}${t.tipe === 'penyesuaian' ? ' · Penyesuaian' : ''}</span>
            <span class="riwayat-tx-time" title="Tanggal &amp; jam form diisi">Diinput ${formatWaktu(t.createdAt)}</span>
          </div>
          <div class="riwayat-tx-grid">
            <div><span class="lbl">Jumlah PCS</span><span>${t.jumlah.toLocaleString('id-ID')} pcs</span></div>
            ${t.qtyPerPallet ? `<div><span class="lbl">PCS per Pallet</span><span>${t.qtyPerPallet.toLocaleString('id-ID')}</span></div>` : ''}
            ${t.jumlahPallet ? `<div><span class="lbl">Total Pallet</span><span>${roundPalletDisplay(t.jumlahPallet)}</span></div>` : ''}
            ${t.jenis === 'masuk' ? `<div><span class="lbl">Supplier</span><span>${escapeHtml(t.supplier || '-')}</span></div>` : ''}
            <div><span class="lbl">Kode Pemilik</span><span>${escapeHtml(t.pemilik || '-')}</span></div>
            <div><span class="lbl">${t.jenis === 'masuk' ? 'Tanggal Kedatangan' : 'Tanggal Penginputan'}</span><span>${formatTanggal(t.tanggal)}</span></div>
            <div><span class="lbl">Operator Input</span><span>${escapeHtml(t.operator || '-')}</span></div>
          </div>
          ${t.keterangan ? `<div class="riwayat-tx-note">${escapeHtml(t.keterangan)}</div>` : ''}
          ${(t.editLog && t.editLog.length)
            ? `<div class="riwayat-tx-note riwayat-tx-edited">✏️ ${t.editLog.length}× diedit — terakhir oleh ${escapeHtml(t.editLog[t.editLog.length - 1].oleh)} · ${formatWaktu(t.editLog[t.editLog.length - 1].waktu)}</div>`
            : ''}
        </div>
      `).join('') : `<div class="empty-state">Belum ada transaksi kombinasi ini di lokasi tersebut.</div>`}
    </div>
  `;
  document.getElementById('riwayat-back-btn')?.addEventListener('click', () => openComboModal(kode, supplier, pemilik));
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
      <div class="modal-stat"><span>Terakhir Diperbarui</span><strong class="modal-stat-small">${data.lastActivity ? formatWaktu(data.lastActivity) : '-'}</strong></div>
    </div>
    <div class="modal-section">
      <h4>Barang Terkait</h4>
      <div id="modal-attribute-stok-table" class="stok-table stok-table-modal"></div>
    </div>
  `;
  const container = modalBody.querySelector('#modal-attribute-stok-table');
  data.items.forEach(it => {
    const statusClass = it.stok > 0 ? 'pos' : (it.stok < 0 ? 'neg' : 'zero');
    const statusLabel = it.stok > 0 ? 'Stok Tersedia' : (it.stok < 0 ? 'Stok Minus' : 'Stok Kosong');
    appendStokRow(container, {
      nama: it.nama, sub: it.kode, subMono: true, stok: it.stok, statusClass, statusLabel,
      meta: [
        { icon: '📍', label: 'Lokasi', value: formatSetList(it.lokasiSet) },
        { icon: '🕒', label: 'Terakhir', value: it.lastActivity ? formatWaktu(it.lastActivity) : '-' },
      ],
      onClick: () => openItemModal(it.kode),
    });
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

// Ambil qty/pallet dari transaksi PALING BARU di masing-masing lokasi —
// dipakai untuk mengestimasi jumlah pallet dari stok yang sedang aktif.
// Ini estimasi (bukan angka pasti), karena aplikasi mencatat jumlah pallet
// per TRANSAKSI, bukan per satuan stok yang tersisa saat ini.
function lokasiPalletHint(history) {
  const map = {};
  [...history].sort((a, b) => a.createdAt - b.createdAt).forEach(t => {
    if (!t.lokasi || !t.qtyPerPallet) return;
    map[t.lokasi] = t.qtyPerPallet;
  });
  return map;
}

function openItemModal(kode, namaFallback) {
  if (!kode) return;
  const items = buildStokList(currentEntries);
  const item = items.find(i => i.kode === kode);

  // Barang ini belum pernah tercatat masuk/keluar sama sekali (misal baru
  // ditambahkan lewat Pengelolaan Barang tapi belum ada transaksi). Tetap
  // tampilkan modal dengan info dasar dari master data supaya klik dari
  // daftar Kode Barang tidak terasa "mati" / tidak merespons.
  if (!item) {
    const master = (MASTER_DATA.barang || []).find(b => b.kode === kode);
    const nama = namaFallback || master?.nama || kode;
    modalBody.innerHTML = `
      <div class="modal-item-head">
        <div class="modal-item-kode mono">Kode Barang: ${escapeHtml(kode)}</div>
        <h2 class="modal-item-nama">${escapeHtml(nama)}</h2>
      </div>
      <p class="muted" style="margin-top:-8px;">Barang ini belum pernah tercatat masuk/keluar, jadi belum ada stok maupun lokasi yang tercatat.</p>
    `;
    itemModal.hidden = false;
    return;
  }

  const stok = item.masuk - item.keluar;
  const totalPallet = (item.masukPallet || 0) - (item.keluarPallet || 0);
  const avgPcsPerPallet = totalPallet > 0
    ? Math.round(stok / totalPallet)
    : (() => {
        const lastMasukPallet = [...item.history]
          .filter(t => t.jenis === 'masuk' && t.qtyPerPallet)
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        return lastMasukPallet ? lastMasukPallet.qtyPerPallet : null;
      })();
  const areaSet = new Set(Array.from(item.lokasi || []).map(getAreaFromLokasi));

  // Baris tabel = tiap BATCH kedatangan (transaksi MASUK) barang ini,
  // ditampilkan per lokasi & tanggal — bukan digabung/dinetkan, supaya
  // kelihatan riwayat kedatangannya satu-satu. Klik satu baris membuka
  // Riwayat Transaksi lengkap (masuk & keluar) untuk lokasi tersebut.
  const batchRows = [...item.history]
    .filter(t => t.jenis === 'masuk')
    .sort((a, b) => b.createdAt - a.createdAt);

  // Baris tabel kedua = tiap BATCH pengeluaran (transaksi KELUAR) barang
  // ini, ditampilkan berdampingan dengan batch kedatangan di atas supaya
  // pemasukan & pengeluaran sama-sama terlihat sekaligus.
  const batchRowsKeluar = [...item.history]
    .filter(t => t.jenis === 'keluar')
    .sort((a, b) => b.createdAt - a.createdAt);

  modalBody.innerHTML = `
    <div class="modal-item-head">
      <div class="modal-item-kode mono">Kode Barang: ${escapeHtml(item.kode || '-')}</div>
      <h2 class="modal-item-nama">${escapeHtml(item.nama)}</h2>
    </div>

    <div class="modal-stat-grid modal-stat-grid-4">
      <div class="modal-stat"><span>Total PCS</span><strong class="${stok <= 0 ? 'neg' : ''}">${stok.toLocaleString('id-ID')}</strong></div>
      <div class="modal-stat"><span>Total Pallet</span><strong>${totalPallet ? roundPalletDisplay(totalPallet) : 0}</strong></div>
      <div class="modal-stat"><span>PCS per Pallet (Rata-rata)</span><strong>${avgPcsPerPallet ? avgPcsPerPallet.toLocaleString('id-ID') : '-'}</strong></div>
      <div class="modal-stat"><span>Area Penyimpanan</span><strong class="modal-stat-small">${escapeHtml(formatSetList(areaSet))}</strong></div>
    </div>

    <div class="modal-section-inline">
      <div><span class="lbl">🚚 Supplier</span><span>${escapeHtml(formatSetList(item.supplierSet))}</span></div>
      <div><span class="lbl">🏭 Pemilik Barang</span><span>${escapeHtml(formatSetList(item.pemilikSet))}</span></div>
    </div>

    <div class="modal-section">
      <h4>Lokasi &amp; Batch Barang Ini (${batchRows.length})</h4>
      <p class="modal-history-hint muted">Setiap baris adalah satu batch kedatangan. Klik salah satu baris untuk lihat riwayat transaksinya.</p>
      <div class="batch-table">
        <div class="batch-table-row batch-table-head">
          <div class="btc btc-lokasi">Lokasi</div>
          <div class="btc btc-tanggal">Tanggal Kedatangan</div>
          <div class="btc btc-jumlah">Jumlah PCS</div>
          <div class="btc btc-pcspal">PCS per Pallet</div>
          <div class="btc btc-pallet">Total Pallet</div>
          <div class="btc btc-operator">Operator Input</div>
          <div class="btc btc-aksi-head">Aksi</div>
        </div>
        <div class="batch-table-body">
          ${batchRows.length ? batchRows.map(t => `
            <div class="batch-table-row" data-lokasi="${escapeHtml(t.lokasi || '')}">
              <div class="btc btc-lokasi mono">${escapeHtml(t.lokasi || '-')}</div>
              <div class="btc btc-tanggal">${formatTanggal(t.tanggal)}</div>
              <div class="btc btc-jumlah">${t.jumlah.toLocaleString('id-ID')} pcs</div>
              <div class="btc btc-pcspal">${t.qtyPerPallet ? t.qtyPerPallet.toLocaleString('id-ID') : '-'}</div>
              <div class="btc btc-pallet">${t.jumlahPallet ? roundPalletDisplay(t.jumlahPallet) : '-'}</div>
              <div class="btc btc-operator">${escapeHtml(t.operator || '-')}</div>
              <button type="button" class="btc-aksi" data-batch-lokasi="${escapeHtml(t.lokasi || '')}" aria-label="Lihat riwayat transaksi" title="Riwayat Transaksi">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
            </div>
          `).join('') : `<div class="empty-state">Belum ada batch masuk yang tercatat.</div>`}
        </div>
      </div>
    </div>

    <div class="modal-section">
      <h4>Lokasi &amp; Batch Pengeluaran Barang Ini (${batchRowsKeluar.length})</h4>
      <p class="modal-history-hint muted">Setiap baris adalah satu batch pengeluaran. Klik salah satu baris untuk lihat riwayat transaksinya.</p>
      <div class="batch-table batch-table-keluar">
        <div class="batch-table-row batch-table-head">
          <div class="btc btc-lokasi">Lokasi</div>
          <div class="btc btc-tanggal">Tanggal Penginputan</div>
          <div class="btc btc-jumlah">Jumlah PCS</div>
          <div class="btc btc-pcspal">PCS per Pallet</div>
          <div class="btc btc-pallet">Total Pallet</div>
          <div class="btc btc-operator">Operator Input</div>
          <div class="btc btc-aksi-head">Aksi</div>
        </div>
        <div class="batch-table-body">
          ${batchRowsKeluar.length ? batchRowsKeluar.map(t => `
            <div class="batch-table-row" data-lokasi="${escapeHtml(t.lokasi || '')}">
              <div class="btc btc-lokasi mono">${escapeHtml(t.lokasi || '-')}</div>
              <div class="btc btc-tanggal">${formatTanggal(t.tanggal)}</div>
              <div class="btc btc-jumlah">${t.jumlah.toLocaleString('id-ID')} pcs</div>
              <div class="btc btc-pcspal">${t.qtyPerPallet ? t.qtyPerPallet.toLocaleString('id-ID') : '-'}</div>
              <div class="btc btc-pallet">${t.jumlahPallet ? roundPalletDisplay(t.jumlahPallet) : '-'}</div>
              <div class="btc btc-operator">${escapeHtml(t.operator || '-')}</div>
              <button type="button" class="btc-aksi" data-batch-lokasi-keluar="${escapeHtml(t.lokasi || '')}" aria-label="Lihat riwayat transaksi" title="Riwayat Transaksi">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
            </div>
          `).join('') : `<div class="empty-state">Belum ada batch keluar yang tercatat.</div>`}
        </div>
      </div>
    </div>
  `;
  modalBody.querySelectorAll('.batch-table:not(.batch-table-keluar) .batch-table-row[data-lokasi]').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.btc-aksi')) return;
      openRiwayatTransaksiView(item.kode, row.dataset.lokasi);
    });
  });
  modalBody.querySelectorAll('.batch-table:not(.batch-table-keluar) .btc-aksi').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openRiwayatTransaksiView(item.kode, btn.dataset.batchLokasi);
    });
  });
  modalBody.querySelectorAll('.batch-table-keluar .batch-table-row[data-lokasi]').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.btc-aksi')) return;
      openRiwayatTransaksiView(item.kode, row.dataset.lokasi);
    });
  });
  modalBody.querySelectorAll('.batch-table-keluar .btc-aksi').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openRiwayatTransaksiView(item.kode, btn.dataset.batchLokasiKeluar);
    });
  });
  itemModal.hidden = false;
}

// ---- Riwayat Transaksi (per barang + lokasi) ----
// Dibuka dari satu baris batch di Detail Barang (atau dari Detail Lokasi
// lewat Detail Barang). Menampilkan SEMUA transaksi (masuk & keluar,
// termasuk penyesuaian) barang tsb yang pernah terjadi di lokasi tsb,
// dari yang paling baru. Isi modal diganti di tempat (modal yang sama
// tetap terbuka), dengan tombol "Kembali" untuk balik ke Detail Barang.
function openRiwayatTransaksiView(kode, lokasi) {
  const items = buildStokList(currentEntries);
  const item = items.find(i => i.kode === kode);
  if (!item) return;

  const historyDiLokasi = item.history
    .filter(t => t.lokasi === lokasi)
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);
  const pemilikDiLokasi = formatSetList(new Set(historyDiLokasi.map(t => t.pemilik).filter(Boolean)));

  modalBody.innerHTML = `
    <button type="button" class="modal-back-link" id="riwayat-back-btn">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>
      Kembali ke Detail Barang
    </button>
    <div class="modal-item-head" style="margin-top:10px;">
      <div class="modal-item-kode mono">Lokasi: ${escapeHtml(lokasi || '-')} · Kode Pemilik: ${escapeHtml(pemilikDiLokasi)}</div>
      <h2 class="modal-item-nama">Riwayat Transaksi</h2>
      <div class="modal-item-sub muted">${escapeHtml(item.nama)} <span class="mono">(${escapeHtml(item.kode || '-')})</span></div>
    </div>
    <div class="riwayat-tx-list">
      ${historyDiLokasi.length ? historyDiLokasi.map(t => `
        <div class="riwayat-tx-card">
          <div class="riwayat-tx-top">
            <span class="badge-jenis ${t.jenis === 'masuk' ? 'badge-masuk' : 'badge-keluar'}">${t.jenis === 'masuk' ? 'MASUK' : 'KELUAR'}${t.tipe === 'penyesuaian' ? ' · Penyesuaian' : ''}</span>
            <span class="riwayat-tx-time" title="Tanggal &amp; jam form diisi">Diinput ${formatWaktu(t.createdAt)}</span>
          </div>
          <div class="riwayat-tx-grid">
            <div><span class="lbl">Jumlah PCS</span><span>${t.jumlah.toLocaleString('id-ID')} pcs</span></div>
            ${t.qtyPerPallet ? `<div><span class="lbl">PCS per Pallet</span><span>${t.qtyPerPallet.toLocaleString('id-ID')}</span></div>` : ''}
            ${t.jumlahPallet ? `<div><span class="lbl">Total Pallet</span><span>${roundPalletDisplay(t.jumlahPallet)}</span></div>` : ''}
            ${t.jenis === 'masuk' ? `<div><span class="lbl">Supplier</span><span>${escapeHtml(t.supplier || '-')}</span></div>` : ''}
            <div><span class="lbl">Kode Pemilik</span><span>${escapeHtml(t.pemilik || '-')}</span></div>
            <div><span class="lbl">${t.jenis === 'masuk' ? 'Tanggal Kedatangan' : 'Tanggal Penginputan'}</span><span>${formatTanggal(t.tanggal)}</span></div>
            <div><span class="lbl">Operator Input</span><span>${escapeHtml(t.operator || '-')}</span></div>
          </div>
          ${t.keterangan ? `<div class="riwayat-tx-note">${escapeHtml(t.keterangan)}</div>` : ''}
          ${(t.editLog && t.editLog.length)
            ? `<div class="riwayat-tx-note riwayat-tx-edited">✏️ ${t.editLog.length}× diedit — terakhir oleh ${escapeHtml(t.editLog[t.editLog.length - 1].oleh)} · ${formatWaktu(t.editLog[t.editLog.length - 1].waktu)}</div>`
            : ''}
        </div>
      `).join('') : `<div class="empty-state">Belum ada transaksi barang ini di lokasi tersebut.</div>`}
    </div>
  `;
  document.getElementById('riwayat-back-btn')?.addEventListener('click', () => openItemModal(kode));
  itemModal.hidden = false;
}

/* ==========================================================================
   RIWAYAT (admin)
========================================================================== */
const riwayatList = document.getElementById('riwayat-list');
const riwayatEmpty = document.getElementById('riwayat-empty');
const riwayatHint = document.getElementById('riwayat-hint');
const searchRiwayat = document.getElementById('search-riwayat');

const RIWAYAT_PAGE_SIZE = 50;
let riwayatQuerySignature = '';
let riwayatVisibleCount = RIWAYAT_PAGE_SIZE;

// Tombol Edit/Hapus pada tiap kartu Riwayat Laporan dinonaktifkan dulu atas
// permintaan — set true lagi kapan pun untuk mengembalikan fiturnya tanpa
// perlu menulis ulang kodenya (semua logikanya masih utuh di bawah).
const RIWAYAT_EDIT_HAPUS_AKTIF = false;

function buildTicketCard(t) {
  const isAdjustment = t.tipe === 'penyesuaian';
  // Untuk laporan KELUAR, t.tanggal adalah tanggal PENGINPUTAN — bukan
  // tanggal kedatangan barangnya. Cari tanggal kedatangan asli (transaksi
  // MASUK paling awal) dari kombinasi kode+supplier+pemilik+lokasi yang
  // sama, supaya admin tetap bisa lihat sudah berapa lama barang itu
  // tersimpan sebelum akhirnya keluar.
  const tanggalKedatanganAsal = t.jenis === 'keluar'
    ? getTanggalKedatanganKombinasi(currentEntries, t.kodeBarang, t.supplier, t.pemilik, t.lokasi)
    : null;
  const card = document.createElement('div');
  card.className = 'ticket';
  card.innerHTML = `
      <div class="ticket-top">
        <span class="badge-jenis ${t.jenis === 'masuk' ? 'badge-masuk' : 'badge-keluar'}">
          ${t.jenis === 'masuk' ? 'BARANG MASUK' : 'BARANG KELUAR'}
        </span>
        ${isAdjustment ? '<span class="badge-jenis badge-penyesuaian">PENYESUAIAN</span>' : ''}
        <span class="ticket-time">${formatWaktu(t.createdAt)}</span>
        ${RIWAYAT_EDIT_HAPUS_AKTIF ? `
        <span class="ticket-actions">
          <button type="button" class="icon-btn btn-edit" title="Edit lokasi / jumlah" aria-label="Edit">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </button>
          <button type="button" class="icon-btn danger btn-delete" title="Hapus" aria-label="Hapus">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </span>` : ''}
      </div>
      <div class="ticket-grid">
        <div><span class="lbl">Operator: </span>${escapeHtml(t.operator)}</div>
        <div><span class="lbl">Barang: </span><a class="link-barang" href="javascript:void(0)">${escapeHtml(t.namaBarang)}</a></div>
        <div><span class="lbl">Kode: </span><span class="mono">${escapeHtml(t.kodeBarang)}</span></div>
        <div><span class="lbl">Supplier: </span>${escapeHtml(t.supplier)}</div>
        <div><span class="lbl">Pemilik: </span>${escapeHtml(t.pemilik)}</div>
        <div class="ticket-lokasi-view"><span class="lbl">Lokasi: </span><button type="button" class="link-barang link-lokasi">${escapeHtml(t.lokasi)}</button></div>
        <div class="ticket-jumlah-view"><span class="lbl">Jumlah: </span>${fmtQty(t.jumlah)} pcs</div>
        ${t.qtyPerPallet != null ? `<div><span class="lbl">Qty/Pallet: </span>${fmtQty(t.qtyPerPallet)} pcs</div>` : ''}
        ${t.jumlahPallet != null ? `<div><span class="lbl">Jumlah Pallet: </span>${fmtQty(t.jumlahPallet)}</div>` : ''}
        <div><span class="lbl">${t.jenis === 'masuk' ? 'Tanggal Kedatangan' : 'Tanggal Penginputan'}: </span>${formatTanggal(t.tanggal)}</div>
        ${t.jenis === 'keluar' ? `<div><span class="lbl">Tanggal Kedatangan Barang: </span>${tanggalKedatanganAsal ? formatTanggal(tanggalKedatanganAsal) : '-'}</div>` : ''}
      </div>
      ${t.keterangan ? `<div class="ticket-note"><b>Keterangan:</b> ${escapeHtml(t.keterangan)}</div>` : ''}
      ${(t.editLog && t.editLog.length > 0) ? `<div class="ticket-note ticket-edited-note">✏️ Terakhir diedit oleh <b>${escapeHtml(t.editLog[t.editLog.length - 1].oleh)}</b> · ${formatWaktu(t.editLog[t.editLog.length - 1].waktu)}${t.editLog.length > 1 ? ` (${t.editLog.length}× diedit — lihat "Jejak Edit/Hapus" untuk detail)` : ''}</div>` : ''}
      ${RIWAYAT_EDIT_HAPUS_AKTIF ? `
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
      </div>` : ''}
    `;
  card.querySelector('.link-barang:not(.link-lokasi)').addEventListener('click', () => openItemModal(t.kodeBarang));
  card.querySelector('.link-lokasi').addEventListener('click', () => openLokasiModal(t.lokasi));

  if (RIWAYAT_EDIT_HAPUS_AKTIF) {
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

      // Simulasikan hasil edit (entri lama dibuang, diganti versi baru),
      // lalu pastikan stok di lokasi lama MAUPUN lokasi baru (kalau beda)
      // tidak jadi minus akibat perubahan ini.
      const entriesTanpaIni = currentEntries.filter(e => e.id !== t.id);
      const entriesSimulasi = [...entriesTanpaIni, { ...t, lokasi: newLokasi, jumlah: newJumlah }];
      const lokasiTerdampak = new Set([t.lokasi, newLokasi]);
      for (const lok of lokasiTerdampak) {
        const stokSimulasi = getStokAtLokasi(entriesSimulasi, t.kodeBarang, lok);
        if (stokSimulasi < 0) {
          return showToast(`Perubahan ini membuat stok "${t.namaBarang}" di lokasi ${lok} jadi minus (${stokSimulasi.toLocaleString('id-ID')} pcs). Sesuaikan jumlah atau lokasinya.`, 'error');
        }
      }

      // ---- BLOKIR KAPASITAS BLOK — Edit Laporan ----
      // Kalau laporan yang diedit ini BARANG MASUK dan lokasinya diubah,
      // pallet-nya (t.jumlahPallet, tidak berubah oleh edit ini) akan
      // "pindah" dari lokasi lama ke lokasi baru. Pastikan lokasi baru tidak jadi
      // melebihi kapasitas akibat perpindahan ini — entriesTanpaIni dipakai
      // sebagai basis (laporan ini sendiri dikeluarkan dulu) supaya
      // kontribusi lamanya tidak ikut terhitung dobel di lokasi baru.
      if (t.jenis === 'masuk' && t.jumlahPallet) {
        const cekEdit = cekKapasitasBlok(newLokasi, t.jumlahPallet, entriesTanpaIni);
        if (!cekEdit.ok) {
          return showToast(
            `Perubahan lokasi ke ${escapeHtml(cekEdit.lokasi)} melebihi kapasitas.\n` +
            `Dibutuhkan: ${roundPalletDisplay(t.jumlahPallet)} pallet\n` +
            `Sisa kapasitas: hanya ${roundPalletDisplay(cekEdit.sisa)} dari batas ${cekEdit.batas.toLocaleString('id-ID')} pallet.\n` +
            `Pilih lokasi lain atau batalkan perubahan.`, 'error'
          );
        }
      }

      try {
        const session = getSession();
        const oleh = (session && session.nama) || 'Admin';
        const waktu = Date.now();
        const adaPerubahan = t.lokasi !== newLokasi || t.jumlah !== newJumlah || (t.keterangan || '') !== newKeterangan;
        const editLogBaru = adaPerubahan
          ? [...(t.editLog || []), {
              oleh, waktu,
              lokasiLama: t.lokasi, lokasiBaru: newLokasi,
              jumlahLama: t.jumlah, jumlahBaru: newJumlah,
            }]
          : (t.editLog || []);
        await updateEntryInFirestore(t.id, {
          lokasi: newLokasi, jumlah: newJumlah, keterangan: newKeterangan,
          updatedAt: waktu, editLog: editLogBaru,
        });
        showToast('Laporan berhasil diperbarui.');
      } catch (err) {
        showToast('Gagal menyimpan perubahan: ' + err.message, 'error');
      }
    });

    card.querySelector('.btn-delete').addEventListener('click', async () => {
      if (!await showConfirmModal({ title: 'Hapus Laporan', message: 'Hapus laporan ini? Tindakan ini tidak dapat dibatalkan.' })) return;
      if (!firestoreReady) return showToast('Database tidak terhubung.', 'error');
      const session = getSession();
      const oleh = (session && session.nama) || 'Admin';
      try {
        await softDeleteEntryFromFirestore(t.id, oleh);
        showToast('Laporan dihapus.');
      } catch (err) {
        showToast('Gagal menghapus: ' + err.message, 'error');
      }
    });
  }
  return card;
}

let riwayatJejakMode = false;

function updateJejakBadge() {
  const badge = document.getElementById('jejak-count-badge');
  if (!badge) return;
  const count = currentEntriesRaw.filter(t => t.dihapus || (t.editLog && t.editLog.length > 0)).length;
  if (count > 0) { badge.hidden = false; badge.textContent = count > 99 ? '99+' : count; }
  else badge.hidden = true;
}

function buildJejakCard(t) {
  const card = document.createElement('div');
  card.className = 'ticket ticket-jejak' + (t.dihapus ? ' ticket-dihapus' : '');
  const editLog = t.editLog || [];
  const editRows = editLog.slice().reverse().map(e => {
    const perubahan = [];
    if (e.lokasiLama !== e.lokasiBaru) perubahan.push(`Lokasi: ${escapeHtml(e.lokasiLama)} → ${escapeHtml(e.lokasiBaru)}`);
    if (e.jumlahLama !== e.jumlahBaru) perubahan.push(`Jumlah: ${fmtQty(e.jumlahLama)} → ${fmtQty(e.jumlahBaru)} pcs`);
    return `
      <div class="jejak-log-row">
        <span class="jejak-log-oleh">✏️ ${escapeHtml(e.oleh)}</span>
        <span class="jejak-log-waktu">${formatWaktu(e.waktu)}</span>
        <span class="jejak-log-detail">${perubahan.join(' · ') || 'Keterangan diubah'}</span>
      </div>
    `;
  }).join('');
  card.innerHTML = `
    <div class="ticket-top">
      <span class="badge-jenis ${t.jenis === 'masuk' ? 'badge-masuk' : 'badge-keluar'}">${t.jenis === 'masuk' ? 'BARANG MASUK' : 'BARANG KELUAR'}</span>
      ${t.dihapus ? '<span class="badge-jenis badge-dihapus">DIHAPUS</span>' : ''}
      <span class="ticket-time">Dibuat ${formatWaktu(t.createdAt)}</span>
    </div>
    <div class="ticket-grid">
      <div><span class="lbl">Operator asal: </span>${escapeHtml(t.operator)}</div>
      <div><span class="lbl">Barang: </span>${escapeHtml(t.namaBarang)}</div>
      <div><span class="lbl">Kode: </span><span class="mono">${escapeHtml(t.kodeBarang)}</span></div>
      <div><span class="lbl">Lokasi saat ini: </span>${escapeHtml(t.lokasi)}</div>
      <div><span class="lbl">Jumlah saat ini: </span>${fmtQty(t.jumlah)} pcs</div>
    </div>
    ${t.dihapus ? `<div class="jejak-dihapus-note">🗑 Dihapus oleh <b>${escapeHtml(t.dihapusOleh || '-')}</b> · ${formatWaktu(t.dihapusAt)}</div>` : ''}
    ${editRows ? `<div class="jejak-log-list">${editRows}</div>` : ''}
  `;
  return card;
}

function renderJejak() {
  const jejak = currentEntriesRaw.filter(t => t.dihapus || (t.editLog && t.editLog.length > 0));
  jejak.sort((a, b) => {
    const waktuA = Math.max(a.dihapusAt || 0, a.editLog && a.editLog.length ? a.editLog[a.editLog.length - 1].waktu : 0);
    const waktuB = Math.max(b.dihapusAt || 0, b.editLog && b.editLog.length ? b.editLog[b.editLog.length - 1].waktu : 0);
    return waktuB - waktuA;
  });
  riwayatHint.textContent = `Jejak edit & hapus — ${jejak.length.toLocaleString('id-ID')} laporan pernah diubah/dihapus (semua periode, tidak dipengaruhi filter periode di atas).`;
  riwayatList.innerHTML = '';
  if (jejak.length === 0) {
    riwayatEmpty.hidden = false;
    riwayatEmpty.textContent = 'Belum ada laporan yang pernah diedit atau dihapus. 👍';
    return;
  }
  riwayatEmpty.hidden = true;
  const fragment = document.createDocumentFragment();
  jejak.forEach(t => fragment.appendChild(buildJejakCard(t)));
  riwayatList.appendChild(fragment);
}

function renderRiwayat() {
  if (currentRole() !== 'admin') return;
  updateJejakBadge();
  if (riwayatJejakMode) { renderJejak(); return; }

  const range = getPeriodRange(periodMode, periodDate);
  riwayatHint.textContent = `Menampilkan laporan periode: ${range.label}`;

  let all = currentEntries.filter(t => inPeriod(t, range));
  all = all.sort((a, b) => b.createdAt - a.createdAt);

  const q = searchRiwayat.value.trim().toLowerCase();
  const filtered = q
    ? all.filter(t => t.operator.toLowerCase().includes(q) || t.namaBarang.toLowerCase().includes(q) || t.kodeBarang.includes(q))
    : all;

  // Reset ke halaman pertama tiap kali periode/pencarian beda — tapi kalau
  // cuma data yang berubah (laporan baru masuk real-time) sambil user lagi
  // scroll di bagian bawah, posisi "sudah dimuat sampai mana" dipertahankan.
  const signature = range.label + '|' + q;
  if (signature !== riwayatQuerySignature) {
    riwayatQuerySignature = signature;
    riwayatVisibleCount = RIWAYAT_PAGE_SIZE;
  }

  riwayatList.innerHTML = '';
  if (filtered.length === 0) {
    riwayatEmpty.hidden = false;
    riwayatEmpty.textContent = all.length === 0 ? 'Belum ada laporan pada periode ini.' : 'Tidak ada laporan yang cocok dengan pencarian.';
    return;
  }
  riwayatEmpty.hidden = true;

  // Render sebagian dulu (bukan sekaligus semua) — penting kalau datanya
  // sudah ribuan baris, biar HP gak lag pas buka periode "Semua".
  const visible = filtered.slice(0, riwayatVisibleCount);
  const fragment = document.createDocumentFragment();
  visible.forEach(t => fragment.appendChild(buildTicketCard(t)));
  riwayatList.appendChild(fragment);

  if (filtered.length > riwayatVisibleCount) {
    const sisa = filtered.length - riwayatVisibleCount;
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.type = 'button';
    loadMoreBtn.className = 'btn-load-more';
    loadMoreBtn.textContent = `Muat ${Math.min(RIWAYAT_PAGE_SIZE, sisa).toLocaleString('id-ID')} laporan berikutnya — sudah ditampilkan ${riwayatVisibleCount.toLocaleString('id-ID')} dari ${filtered.length.toLocaleString('id-ID')}`;
    loadMoreBtn.addEventListener('click', () => {
      riwayatVisibleCount += RIWAYAT_PAGE_SIZE;
      renderRiwayat();
    });
    riwayatList.appendChild(loadMoreBtn);
  }
}

searchRiwayat.addEventListener('input', renderRiwayat);

/* ---- Toggle "Jejak" (laporan yang pernah diedit/dihapus) ---- */
const btnToggleJejak = document.getElementById('btn-toggle-jejak');
if (btnToggleJejak) {
  btnToggleJejak.addEventListener('click', () => {
    riwayatJejakMode = !riwayatJejakMode;
    btnToggleJejak.classList.toggle('is-active', riwayatJejakMode);
    renderRiwayat();
  });
}



/* ==========================================================================
   RIWAYAT LAPORAN SAYA (operator) — versi ringkas & baca-saja dari
   renderRiwayat() di atas. Hanya menampilkan laporan yang "operator"-nya
   sama dengan nama operator yang sedang login (tidak dibatasi periode
   seperti punya admin, supaya operator tetap bisa lihat laporan lamanya).
========================================================================== */
const riwayatOpList = document.getElementById('riwayat-op-list');
const riwayatOpEmpty = document.getElementById('riwayat-op-empty');
const searchRiwayatOp = document.getElementById('search-riwayat-op');

function renderRiwayatOperator() {
  if (currentRole() !== 'operator' || !riwayatOpList) return;
  const session = getSession();
  const namaSaya = (session && session.nama || '').trim().toLowerCase();

  let mine = currentEntries.filter(t => (t.operator || '').trim().toLowerCase() === namaSaya);
  mine = mine.sort((a, b) => b.createdAt - a.createdAt);

  const q = (searchRiwayatOp && searchRiwayatOp.value.trim().toLowerCase()) || '';
  const filtered = q
    ? mine.filter(t => t.namaBarang.toLowerCase().includes(q) || t.kodeBarang.toLowerCase().includes(q))
    : mine;

  riwayatOpList.innerHTML = '';
  if (filtered.length === 0) {
    riwayatOpEmpty.hidden = false;
    riwayatOpEmpty.textContent = mine.length === 0 ? 'Anda belum memasukkan laporan apapun.' : 'Tidak ada laporan yang cocok dengan pencarian.';
    return;
  }
  riwayatOpEmpty.hidden = true;

  filtered.forEach(t => {
    const isAdjustment = t.tipe === 'penyesuaian';
    // Untuk laporan KELUAR, t.tanggal adalah tanggal PENGINPUTAN — bukan
    // tanggal kedatangan barangnya. Cari tanggal kedatangan asli (transaksi
    // MASUK paling awal) dari kombinasi kode+supplier+pemilik+lokasi yang
    // sama, supaya operator juga bisa lihat sudah berapa lama barang itu
    // tersimpan sebelum akhirnya keluar (sama seperti kartu admin).
    const tanggalKedatanganAsal = t.jenis === 'keluar'
      ? getTanggalKedatanganKombinasi(currentEntries, t.kodeBarang, t.supplier, t.pemilik, t.lokasi)
      : null;
    const card = document.createElement('div');
    card.className = 'ticket';
    card.innerHTML = `
      <div class="ticket-top">
        <span class="badge-jenis ${t.jenis === 'masuk' ? 'badge-masuk' : 'badge-keluar'}">
          ${t.jenis === 'masuk' ? 'BARANG MASUK' : 'BARANG KELUAR'}
        </span>
        ${isAdjustment ? '<span class="badge-jenis badge-penyesuaian">PENYESUAIAN</span>' : ''}
        <span class="ticket-time">${formatWaktu(t.createdAt)}</span>
      </div>
      <div class="ticket-grid">
        <div><span class="lbl">Barang: </span><a class="link-barang" href="javascript:void(0)">${escapeHtml(t.namaBarang)}</a></div>
        <div><span class="lbl">Kode: </span><span class="mono">${escapeHtml(t.kodeBarang)}</span></div>
        <div><span class="lbl">Supplier: </span>${escapeHtml(t.supplier || '-')}</div>
        <div><span class="lbl">Pemilik: </span>${escapeHtml(t.pemilik || '-')}</div>
        <div class="ticket-lokasi-view"><span class="lbl">Lokasi: </span><button type="button" class="link-barang link-lokasi">${escapeHtml(t.lokasi)}</button></div>
        <div class="ticket-jumlah-view"><span class="lbl">Jumlah: </span>${fmtQty(t.jumlah)} pcs</div>
        ${t.qtyPerPallet != null ? `<div><span class="lbl">Qty/Pallet: </span>${fmtQty(t.qtyPerPallet)} pcs</div>` : ''}
        ${t.jumlahPallet != null ? `<div><span class="lbl">Jumlah Pallet: </span>${fmtQty(t.jumlahPallet)}</div>` : ''}
        <div><span class="lbl">${t.jenis === 'masuk' ? 'Tanggal Kedatangan' : 'Tanggal Penginputan'}: </span>${formatTanggal(t.tanggal)}</div>
        ${t.jenis === 'keluar' ? `<div><span class="lbl">Tanggal Kedatangan Barang: </span>${tanggalKedatanganAsal ? formatTanggal(tanggalKedatanganAsal) : '-'}</div>` : ''}
      </div>
      ${t.keterangan ? `<div class="ticket-note"><b>Keterangan:</b> ${escapeHtml(t.keterangan)}</div>` : ''}
      ${(t.editLog && t.editLog.length > 0) ? `<div class="ticket-note ticket-edited-note">✏️ Terakhir diedit oleh <b>${escapeHtml(t.editLog[t.editLog.length - 1].oleh)}</b> · ${formatWaktu(t.editLog[t.editLog.length - 1].waktu)}${t.editLog.length > 1 ? ` (${t.editLog.length}× diedit)` : ''}</div>` : ''}
    `;
    card.querySelector('.link-barang:not(.link-lokasi)').addEventListener('click', () => openItemModal(t.kodeBarang));
    card.querySelector('.link-lokasi').addEventListener('click', () => openLokasiModal(t.lokasi));
    riwayatOpList.appendChild(card);
  });
}

if (searchRiwayatOp) searchRiwayatOp.addEventListener('input', renderRiwayatOperator);

/* ==========================================================================
   EXPORT EXCEL & HAPUS SEMUA (admin)
========================================================================== */
document.getElementById('btn-export').addEventListener('click', async () => {
  if (currentEntries.length === 0) {
    showToast('Belum ada data untuk diunduh.', 'error');
    return;
  }
  const btnExportEl = document.getElementById('btn-export');
  const originalLabel = btnExportEl.innerHTML;
  btnExportEl.disabled = true;
  btnExportEl.textContent = 'Menyiapkan file...';
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Sistem Gudang';
    workbook.created = new Date();

    // Ringkasan Stok ditaruh sebagai tab pertama supaya langsung kelihatan
    // saat file dibuka.
    addStokSheet(workbook, RINGKASAN_SHEET, currentEntries);

    const groups = {};
    currentEntries.forEach(t => {
      const ym = (t.tanggal && /^\d{4}-\d{2}/.test(t.tanggal)) ? t.tanggal.slice(0, 7) : 'lainnya';
      (groups[ym] = groups[ym] || []).push(t);
    });
    Object.keys(groups).sort().forEach(ym => {
      const list = groups[ym].slice().sort((a, b) => (a.tanggal !== b.tanggal ? (a.tanggal < b.tanggal ? -1 : 1) : a.createdAt - b.createdAt));
      const label = ym === 'lainnya' ? 'Lainnya' : `${BULAN_PANJANG[parseInt(ym.split('-')[1], 10) - 1]} ${ym.split('-')[0]}`;
      addMonthSheet(workbook, safeSheetName(label), list);
    });

    await downloadExcelWorkbook(workbook, `salinan-laporan-gudang-${todayISO()}.xlsx`);
    showToast('Salinan cadangan berhasil diunduh.');
  } catch (err) {
    console.error('Gagal membuat file Excel:', err);
    showToast('Gagal membuat file Excel: ' + err.message, 'error');
  } finally {
    btnExportEl.disabled = false;
    btnExportEl.innerHTML = originalLabel;
  }
});

/* ==========================================================================
   STARTUP
========================================================================== */
(async function start() {
  const existing = getSession();
  if (existing) {
    // Tunggu Firebase Auth selesai memulihkan sesi (dari reload di tab
    // yang sama) SEBELUM memasang listener Firestore — kalau tidak,
    // listener bisa terpasang lebih dulu dan gagal dengan
    // permission-denied karena request.auth belum terisi.
    try {
      await waitForFirebaseAuth();
    } catch (err) {
      console.warn('Menunggu Firebase Auth saat startup gagal/timeout:', err);
    }
    const fb = window.gudangFirebase;
    let stillValid = false;
    if (fb && fb.currentUser) {
      // Sesi Firebase Auth-nya masih ada, tapi tetap cek ulang dokumen
      // profil Firestore-nya — kalau sudah dihapus admin (soft-delete)
      // sejak sesi ini dibuat, akun ini harus dianggap sudah tidak aktif
      // walau token Auth-nya sendiri masih valid.
      try {
        const snap = await fb.getDoc(fb.doc(fb.db, existing.role, fb.currentUser.uid));
        stillValid = snap.exists();
      } catch (err) {
        console.warn('Gagal memverifikasi ulang profil saat startup:', err);
      }
    }
    if (stillValid) {
      enterApp(existing);
    } else {
      // Sesi aplikasi (sessionStorage) ada, tapi sesi Firebase Auth sudah
      // tidak ada / profil sudah dihapus — anggap sudah logout supaya
      // tidak menampilkan aplikasi tanpa akses data yang sesungguhnya.
      clearSession();
      try { await fb?.signOut(fb.auth); } catch (err) { /* abaikan */ }
      switchLoginTab('operator');
      loginOperatorNik.focus();
    }
  } else {
    switchLoginTab('operator');
    loginOperatorNik.focus();
  }
})();

window.addEventListener('gudang-firebase-auth-error', () => {
  setConnectUI('error');
});