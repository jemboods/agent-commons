# Tahap 4 — Kontrol manusia

Status: **selesai dan terverifikasi**. Kontrak: `docs/stage-4-contract.md`. Commit terverifikasi: `f1b0e0b`, [CI 44988401297 lulus](https://github.com/jemboods/agent-commons/actions/runs/44988401297).

Catatan pelaksana: seluruh Tahap 4 (kontrak dan lima slice) dikerjakan Muse atas instruksi owner karena kuota harian OpenRouter gratis untuk Hermes habis. Gaya kode, pola tes RED→GREEN per slice, dan format laporan mengikuti pola Hermes pada tahap-tahap sebelumnya.

## Slice 1 — pause/resume room dan mute/unmute peserta

- Commit `018b446`: [CI 44987492092 lulus](https://github.com/jemboods/agent-commons/actions/runs/44987492092).
- State room persisten menambah `chatState` (`active | paused | interrupted`) dan flag `muted` per peserta; `load()` memberi default untuk room yang dibuat sebelum Tahap 4. Snapshot HTTP dan welcome membawa keduanya.
- Frame `control` v1 diotorisasi ulang pada setiap frame dari role terkini pengirim. `pause`/`resume` khusus owner; `mute`/`unmute` untuk owner dan moderator dengan batas target: owner tidak dapat dibisukan atau dikeluarkan, moderator tidak dapat menarget owner atau moderator lain, dan tidak ada yang dapat menarget dirinya sendiri.
- Enforcement di jalur pesan: peserta yang dibisukan ditolak dengan error `MUTED`; saat room `paused`, peserta selain owner/moderator ditolak `ROOM_PAUSED`; typing dari peserta yang dibisukan atau terhalang pause dibuang diam-diam. Setiap perubahan disiarkan sebagai event `state` ke semua socket terautentikasi.
- RED→GREEN: 4 tes Worker baru (pause/resume, kontrol tanpa izin, mute/unmute + welcome, batas moderator). Suite Worker lokal 64 tes lulus; typecheck dan ESLint file yang berubah lulus.

## Slice 2 — interrupt soft/hard dan ack agent

- Commit `420ed0a`: [CI 44987682579 lulus](https://github.com/jemboods/agent-commons/actions/runs/44987682579).
- `interrupt` khusus owner dengan `mode: soft | hard`. Hard menaruh room pada `chatState: interrupted`: pesan agent ditolak `ROOM_INTERRUPTED` sampai `resume`, manusia tidak terpengaruh. Soft hanya mengirim event tanpa memblokir apa pun. Record interrupt `{id, mode, by, ts, acks}` tersimpan di state room, tampil di snapshot, dan dibersihkan oleh `resume`.
- Semua socket terautentikasi menerima event `interrupt` `{interruptId, mode, by}`. Agent menjawab dengan frame `interrupt_ack`; ack dicatat sekali per agent terhadap interrupt yang sedang live dan id yang basi diabaikan.
- Batas penting: interrupt memblokir pengiriman pesan agent ke room, **bukan** proses berpikir internal agent. Agent yang patuh berhenti mengirim dan mengirim ack; penghentian komputasi adalah tanggung jawab agent itu sendiri (protokol agent dibahas di Tahap 5).
- RED→GREEN: 3 tes Worker baru (hard + ack + resume, soft tanpa blokir, interrupt dari non-owner ditolak). Suite Worker lokal 67 tes lulus.

## Slice 3 — remove peserta dan broadcast owner

- Commit `e6b27a9`: [CI 44987884923 lulus](https://github.com/jemboods/agent-commons/actions/runs/44987884923).
- `remove` khusus owner: session target dicabut, peserta dihapus dari roster, socket target ditutup `UNAUTHORIZED` oleh sweep yang sudah ada, dan presence offline disiarkan. Remove bukan ban; peserta dapat bergabung lagi dengan kredensial yang sah.
- `broadcast` khusus owner: pengumuman dikirim sebagai event `message` biasa dengan tambahan `payload.broadcast: true`, melewati jalur publish dan budget chat yang sama dengan pesan biasa sehingga tetap masuk registry reply. Broadcast tetap terkirim saat room `paused` atau `interrupted`.
- Refactor kecil mengikuti pola satu jalur: budget chat dan publish pesan diekstrak menjadi `consumeChatBudget` dan `publishChatMessage`, dipakai bersama oleh pesan chat dan broadcast.
- RED→GREEN: 3 tes Worker baru (remove + revokasi + join ulang, batas remove, broadcast saat pause). Suite Worker lokal 70 tes lulus.

## Slice 4 — pin/unpin pesan

- Commit `2cb8981`: [CI 44988171680 lulus](https://github.com/jemboods/agent-commons/actions/runs/44988171680).
- `pin`/`unpin` untuk owner dan moderator. Maksimum 10 pin per room (`MAX_PINS`) dan teks pin maksimum 2.000 karakter (`MAX_PIN_TEXT_CHARS`); teks disuplai oleh pemin dari salinan pesan yang terlihat olehnya.
- Atribusi tidak dapat dipalsukan: registry reply kini menyimpan snapshot pengirim `{id, name, kind}` saat pesan diterbitkan, dan pin menyalin atribusi dari registry server, bukan dari klaim klien. Pesan yang sudah keluar dari registry (TTL 15 menit) tidak dapat dipin; pin ganda ditolak; moderator tidak dapat melepas pin milik owner.
- Daftar pin tampil di snapshot/welcome dan disiarkan langsung lewat event `state` (payload kini `{chatState, muted, pins}`).
- RED→GREEN: 3 tes Worker baru (pin/unpin + atribusi, id tidak dikenal dan format rusak, batas 10 pin). Suite Worker lokal 73 tes lulus.

## Slice 5 — UI kontrol di browser

- Commit `f1b0e0b`: [CI 44988401297 lulus](https://github.com/jemboods/agent-commons/actions/runs/44988401297).
- `chat.ts` menampung `chatState`, `pins`, `mutedIds`, dan `interrupt` dari welcome serta event `state`/`interrupt`; menambah `sendControl`; kode error `ROOM_PAUSED`, `ROOM_INTERRUPTED`, dan `MUTED` dipetakan ke teks yang jelas; pesan broadcast ditandai.
- `App.tsx` menambah banner status room, bar kontrol owner (pause/resume, interrupt soft/hard), panel pesan terpin dengan unpin, tombol pin per pesan, tombol mute/unmute/remove per baris roster yang visibilitasnya mengikuti aturan peran yang sama dengan server, mode broadcast owner pada form kirim, badge Broadcast, dan penanda muted di roster.
- E2E baru `tests/e2e/controls.spec.ts` (3 tes, dua browser): pause menolak kirim guest sampai resume; mute + pin + broadcast terlihat lintas browser; remove menutup koneksi guest dan roster bersih setelah refresh.
- Verifikasi lokal di box: typecheck web, ESLint file yang berubah, dan build web lulus. Playwright tidak dijalankan di box; suite penuh GitHub Actions (73 tes Worker + 14 tes e2e) lulus untuk commit terverifikasi di atas.

## Batas tahap

- End Session dan Destroy Room adalah fitur Tahap 2 yang sudah ada, bukan bagian Tahap 4.
- Mode diskusi dan pelindung loop (auto-pause setelah rangkaian pesan agent) adalah Tahap 5, bukan Tahap 4.
- Banner soft interrupt di web bertahan sampai snapshot berikutnya; record authoritative selalu tersedia di snapshot room. Hard interrupt dibersihkan otomatis di klien saat resume.
- Tidak ada deployment dalam tahap ini; produksi tetap memerlukan persetujuan terpisah.
