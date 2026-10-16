// Cara pakai (di folder yang sama dengan data.js):
//   1. Paste data dari Excel ke file  data-baru.txt  (boleh sekalian baris header)
//   2. Jalankan:  node tambah-data.js
// Script akan menambah barang & supplier baru ke data.js (duplikat dilewati),
// dan otomatis membuat cadangan data.js.bak sebelum menimpa.

const fs = require('fs');

const DATA_FILE = 'data.js';
const INPUT_FILE = 'data-baru.txt';

const src = fs.readFileSync(DATA_FILE, 'utf8');
const start = src.indexOf('{"barang"');
const end = src.indexOf('};', start);
if (start < 0 || end < 0) { console.error('Format data.js tidak dikenali.'); process.exit(1); }
const master = JSON.parse(src.slice(start, end + 1));

const rows = fs.readFileSync(INPUT_FILE, 'utf8').split(/\r?\n/);
const barangByKode = new Map(master.barang.map(b => [b.kode, b]));
const supplierSet = new Set(master.supplier.map(s => s.toLowerCase()));
const log = { baru: [], update: [], sama: 0, supplierBaru: [], dilewati: [] };

for (const line of rows) {
  if (!line.trim()) continue;
  // pisah per tab, buang sel kosong (di Excel ada kolom kosong antar kolom)
  const cells = line.split('\t').map(c => c.trim().replace(/\s+/g, ' ')).filter(Boolean);
  const kode = cells[0];
  if (!/^\d{6,}$/.test(kode || '')) { log.dilewati.push(line); continue; } // header / baris aneh
  const nama = cells[1];
  const supplier = cells.length >= 4 ? cells[cells.length - 1] : null; // kolom: kode, nama, no, supplier
  if (!nama) { log.dilewati.push(line); continue; }

  const ada = barangByKode.get(kode);
  if (!ada) {
    const item = { kode, nama };
    master.barang.push(item);
    barangByKode.set(kode, item);
    log.baru.push(`${kode}  ${nama}`);
  } else if (ada.nama !== nama) {
    log.update.push(`${kode}  "${ada.nama}" -> "${nama}"`);
    ada.nama = nama;
  } else {
    log.sama++;
  }

  if (supplier && !supplierSet.has(supplier.toLowerCase())) {
    master.supplier.push(supplier);
    supplierSet.add(supplier.toLowerCase());
    log.supplierBaru.push(supplier);
  }
}

master.supplier.sort((a, b) => a.localeCompare(b));

fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak');
fs.writeFileSync(DATA_FILE, src.slice(0, start) + JSON.stringify(master) + src.slice(end + 1));

console.log(`Barang baru ditambah : ${log.baru.length}`);
log.baru.forEach(x => console.log('  + ' + x));
console.log(`Nama barang diubah   : ${log.update.length}`);
log.update.forEach(x => console.log('  ~ ' + x));
console.log(`Sudah ada (sama)     : ${log.sama}`);
console.log(`Supplier baru        : ${log.supplierBaru.length}`);
log.supplierBaru.forEach(x => console.log('  + ' + x));
if (log.dilewati.length) { console.log(`Baris dilewati       : ${log.dilewati.length}`); log.dilewati.forEach(x => console.log('  ! ' + x)); }
console.log('Selesai. Cadangan: data.js.bak');
