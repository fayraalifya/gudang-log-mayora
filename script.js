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
   KATALOG MANAGEMENT — ADMIN PANEL (BARANG, SUPPLIER, PEMILIK, LOKASI)
========================================================================== */

class KatalogManager {
  constructor() {
    this.barangEditing = null;
    this.supplierEditing = null;
    this.pemilikEditing = null;
    this.lokasiEditing = null;
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

    // Supplier
    document.getElementById('btn-tambah-supplier')?.addEventListener('click', () => this.openSupplierForm());
    document.getElementById('form-supplier')?.addEventListener('submit', (e) => this.saveSupplier(e));
    document.getElementById('search-supplier')?.addEventListener('input', (e) => this.filterSupplier(e.target.value));

    // Pemilik
    document.getElementById('btn-tambah-pemilik')?.addEventListener('click', () => this.openPemilikForm());
    document.getElementById('form-pemilik')?.addEventListener('submit', (e) => this.savePemilik(e));
    document.getElementById('search-pemilik')?.addEventListener('input', (e) => this.filterPemilik(e.target.value));

    // Lokasi
    document.getElementById('btn-tambah-lokasi')?.addEventListener('click', () => this.openLokasiForm());
    document.getElementById('form-lokasi')?.addEventListener('submit', (e) => this.saveLokasi(e));
    document.getElementById('search-lokasi')?.addEventListener('input', (e) => this.filterLokasi(e.target.value));

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

    // Subscribe to updates
    if (window.gudangFirebase?.barangBaruCol) {
      window.gudangFirebase.onSnapshot(window.gudangFirebase.barangBaruCol, () => {
        this.renderBarangList();
      });
    }
    if (window.gudangFirebase?.pemilikBaruCol) {
      window.gudangFirebase.onSnapshot(window.gudangFirebase.pemilikBaruCol, () => {
        this.renderPemilikList();
      });
    }
  }

  renderBarangList(filter = '') {
    const container = document.getElementById('barang-list');
    const empty = document.getElementById('barang-empty');
    if (!container) return;

    let barang = [...(MASTER_DATA.barang || [])];
    if (filter) {
      const q = filter.toLowerCase();
      barang = barang.filter(b => 
        (b.kode || '').toLowerCase().includes(q) || 
        (b.nama || '').toLowerCase().includes(q)
      );
    }

    if (barang.length === 0) {
      container.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    container.innerHTML = barang.map(b => `
      <div class="katalog-item">
        <div class="katalog-item-info">
          <div class="katalog-item-label">${escapeHtml(b.kode || '-')}</div>
          <div class="katalog-item-sub">${escapeHtml(b.nama || '-')}</div>
        </div>
        <div class="katalog-item-actions">
          <button type="button" class="btn-katalog-edit" data-action="edit-barang" data-kode="${escapeHtml(b.kode || '')}">Edit</button>
          <button type="button" class="btn-katalog-delete" data-action="delete-barang" data-kode="${escapeHtml(b.kode || '')}">Hapus</button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('[data-action="edit-barang"]').forEach(btn => {
      btn.addEventListener('click', () => this.editBarang(btn.dataset.kode));
    });
    container.querySelectorAll('[data-action="delete-barang"]').forEach(btn => {
      btn.addEventListener('click', () => this.deleteBarang(btn.dataset.kode));
    });
  }

  filterBarang(value) {
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
      if (this.barangEditing) {
        // Edit existing
        const idx = (MASTER_DATA.barang || []).findIndex(b => b.kode === this.barangEditing);
        if (idx >= 0) {
          MASTER_DATA.barang[idx] = { kode, nama };
          localStorage.setItem('gudang_master_barang', JSON.stringify(MASTER_DATA.barang));
        }
      } else {
        // Add new
        const exists = (MASTER_DATA.barang || []).some(b => b.kode === kode);
        if (exists) {
          errorBox.textContent = 'Kode barang sudah ada!';
          errorBox.hidden = false;
          return;
        }
        MASTER_DATA.barang.push({ kode, nama });
        localStorage.setItem('gudang_master_barang', JSON.stringify(MASTER_DATA.barang));
      }

      showToast('Barang berhasil disimpan');
      this.closeBarangForm();
      this.renderBarangList();
      BARANG_OPTIONS = MASTER_DATA.barang;
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }
  }

  editBarang(kode) {
    this.openBarangForm(kode);
  }

  deleteBarang(kode) {
    if (!confirm(`Hapus kode barang "${kode}"? Tindakan ini tidak dapat dibatalkan.`)) return;
    try {
      MASTER_DATA.barang = (MASTER_DATA.barang || []).filter(b => b.kode !== kode);
      localStorage.setItem('gudang_master_barang', JSON.stringify(MASTER_DATA.barang));
      showToast('Kode barang berhasil dihapus');
      this.renderBarangList();
      BARANG_OPTIONS = MASTER_DATA.barang;
    } catch (err) {
      showToast('Gagal menghapus barang: ' + err.message, 'error');
    }
  }

  // ========== SUPPLIER ==========
  renderSupplierList(filter = '') {
    const container = document.getElementById('supplier-list');
    const empty = document.getElementById('supplier-empty');
    if (!container) return;

    let supplier = [...(MASTER_DATA.supplier || [])];
    if (filter) {
      const q = filter.toLowerCase();
      supplier = supplier.filter(s => (s || '').toLowerCase().includes(q));
    }

    if (supplier.length === 0) {
      container.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    container.innerHTML = supplier.map(s => `
      <div class="katalog-item">
        <div class="katalog-item-info">
          <div class="katalog-item-label">${escapeHtml(s || '-')}</div>
        </div>
        <div class="katalog-item-actions">
          <button type="button" class="btn-katalog-edit" data-action="edit-supplier" data-nama="${escapeHtml(s || '')}">Edit</button>
          <button type="button" class="btn-katalog-delete" data-action="delete-supplier" data-nama="${escapeHtml(s || '')}">Hapus</button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('[data-action="edit-supplier"]').forEach(btn => {
      btn.addEventListener('click', () => this.editSupplier(btn.dataset.nama));
    });
    container.querySelectorAll('[data-action="delete-supplier"]').forEach(btn => {
      btn.addEventListener('click', () => this.deleteSupplier(btn.dataset.nama));
    });
  }

  filterSupplier(value) {
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
      if (this.supplierEditing) {
        // Edit: hapus yang lama, tambah yang baru
        MASTER_DATA.supplier = (MASTER_DATA.supplier || []).filter(s => s !== this.supplierEditing);
        if (!MASTER_DATA.supplier.includes(nama)) {
          MASTER_DATA.supplier.push(nama);
        }
      } else {
        // Add new
        const exists = (MASTER_DATA.supplier || []).some(s => s === nama);
        if (exists) {
          errorBox.textContent = 'Supplier sudah ada!';
          errorBox.hidden = false;
          return;
        }
        MASTER_DATA.supplier.push(nama);
      }

      MASTER_DATA.supplier.sort();
      localStorage.setItem('gudang_master_supplier', JSON.stringify(MASTER_DATA.supplier));
      showToast('Supplier berhasil disimpan');
      this.closeSupplierForm();
      this.renderSupplierList();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }
  }

  editSupplier(nama) {
    this.openSupplierForm(nama);
  }

  deleteSupplier(nama) {
    if (!confirm(`Hapus supplier "${nama}"? Tindakan ini tidak dapat dibatalkan.`)) return;
    try {
      MASTER_DATA.supplier = (MASTER_DATA.supplier || []).filter(s => s !== nama);
      localStorage.setItem('gudang_master_supplier', JSON.stringify(MASTER_DATA.supplier));
      showToast('Supplier berhasil dihapus');
      this.renderSupplierList();
    } catch (err) {
      showToast('Gagal menghapus supplier: ' + err.message, 'error');
    }
  }

  // ========== PEMILIK ==========
  renderPemilikList(filter = '') {
    const container = document.getElementById('pemilik-list');
    const empty = document.getElementById('pemilik-empty');
    if (!container) return;

    let pemilik = [...(MASTER_DATA.pemilik || [])];
    if (filter) {
      const q = filter.toLowerCase();
      pemilik = pemilik.filter(p => (p || '').toLowerCase().includes(q));
    }

    if (pemilik.length === 0) {
      container.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    container.innerHTML = pemilik.map(p => `
      <div class="katalog-item">
        <div class="katalog-item-info">
          <div class="katalog-item-label">${escapeHtml(p || '-')}</div>
        </div>
        <div class="katalog-item-actions">
          <button type="button" class="btn-katalog-edit" data-action="edit-pemilik" data-nama="${escapeHtml(p || '')}">Edit</button>
          <button type="button" class="btn-katalog-delete" data-action="delete-pemilik" data-nama="${escapeHtml(p || '')}">Hapus</button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('[data-action="edit-pemilik"]').forEach(btn => {
      btn.addEventListener('click', () => this.editPemilik(btn.dataset.nama));
    });
    container.querySelectorAll('[data-action="delete-pemilik"]').forEach(btn => {
      btn.addEventListener('click', () => this.deletePemilik(btn.dataset.nama));
    });
  }

  filterPemilik(value) {
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
      if (this.pemilikEditing) {
        MASTER_DATA.pemilik = (MASTER_DATA.pemilik || []).filter(p => p !== this.pemilikEditing);
        if (!MASTER_DATA.pemilik.includes(nama)) {
          MASTER_DATA.pemilik.push(nama);
        }
      } else {
        const exists = (MASTER_DATA.pemilik || []).some(p => p === nama);
        if (exists) {
          errorBox.textContent = 'Pemilik sudah ada!';
          errorBox.hidden = false;
          return;
        }
        MASTER_DATA.pemilik.push(nama);
      }

      MASTER_DATA.pemilik.sort();
      localStorage.setItem('gudang_master_pemilik', JSON.stringify(MASTER_DATA.pemilik));
      showToast('Pemilik berhasil disimpan');
      this.closePemilikForm();
      this.renderPemilikList();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }
  }

  editPemilik(nama) {
    this.openPemilikForm(nama);
  }

  deletePemilik(nama) {
    if (!confirm(`Hapus pemilik "${nama}"? Tindakan ini tidak dapat dibatalkan.`)) return;
    try {
      MASTER_DATA.pemilik = (MASTER_DATA.pemilik || []).filter(p => p !== nama);
      localStorage.setItem('gudang_master_pemilik', JSON.stringify(MASTER_DATA.pemilik));
      showToast('Pemilik berhasil dihapus');
      this.renderPemilikList();
    } catch (err) {
      showToast('Gagal menghapus pemilik: ' + err.message, 'error');
    }
  }

  // ========== LOKASI ==========
  renderLokasiList(filter = '') {
    const container = document.getElementById('lokasi-list');
    const empty = document.getElementById('lokasi-empty');
    if (!container) return;

    let lokasi = [...(MASTER_DATA.lokasi || [])];
    if (filter) {
      const q = filter.toLowerCase();
      lokasi = lokasi.filter(l => (l || '').toLowerCase().includes(q));
    }

    if (lokasi.length === 0) {
      container.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    container.innerHTML = lokasi.map(l => `
      <div class="katalog-item">
        <div class="katalog-item-info">
          <div class="katalog-item-label">${escapeHtml(l || '-')}</div>
        </div>
        <div class="katalog-item-actions">
          <button type="button" class="btn-katalog-edit" data-action="edit-lokasi" data-nama="${escapeHtml(l || '')}">Edit</button>
          <button type="button" class="btn-katalog-delete" data-action="delete-lokasi" data-nama="${escapeHtml(l || '')}">Hapus</button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('[data-action="edit-lokasi"]').forEach(btn => {
      btn.addEventListener('click', () => this.editLokasi(btn.dataset.nama));
    });
    container.querySelectorAll('[data-action="delete-lokasi"]').forEach(btn => {
      btn.addEventListener('click', () => this.deleteLokasi(btn.dataset.nama));
    });
  }

  filterLokasi(value) {
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
      if (this.lokasiEditing) {
        MASTER_DATA.lokasi = (MASTER_DATA.lokasi || []).filter(l => l !== this.lokasiEditing);
        if (!MASTER_DATA.lokasi.includes(nama)) {
          MASTER_DATA.lokasi.push(nama);
        }
      } else {
        const exists = (MASTER_DATA.lokasi || []).some(l => l === nama);
        if (exists) {
          errorBox.textContent = 'Lokasi sudah ada!';
          errorBox.hidden = false;
          return;
        }
        MASTER_DATA.lokasi.push(nama);
      }

      MASTER_DATA.lokasi.sort();
      localStorage.setItem('gudang_master_lokasi', JSON.stringify(MASTER_DATA.lokasi));
      showToast('Lokasi berhasil disimpan');
      this.closeLokasiForm();
      this.renderLokasiList();
      LOKASI_SET.clear();
      MASTER_DATA.lokasi.forEach(l => LOKASI_SET.add(l));
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }
  }

  editLokasi(nama) {
    this.openLokasiForm(nama);
  }

  deleteLokasi(nama) {
    if (!confirm(`Hapus lokasi "${nama}"? Tindakan ini tidak dapat dibatalkan.`)) return;
    try {
      MASTER_DATA.lokasi = (MASTER_DATA.lokasi || []).filter(l => l !== nama);
      localStorage.setItem('gudang_master_lokasi', JSON.stringify(MASTER_DATA.lokasi));
      showToast('Lokasi berhasil dihapus');
      this.renderLokasiList();
      LOKASI_SET.clear();
      MASTER_DATA.lokasi.forEach(l => LOKASI_SET.add(l));
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
// berbeda dari operator (lihat KODE_AKSES_PENDAFTARAN_ADMIN di data.js).
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

function normalizeNikKey(nik) {
  return String(nik || '').trim();
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

async function findOperatorAccountByNama(nama) {
  const fb = window.gudangFirebase;
  const namaKey = normalizeNamaKey(nama);
  const q = fb.query(fb.operatorCol, fb.where('namaLower', '==', namaKey));
  const snapshot = await fb.getDocs(q);
  if (snapshot.empty) return null;
  const docSnap = snapshot.docs[0];
  return { id: docSnap.id, ...docSnap.data() };
}

// Login & pengecekan akun sekarang berdasarkan NIK (bukan nama), karena
// nama karyawan berpotensi sama antara satu operator dengan operator lain
// — NIK dijamin unik per karyawan.
async function findOperatorAccountByNik(nik) {
  const fb = window.gudangFirebase;
  const nikKey = normalizeNikKey(nik);
  const q = fb.query(fb.operatorCol, fb.where('idKaryawan', '==', nikKey));
  const snapshot = await fb.getDocs(q);
  if (snapshot.empty) return null;
  const docSnap = snapshot.docs[0];
  return { id: docSnap.id, ...docSnap.data() };
}

// Sama seperti findOperatorAccountByNik, tapi mencari di koleksi "admin"
// (akun admin yang mendaftar sendiri lewat "Daftar Baru").
async function findAdminAccountByNik(nik) {
  const fb = window.gudangFirebase;
  const nikKey = normalizeNikKey(nik);
  const q = fb.query(fb.adminCol, fb.where('idKaryawan', '==', nikKey));
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

    const existing = await findOperatorAccountByNik(idKaryawan);
    if (existing) {
      showRegisterError('NIK ini sudah terdaftar. Silakan masuk lewat tab "Masuk", atau hubungi admin gudang jika ini bukan Anda.');
      return;
    }

    const passwordHash = await hashPassword(password);
    const fb = window.gudangFirebase;
    await fb.addDoc(fb.operatorCol, {
      nama,
      namaLower: normalizeNamaKey(nama),
      idKaryawan: normalizeNikKey(idKaryawan),
      passwordHash,
      createdAt: Date.now(),
    });

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
  if (typeof KODE_AKSES_PENDAFTARAN_ADMIN === 'undefined') {
    showRegisterAdminError('Sistem belum siap (data.js gagal dimuat). Muat ulang halaman (refresh) lalu coba lagi.');
    return;
  }
  // Sengaja dicek terhadap kode ADMIN, bukan kode operator — supaya
  // operator yang cuma tahu kode pendaftaran operator tidak bisa
  // mendaftarkan diri sebagai admin.
  if (kodeAkses !== KODE_AKSES_PENDAFTARAN_ADMIN) {
    showRegisterAdminError('Kode Akses Pendaftaran Admin salah. Pastikan Anda mendapatkan kode resmi yang khusus untuk admin.');
    registerAdminKodeAkses.value = '';
    registerAdminKodeAkses.focus();
    return;
  }
  if (!password || password.length < 6) { showRegisterAdminError('Kata sandi minimal 6 karakter.'); registerAdminPassword.focus(); return; }
  if (password !== passwordConfirm) { showRegisterAdminError('Konfirmasi kata sandi tidak cocok.'); registerAdminPasswordConfirm.focus(); return; }

  const submitBtn = formRegisterAdmin.querySelector('button[type="submit"]');
  const originalText = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'MENDAFTARKAN...';

  try {
    await waitForFirebaseAuth();

    const nikKey = normalizeNikKey(idKaryawan);
    const existingFirestore = await findAdminAccountByNik(idKaryawan);
    const existingLegacy = ADMIN_ACCOUNTS.some(a => normalizeNikKey(a.idKaryawan) === nikKey);
    if (existingFirestore || existingLegacy) {
      showRegisterAdminError('NIK ini sudah terdaftar sebagai admin. Silakan masuk lewat tab "Masuk".');
      return;
    }

    const passwordHash = await hashPassword(password);
    const fb = window.gudangFirebase;
    await fb.addDoc(fb.adminCol, {
      nama,
      namaLower: normalizeNamaKey(nama),
      idKaryawan: nikKey,
      passwordHash,
      createdAt: Date.now(),
    });

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

    const akun = await findOperatorAccountByNik(nik);
    if (!akun) {
      showLoginOperatorError('NIK belum terdaftar. Silakan daftar akun baru terlebih dahulu lewat tab "Daftar Baru".');
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

    // Cek dulu akun admin yang mendaftar sendiri (Firestore, password
    // tersimpan sebagai hash). Kalau tidak ketemu, fallback ke daftar
    // admin lama yang masih hardcode di data.js (password teks polos).
    const nikKey = normalizeNikKey(nik);
    const akunFirestore = await findAdminAccountByNik(nik);

    if (akunFirestore) {
      const passwordHash = await hashPassword(password);
      if (passwordHash !== akunFirestore.passwordHash) {
        showLoginAdminError('Kata sandi salah. Coba lagi.');
        loginAdminPassword.value = '';
        loginAdminPassword.focus();
        return;
      }
      setSession({ role: 'admin', nama: akunFirestore.nama });
      enterApp({ role: 'admin', nama: akunFirestore.nama });
      return;
    }

    const akunLegacy = ADMIN_ACCOUNTS.find(a => normalizeNikKey(a.idKaryawan) === nikKey);
    if (!akunLegacy) {
      showLoginAdminError('NIK belum terdaftar sebagai admin. Silakan daftar akun baru terlebih dahulu lewat tab "Daftar Baru".');
      return;
    }
    if (password !== akunLegacy.password) {
      showLoginAdminError('Kata sandi salah. Coba lagi.');
      loginAdminPassword.value = '';
      loginAdminPassword.focus();
      return;
    }
    setSession({ role: 'admin', nama: akunLegacy.nama });
    enterApp({ role: 'admin', nama: akunLegacy.nama });
  } catch (err) {
    console.error('Gagal memeriksa akun admin:', err);
    showLoginAdminError('Sistem belum siap atau koneksi bermasalah. Coba lagi sebentar.');
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
let currentEntriesRaw = [];
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

function buildLocationStock(entries) {
  const map = {};
  entries.forEach(t => {
    if (!t.lokasi) return;
    const key = t.kodeBarang || t.namaBarang;
    if (!map[t.lokasi]) map[t.lokasi] = { items: {}, lastActivity: 0, tanggalKedatangan: null, totalPallet: 0 };
    const loc = map[t.lokasi];
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
   berisi semua section sekaligus. Panel "Katalog & Stok" memakai ulang
   elemen #op-panel-katalog yang sama dengan punya operator (kontennya
   memang dipakai bersama oleh kedua peran).
========================================================================== */
const adminNav = document.getElementById('admin-nav');
const adminPanels = {
  dashboard: document.getElementById('admin-panel-dashboard'),
  katalog: document.getElementById('op-panel-katalog'),
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
}

document.querySelectorAll('.admin-nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchAdminPanel(btn.dataset.adminPanel));
});

/* ---- Pencarian cepat (admin) ---- */
const adminScanInput = document.getElementById('admin-scan-input');
const adminScanSuggest = document.getElementById('admin-scan-suggest');
const adminScanSearchEl = document.getElementById('admin-scan-search');

const scanSearchIconBox = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/></svg>';
const scanSearchIconPin = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>';

function renderAdminScanSuggest(q, mode) {
  if (!adminScanSuggest) return;
  const items = buildStokList(currentEntries);
  let rows = '';

  if (mode === 'stok-kosong') {
    const kosong = items.filter(it => (it.masuk - it.keluar) <= 0);
    if (kosong.length === 0) {
      adminScanSuggest.innerHTML = '<div class="scan-search-empty">Semua barang masih ada stoknya. 🎉</div>';
    } else {
      rows = kosong.slice(0, 20).map(it => scanSearchBarangRow(it)).join('');
      adminScanSuggest.innerHTML = rows;
    }
    adminScanSuggest.classList.add('is-open');
    return;
  }

  if (!q) { adminScanSuggest.classList.remove('is-open'); return; }
  const ql = q.toLowerCase();

  const barangMatch = items.filter(it =>
    (it.nama || '').toLowerCase().includes(ql) || String(it.kode || '').toLowerCase().includes(ql)
  ).slice(0, 6);

  const lokasiSet = new Set();
  currentEntries.forEach(t => { if (t.lokasi && t.lokasi.toLowerCase().includes(ql)) lokasiSet.add(t.lokasi); });
  const lokasiMatch = Array.from(lokasiSet).slice(0, 4);

  if (barangMatch.length === 0 && lokasiMatch.length === 0) {
    adminScanSuggest.innerHTML = `<div class="scan-search-empty">Tidak ditemukan hasil untuk "${escapeHtml(q)}"</div>`;
  } else {
    rows += barangMatch.map(it => scanSearchBarangRow(it)).join('');
    rows += lokasiMatch.map(lok => `
      <button type="button" class="scan-search-row" data-lokasi="${escapeHtml(lok)}">
        <span class="scan-search-row-icon">${scanSearchIconPin}</span>
        <span class="scan-search-row-main"><div class="scan-search-row-nama">${escapeHtml(lok)}</div><div class="scan-search-row-sub">Lokasi rak</div></span>
      </button>
    `).join('');
    adminScanSuggest.innerHTML = rows;
  }
  adminScanSuggest.classList.add('is-open');
}

function scanSearchBarangRow(it) {
  const stok = it.masuk - it.keluar;
  const st = stok > 0 ? 'pos' : (stok < 0 ? 'neg' : 'zero');
  return `
    <button type="button" class="scan-search-row" data-kode="${escapeHtml(it.kode || '')}">
      <span class="scan-search-row-icon">${scanSearchIconBox}</span>
      <span class="scan-search-row-main"><div class="scan-search-row-nama">${escapeHtml(it.nama)}</div><div class="scan-search-row-sub">${escapeHtml(it.kode || '-')}</div></span>
      <span class="scan-search-row-badge ${st}">${stok.toLocaleString('id-ID')} pcs</span>
    </button>
  `;
}

if (adminScanInput) {
  adminScanInput.addEventListener('input', () => renderAdminScanSuggest(adminScanInput.value.trim(), null));
  adminScanInput.addEventListener('focus', () => { if (adminScanInput.value.trim()) renderAdminScanSuggest(adminScanInput.value.trim(), null); });
}
if (adminScanSuggest) {
  adminScanSuggest.addEventListener('click', (e) => {
    const row = e.target.closest('.scan-search-row');
    if (!row) return;
    adminScanSuggest.classList.remove('is-open');
    switchAdminPanel('katalog');
    if (row.dataset.kode) openItemModal(row.dataset.kode);
    else if (row.dataset.lokasi) openLokasiModal(row.dataset.lokasi);
  });
}
document.querySelectorAll('.scan-search-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    if (adminScanInput) adminScanInput.value = '';
    renderAdminScanSuggest('', chip.dataset.preset);
  });
});
document.addEventListener('click', (e) => {
  if (adminScanSearchEl && !e.target.closest('.scan-search-wrap')) adminScanSuggest.classList.remove('is-open');
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && adminScanInput && document.activeElement !== adminScanInput && currentRole() === 'admin') {
    e.preventDefault();
    adminScanInput.focus();
  }
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
  const adjSubmitBtn = document.getElementById('btn-adj-submit');
  if (adjSubmitBtn) adjSubmitBtn.disabled = state !== 'connected';

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
const PEMILIK_OPTIONS = MASTER_DATA.pemilik || [];

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
  // Sama seperti sel-barang di atas: operator TIDAK boleh menambah pemilik
  // barang/pabrik baru sendiri dari form input laporan. Hanya admin yang
  // bisa (lewat menu Katalog).
  onSelect: () => {},
});

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

  list.innerHTML = combos.map((c, i) => `
    <button type="button" class="kombinasi-chip" data-idx="${i}">
      <span class="kombinasi-chip-main">🏭 ${escapeHtml(c.supplier)} <span class="kombinasi-chip-sep">·</span> 🏢 ${escapeHtml(c.pemilik)}</span>
      <span class="kombinasi-chip-sub">📍 ${escapeHtml(c.lokasi)} <span class="kombinasi-chip-sep">·</span> ${c.stok.toLocaleString('id-ID')} pcs${c.pallet ? ` <span class="kombinasi-chip-sep">·</span> ${roundPalletDisplay(c.pallet)} pallet` : ''}</span>
      <span class="kombinasi-chip-sub">📅 Datang: ${c.tanggalKedatangan ? formatTanggal(c.tanggalKedatangan) : '-'}</span>
    </button>
  `).join('');

  list.querySelectorAll('.kombinasi-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const c = combos[Number(btn.dataset.idx)];
      kombinasiTerkunci = c;
      selSupplier.setValue(c.supplier);
      selPemilik.setValue(c.pemilik);
      selLokasi.reset();
      list.querySelectorAll('.kombinasi-chip').forEach(b => b.classList.remove('is-selected'));
      btn.classList.add('is-selected');
      showToast(`Kombinasi dipilih. Sekarang scan barcode lokasi ${c.lokasi} untuk konfirmasi.`, 'info');
    });
  });
}

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
  if (!tanggal) return showError('Tanggal kedatangan wajib diisi.');
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

let isSubmittingAdj = false;

if (formPenyesuaian) {
  formPenyesuaian.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAdjError();

    if (isSubmittingAdj) return;
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

    if (adjArah === 'kurang') {
      const stokDiLokasi = getStokAtLokasi(currentEntries, barang.kode, lokasi);
      if (jumlah > stokDiLokasi) {
        return showAdjError(`Jumlah pengurangan (${jumlah.toLocaleString('id-ID')} pcs) melebihi stok barang ini di lokasi ${lokasi} (${stokDiLokasi.toLocaleString('id-ID')} pcs).`);
      }
    }

    isSubmittingAdj = true;
    const submitBtn = document.getElementById('btn-adj-submit');
    const submitText = document.getElementById('btn-adj-submit-text');
    submitBtn.disabled = true;
    const originalText = submitText.textContent;
    submitText.textContent = 'MENYIMPAN...';

    try {
      const session = getSession();
      const now = Date.now();

      const writePromise = addEntryToFirestore({
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
      showToast(navigator.onLine ? 'Penyesuaian stok berhasil disimpan.' : 'Penyesuaian tersimpan di perangkat, akan tersinkron otomatis.', navigator.onLine ? 'success' : 'info');

      writePromise.catch((err) => {
        console.error('Gagal menyinkronkan penyesuaian ke server:', err);
        showToast('Gagal menyinkronkan penyesuaian: ' + err.message, 'error');
      });
    } catch (err) {
      showAdjError('Gagal menyimpan penyesuaian: ' + err.message);
    } finally {
      isSubmittingAdj = false;
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

function renderBlokPallet() {
  const blokListEl = document.getElementById('blok-list');
  const blokEmptyEl = document.getElementById('blok-empty');
  const blokTotalEl = document.getElementById('blok-total');
  if (!blokListEl || !blokEmptyEl) return;

  const blokData = buildLokasiOccupancy(currentEntries);
  const totalSlot = blokData.reduce((s, b) => s + b.terisi + b.kosong, 0);
  const totalTerisi = blokData.reduce((s, b) => s + b.terisi, 0);
  const totalPallet = blokData.reduce((s, b) => s + b.totalPallet, 0);

  if (blokTotalEl) {
    if (totalSlot > 0) {
      blokTotalEl.hidden = false;
      blokTotalEl.textContent = `${totalTerisi.toLocaleString('id-ID')}/${totalSlot.toLocaleString('id-ID')} lokasi terisi · ${roundPalletDisplay(totalPallet)} pallet`;
    } else {
      blokTotalEl.hidden = true;
    }
  }

  blokListEl.innerHTML = '';
  if (blokData.length === 0) {
    blokEmptyEl.hidden = false;
    return;
  }
  blokEmptyEl.hidden = true;

  blokData.forEach(b => {
    const total = b.terisi + b.kosong;
    const pct = total > 0 ? Math.round((b.terisi / total) * 100) : 0;
    const row = document.createElement('div');
    row.className = 'bar-row bar-row-blok';
    row.innerHTML = `
      <div class="bar-row-top">
        <span class="bar-row-name mono">Blok ${escapeHtml(b.blok)} <span class="muted">(${b.terisi}/${total} terisi · ${b.kosong} kosong)</span></span>
        <span class="bar-row-val">${roundPalletDisplay(b.totalPallet)} pallet</span>
      </div>
      <div class="bar-row-track"><div class="bar-row-fill" style="width:${Math.max(pct, total > 0 && b.terisi > 0 ? 4 : 0)}%"></div></div>
    `;
    row.addEventListener('click', () => openBlokModal(b.blok));
    blokListEl.appendChild(row);
  });
}

// ---- Modal peta lokasi per blok — grid kecil semua rak di blok tsb,
// ditandai TERISI (ada stok) / KOSONG (belum ada stok), klik satu rak untuk
// lihat detail (kalau terisi) atau info singkat (kalau kosong).
function openBlokModal(blok) {
  const blokData = buildLokasiOccupancy(currentEntries);
  const data = blokData.find(b => b.blok === blok);
  if (!data) return;
  const total = data.terisi + data.kosong;

  modalBody.innerHTML = `
    <div class="modal-item-head">
      <div class="modal-item-kode">BLOK GUDANG</div>
      <h2 class="modal-item-nama mono">Blok ${escapeHtml(data.blok)}</h2>
    </div>
    <div class="modal-stat-grid">
      <div class="modal-stat"><span>Total Lokasi</span><strong>${total}</strong></div>
      <div class="modal-stat"><span>Terisi</span><strong>${data.terisi}</strong></div>
      <div class="modal-stat"><span>Kosong</span><strong>${data.kosong}</strong></div>
      <div class="modal-stat"><span>Total Pallet</span><strong class="modal-stat-small">${data.totalPallet ? roundPalletDisplay(data.totalPallet) : '-'}</strong></div>
    </div>
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
const statPalletMasuk = document.getElementById('stat-pallet-masuk');
const statPalletMasukSub = document.getElementById('stat-pallet-masuk-sub');
const statPalletKeluar = document.getElementById('stat-pallet-keluar');
const statPalletKeluarSub = document.getElementById('stat-pallet-keluar-sub');
const statPalletSaatIni = document.getElementById('stat-pallet-saat-ini');

function renderRingkasan() {
  if (currentRole() !== 'admin') return;
  const range = getPeriodRange(periodMode, periodDate);
  ringkasanDate.textContent = range.label;

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  let masukQty = 0, masukCount = 0, keluarQty = 0, keluarCount = 0;
  let palletMasuk = 0, palletKeluar = 0;
  currentEntries.forEach(t => {
    if (inPeriod(t, range)) {
      if (t.jenis === 'masuk') {
        masukQty += t.jumlah; masukCount++;
        if (t.jumlahPallet != null) palletMasuk += t.jumlahPallet;
      } else {
        keluarQty += t.jumlah; keluarCount++;
        if (t.jumlahPallet != null) palletKeluar += t.jumlahPallet;
      }
    }
  });
  statMasukQty.textContent = masukQty.toLocaleString('id-ID');
  statMasukCount.textContent = `${masukCount} laporan`;
  statKeluarQty.textContent = keluarQty.toLocaleString('id-ID');
  statKeluarCount.textContent = `${keluarCount} laporan`;
  statTotalCount.textContent = currentEntries.length.toLocaleString('id-ID');

  // Pallet masuk/keluar mengikuti periode yang sama seperti kartu di atas.
  // Hanya laporan yang punya info Qty per Pallet (sehingga jumlahPallet
  // terisi) yang dihitung — laporan lama sebelum fitur ini ada tidak ikut.
  if (statPalletMasuk) statPalletMasuk.textContent = roundPalletDisplay(palletMasuk);
  if (statPalletKeluar) statPalletKeluar.textContent = roundPalletDisplay(palletKeluar);
  if (statPalletMasukSub) statPalletMasukSub.textContent = `periode ini · ${range.label}`;
  if (statPalletKeluarSub) statPalletKeluarSub.textContent = `periode ini · ${range.label}`;

  // Total Pallet Saat Ini = posisi stok pallet sekarang, dihitung dari
  // SELURUH riwayat (masuk dikurangi keluar), sama seperti cara stok pcs
  // dihitung di buildLocationStock — tidak mengikuti filter periode karena
  // ini "saldo sekarang", bukan aktivitas dalam rentang waktu.
  if (statPalletSaatIni) {
    let palletSaldo = 0;
    currentEntries.forEach(t => {
      if (t.jumlahPallet == null) return;
      palletSaldo += (t.jenis === 'masuk' ? t.jumlahPallet : -t.jumlahPallet);
    });
    statPalletSaatIni.textContent = roundPalletDisplay(palletSaldo);
  }

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
  const trendMasukEl = document.getElementById('stat-masuk-trend');
  const trendKeluarEl = document.getElementById('stat-keluar-trend');

  function setTrend(el, current, previous) {
    if (!el) return;
    if (!prevRange || (current === 0 && previous === 0)) { el.hidden = true; return; }
    el.hidden = false;
    const pct = previous === 0 ? 100 : Math.round(((current - previous) / previous) * 100);
    if (pct > 0) { el.className = 'stat-trend up'; el.textContent = `▲ ${pct}%`; }
    else if (pct < 0) { el.className = 'stat-trend down'; el.textContent = `▼ ${Math.abs(pct)}%`; }
    else { el.className = 'stat-trend flat'; el.textContent = 'sama'; }
  }

  if (!prevRange) {
    trendEl.hidden = true;
    if (trendMasukEl) trendMasukEl.hidden = true;
    if (trendKeluarEl) trendKeluarEl.hidden = true;
  } else {
    let prevTotal = 0, prevMasukQty = 0, prevKeluarQty = 0;
    currentEntries.forEach(t => {
      if (inPeriod(t, prevRange)) {
        prevTotal += t.jumlah;
        if (t.jenis === 'masuk') prevMasukQty += t.jumlah; else prevKeluarQty += t.jumlah;
      }
    });
    if (prevTotal === 0 && totalArus === 0) {
      trendEl.hidden = true;
    } else {
      trendEl.hidden = false;
      let pct = prevTotal === 0 ? 100 : Math.round(((totalArus - prevTotal) / prevTotal) * 100);
      if (pct > 0) { trendEl.className = 'vis-trend up'; trendEl.textContent = `▲ ${pct}%`; }
      else if (pct < 0) { trendEl.className = 'vis-trend down'; trendEl.textContent = `▼ ${Math.abs(pct)}%`; }
      else { trendEl.className = 'vis-trend flat'; trendEl.textContent = `= sama`; }
    }
    setTrend(trendMasukEl, masukQty, prevMasukQty);
    setTrend(trendKeluarEl, keluarQty, prevKeluarQty);
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

  renderBlokPallet();
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

  if (katalogMode === 'barang') {
    const items = buildStokList(currentEntries);
    const filtered = q ? items.filter(it => it.nama.toLowerCase().includes(q) || String(it.kode).toLowerCase().includes(q)) : items;
    if (items.length === 0) return setKatalogEmpty('Belum ada barang yang tercatat.');
    if (filtered.length === 0) return setKatalogEmpty('Tidak ada barang yang cocok dengan pencarian.');
    katalogEmpty.hidden = true;
    katalogHint.textContent = `📁 ${items.length} barang. Klik baris untuk lihat riwayat transaksi lengkap.`;
    filtered.forEach(it => {
      const stok = it.masuk - it.keluar;
      const totalPallet = (it.masukPallet || 0) - (it.keluarPallet || 0);
      const statusClass = stok > 0 ? 'pos' : (stok < 0 ? 'neg' : 'zero');
      const statusLabel = stok > 0 ? 'Stok Tersedia' : (stok < 0 ? 'Stok Minus' : 'Stok Kosong');
      appendStokRow(katalogList, {
        nama: it.nama, sub: it.kode, subMono: true, stok, statusClass, statusLabel, pallet: totalPallet,
        meta: [
          { icon: '📍', label: 'Lokasi', value: formatSetList(it.lokasi) },
          { icon: '🚚', label: 'Supplier', value: formatSetList(it.supplierSet) },
          { icon: '🏭', label: 'Pemilik', value: formatSetList(it.pemilikSet) },
        ],
        onClick: () => openItemModal(it.kode),
      });
    });

  } else if (katalogMode === 'lokasi') {
    const all = buildLocationStock(currentEntries);
    const filtered = q ? all.filter(l => l.lokasi.toLowerCase().includes(q)) : all;
    if (all.length === 0) return setKatalogEmpty('Belum ada stok tercatat di lokasi manapun.');
    if (filtered.length === 0) return setKatalogEmpty('Tidak ada lokasi yang cocok dengan pencarian.');
    katalogEmpty.hidden = true;
    katalogHint.textContent = `📁 ${all.length} lokasi terisi. Klik baris untuk lihat barang apa saja di dalamnya.`;
    filtered.forEach(l => {
      const statusClass = l.totalQty > 0 ? 'pos' : (l.totalQty < 0 ? 'neg' : 'zero');
      const statusLabel = l.totalQty > 0 ? 'Stok Tersedia' : (l.totalQty < 0 ? 'Stok Minus' : 'Stok Kosong');
      const barangUtama = l.items[0] ? l.items[0].nama : '-';
      appendStokRow(katalogList, {
        nama: l.lokasi, sub: 'Lokasi Penyimpanan', subMono: false, stok: l.totalQty, statusClass, statusLabel, pallet: l.totalPallet,
        meta: [
          { icon: '📦', label: 'Jenis Barang', value: `${l.itemCount} jenis` },
          { icon: '⭐', label: 'Barang Utama', value: barangUtama },
          { icon: '📅', label: 'Tanggal Kedatangan', value: l.tanggalKedatangan ? formatTanggal(l.tanggalKedatangan) : '-' },
          { icon: '🕒', label: 'Terakhir', value: l.lastActivity ? formatWaktu(l.lastActivity) : '-' },
        ],
        onClick: () => openLokasiModal(l.lokasi),
      });
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
    const jumlahLaporan = currentEntries.filter(t => (t.operator || '').trim().toLowerCase() === (a.nama || '').trim().toLowerCase()).length;
    const inisial = (a.nama || '-').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    const row = document.createElement('div');
    row.className = 'akun-operator-item';
    row.innerHTML = `
      <div class="akun-operator-avatar">${escapeHtml(inisial || '?')}</div>
      <div class="akun-operator-main">
        <span class="akun-operator-nama">${escapeHtml(a.nama || '-')}</span>
        <span class="akun-operator-meta">ID Karyawan: <span class="mono">${escapeHtml(a.idKaryawan || '-')}</span></span>
      </div>
      <div class="akun-operator-stats">
        <span class="akun-operator-stat-num">${jumlahLaporan.toLocaleString('id-ID')}</span>
        <span class="akun-operator-stat-label">Laporan</span>
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
      <div class="modal-stat"><span>Total Pallet</span><strong>${data.totalPallet ? roundPalletDisplay(data.totalPallet) : '-'}</strong></div>
      <div class="modal-stat"><span>Tanggal Kedatangan</span><strong class="modal-stat-small">${data.tanggalKedatangan ? formatTanggal(data.tanggalKedatangan) : '-'}</strong></div>
      <div class="modal-stat"><span>Terakhir Diperbarui</span><strong class="modal-stat-small">${data.lastActivity ? formatWaktu(data.lastActivity) : '-'}</strong></div>
    </div>
    <div class="modal-section">
      <h4>Barang di Lokasi Ini</h4>
      <p class="modal-history-hint muted">Diurutkan dari tanggal kedatangan paling lama (FIFO) di atas.</p>
      <div id="modal-lokasi-stok-table" class="stok-table stok-table-modal"></div>
    </div>
  `;
  const container = modalBody.querySelector('#modal-lokasi-stok-table');
  const itemsUrut = [...data.items].sort((a, b) => {
    if (a.tanggalKedatangan && b.tanggalKedatangan && a.tanggalKedatangan !== b.tanggalKedatangan) {
      return a.tanggalKedatangan < b.tanggalKedatangan ? -1 : 1;
    }
    if (!!a.tanggalKedatangan !== !!b.tanggalKedatangan) return a.tanggalKedatangan ? -1 : 1;
    return b.qty - a.qty;
  });
  itemsUrut.forEach(it => {
    const statusClass = it.qty > 0 ? 'pos' : (it.qty < 0 ? 'neg' : 'zero');
    const statusLabel = it.qty > 0 ? 'Stok Tersedia' : (it.qty < 0 ? 'Stok Minus' : 'Stok Kosong');
    appendStokRow(container, {
      nama: it.nama, sub: it.kode, subMono: true, stok: it.qty, statusClass, statusLabel, pallet: it.pallet,
      meta: [
        { icon: '🚚', label: 'Supplier', value: formatSetList(it.supplierSet) },
        { icon: '🏭', label: 'Pemilik', value: formatSetList(it.pemilikSet) },
        { icon: '📅', label: 'Tanggal Kedatangan', value: it.tanggalKedatangan ? formatTanggal(it.tanggalKedatangan) : '-' },
        { icon: '🕒', label: 'Terakhir', value: it.lastActivity ? formatWaktu(it.lastActivity) : '-' },
      ],
      onClick: () => openItemModal(it.kode),
    });
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

function openItemModal(kode) {
  if (!kode) return;
  const items = buildStokList(currentEntries);
  const item = items.find(i => i.kode === kode);
  if (!item) return;

  const stok = item.masuk - item.keluar;
  const lokasiList = lokasiBreakdown(item.history);
  const palletHintMap = lokasiPalletHint(item.history);
  const historySorted = [...item.history].sort((a, b) => b.createdAt - a.createdAt);

  modalBody.innerHTML = `
    <div class="modal-item-head">
      <div class="modal-item-kode mono">Kode Barang: ${escapeHtml(item.kode || '-')}</div>
      <h2 class="modal-item-nama">${escapeHtml(item.nama)}</h2>
    </div>

    <div class="modal-headline">
      <span class="modal-headline-label">Stok Saat Ini</span>
      <strong class="modal-headline-value ${stok <= 0 ? 'neg' : ''}">${stok.toLocaleString('id-ID')} <small>pcs</small></strong>
    </div>
    <div class="modal-stat-grid modal-stat-grid-sub">
      <div class="modal-stat"><span>Total Masuk (semua waktu)</span><strong>${item.masuk.toLocaleString('id-ID')} pcs</strong></div>
      <div class="modal-stat"><span>Total Keluar (semua waktu)</span><strong>${item.keluar.toLocaleString('id-ID')} pcs</strong></div>
    </div>

    <div class="modal-section">
      <h4>Lokasi Penyimpanan Saat Ini</h4>
      ${lokasiList.length
        ? `<div class="lokasi-cards">${lokasiList.map(([lok, qty]) => {
            const qtyPerPallet = palletHintMap[lok];
            const estPallet = qtyPerPallet ? Math.ceil(Math.abs(qty) / qtyPerPallet) : null;
            return `
            <button type="button" class="lokasi-card" data-lokasi="${escapeHtml(lok)}">
              <div class="lokasi-card-top">
                <span class="lokasi-card-nama mono">Rak ${escapeHtml(lok)}</span>
                <span class="lokasi-card-qty">${qty.toLocaleString('id-ID')} <small>pcs</small></span>
              </div>
              <div class="lokasi-card-pallet">
                ${estPallet
                  ? `&asymp; ${estPallet.toLocaleString('id-ID')} pallet <span class="muted">(${qtyPerPallet.toLocaleString('id-ID')} pcs/pallet)</span>`
                  : `<span class="muted">Info pallet tidak tercatat</span>`}
              </div>
            </button>`;
          }).join('')}</div>`
        : '<p class="muted">Tidak ada stok aktif di lokasi manapun.</p>'}
    </div>

    <div class="modal-section">
      <h4>Riwayat Transaksi Masuk &amp; Keluar (${historySorted.length})</h4>
      <p class="modal-history-hint muted">Diurutkan dari yang paling baru. Klik satu baris untuk lihat detail lengkapnya.</p>
      <div class="modal-history-list">
        ${historySorted.map((t, idx) => `
          <div class="modal-history-row" data-idx="${idx}" role="button" tabindex="0">
            <div class="modal-history-main">
              <span class="badge-jenis ${t.jenis === 'masuk' ? 'badge-masuk' : 'badge-keluar'}">${t.jenis === 'masuk' ? 'MASUK' : 'KELUAR'}${t.tipe === 'penyesuaian' ? ' · Penyesuaian' : ''}</span>
              <span>${formatTanggal(t.tanggal)} · Rak ${escapeHtml(t.lokasi)}</span>
              <span>${t.jumlah.toLocaleString('id-ID')} pcs</span>
              <span class="muted">Operator: ${escapeHtml(t.operator)}</span>
              <svg class="modal-history-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
            </div>
            <div class="modal-history-sub muted">
              <span>Kode Pemilik: ${escapeHtml(t.pemilik || '-')}</span>
              ${t.jumlahPallet ? `<span>${t.jumlahPallet.toLocaleString('id-ID')} pallet${t.qtyPerPallet ? ` (${t.qtyPerPallet.toLocaleString('id-ID')} pcs/pallet)` : ''}</span>` : ''}
            </div>
            <div class="modal-history-detail" hidden>
              ${t.jenis === 'masuk' ? `<div><span class="lbl">Supplier</span><span>${escapeHtml(t.supplier || '-')}</span></div>` : ''}
              <div><span class="lbl">Lokasi</span><span class="link-inline" data-lokasi="${escapeHtml(t.lokasi)}">Rak ${escapeHtml(t.lokasi)}</span></div>
              <div><span class="lbl">Kode Pemilik</span><span>${escapeHtml(t.pemilik || '-')}</span></div>
              <div><span class="lbl">Keterangan</span><span>${escapeHtml(t.keterangan || '-')}</span></div>
              <div><span class="lbl">Diinput</span><span>${t.createdAt ? formatWaktu(t.createdAt) : '-'}</span></div>
              ${(t.editLog && t.editLog.length)
                ? `<div><span class="lbl">Riwayat Edit</span><span>${t.editLog.length}× diedit — terakhir oleh ${escapeHtml(t.editLog[t.editLog.length - 1].oleh)} · ${formatWaktu(t.editLog[t.editLog.length - 1].waktu)}</span></div>`
                : ''}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  modalBody.querySelectorAll('.lokasi-card').forEach(card => {
    card.addEventListener('click', () => openLokasiModal(card.dataset.lokasi));
  });
  modalBody.querySelectorAll('.modal-history-row').forEach(row => {
    const detail = row.querySelector('.modal-history-detail');
    const toggle = () => {
      const willOpen = detail.hidden;
      detail.hidden = !willOpen;
      row.classList.toggle('is-open', willOpen);
    };
    row.addEventListener('click', (e) => {
      if (e.target.closest('.link-inline')) return; // ditangani listener lokasi terpisah
      toggle();
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    const lokasiLink = detail.querySelector('.link-inline');
    if (lokasiLink) {
      lokasiLink.addEventListener('click', (e) => {
        e.stopPropagation();
        openLokasiModal(lokasiLink.dataset.lokasi);
      });
    }
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

const RIWAYAT_PAGE_SIZE = 50;
let riwayatQuerySignature = '';
let riwayatVisibleCount = RIWAYAT_PAGE_SIZE;

function buildTicketCard(t) {
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
      ${(t.editLog && t.editLog.length > 0) ? `<div class="ticket-note ticket-edited-note">✏️ Terakhir diedit oleh <b>${escapeHtml(t.editLog[t.editLog.length - 1].oleh)}</b> · ${formatWaktu(t.editLog[t.editLog.length - 1].waktu)}${t.editLog.length > 1 ? ` (${t.editLog.length}× diedit — lihat "Jejak Edit/Hapus" untuk detail)` : ''}</div>` : ''}
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
    if (!confirm('Hapus laporan ini?')) return;
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
    if (e.jumlahLama !== e.jumlahBaru) perubahan.push(`Jumlah: ${e.jumlahLama} → ${e.jumlahBaru} pcs`);
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
      <div><span class="lbl">Jumlah saat ini: </span>${t.jumlah} pcs</div>
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

const btnToggleJejak = document.getElementById('btn-toggle-jejak');
if (btnToggleJejak) {
  btnToggleJejak.addEventListener('click', () => {
    riwayatJejakMode = !riwayatJejakMode;
    btnToggleJejak.classList.toggle('is-active', riwayatJejakMode);
    riwayatVisibleCount = RIWAYAT_PAGE_SIZE;
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
        <div class="ticket-jumlah-view"><span class="lbl">Jumlah: </span>${t.jumlah} pcs</div>
        ${t.qtyPerPallet != null ? `<div><span class="lbl">Qty/Pallet: </span>${t.qtyPerPallet.toLocaleString('id-ID')} pcs</div>` : ''}
        ${t.jumlahPallet != null ? `<div><span class="lbl">Jumlah Pallet: </span>${t.jumlahPallet.toLocaleString('id-ID')}</div>` : ''}
        <div><span class="lbl">Tanggal Kedatangan: </span>${formatTanggal(t.tanggal)}</div>
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
    loginOperatorNik.focus();
  }
})();

window.addEventListener('gudang-firebase-auth-error', () => {
  setConnectUI('error');
});