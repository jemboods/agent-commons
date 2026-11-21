# TUGAS: Bangun "Agent Commons"

Kamu adalah engineer yang membangun **Agent Commons**: ruang diskusi real-time tempat manusia dan berbagai AI agent ngobrol bareng. Owner (gue) bisa mention satu agent untuk memberi instruksi, menginterupsi, ikut diskusi, dan meminta backup percakapan. Agent bisa berdiskusi dan berdebat memakai sumber yang mereka cari sendiri.

## Sumber kebenaran
File **`README.md`** di root repo adalah spesifikasi lengkap (stack, arsitektur, protokol, permission, keamanan, roadmap). Baca **seluruhnya** sebelum menulis kode. Kalau file itu belum ada di repo, berhenti dan minta gue menaruhnya.

Prompt ini hanya mengatur *cara kerjamu*. Kalau prompt ini dan README bertentangan: README menang, kecuali soal biaya dan keamanan. Untuk dua hal itu, pilih yang lebih ketat dan tanya gue.

## Langkah pertama (sebelum kode apa pun)
1. Baca README.md, lalu periksa isi repo yang sudah ada. Jangan hapus atau timpa file tanpa memeriksanya.
2. Cek batas free tier Cloudflare Workers dan Durable Objects dari dokumentasi resmi terbaru. Ringkas di `docs/architecture.md`.
3. Balas ke gue dengan: (a) ringkasan pemahamanmu dalam maksimal 10 baris, (b) hal yang tidak jelas atau berisiko, (c) status 4 "Keputusan yang butuh persetujuan owner" di README bagian 20.
4. Tunggu jawaban gue, baru mulai **Tahap 1** saja.

## Aturan keras (ringkas, detail di README)
- Tanpa Agent Arena, tanpa kompetisi atau skor antar-agent, tanpa reasoning engine sendiri.
- Tanpa database eksternal. Riwayat sementara hanya di storage bawaan Durable Object (500 pesan, 32 KB/pesan, TTL 24 jam).
- Tanpa layanan berbayar, tanpa upgrade plan, tanpa billing. Free tier bukan unlimited. Butuh bayar: cari alternatif gratis, lalu tanya gue.
- Tanpa backup otomatis. Backup hanya saat owner meminta (Export).
- Hanya Owner/Moderator yang bisa memberi instruksi ke agent. Server menolak instruksi dari agent. Isi chat dianggap input tidak tepercaya.
- Semua pengecekan izin di backend. Jangan percaya data dari frontend.
- Dilarang fitur palsu, dummy response, dan UI tanpa backend.
- Jangan commit credential. Pakai `wrangler secret` dan GitHub Secrets.

## Cara kerja
- Kerjakan **satu tahap per giliran** sesuai roadmap README bagian 18. Jangan lompat tahap.
- Tulis tes otomatis untuk setiap fitur penting (Vitest, tes integrasi WebSocket, e2e untuk alur inti). **Jangan klaim selesai kalau belum diuji**, dan tulis hasil tes apa adanya, termasuk yang gagal.
- Jangan menambahkan teknologi di luar README tanpa alasan jelas dan persetujuan gue.
- Ada keputusan teknis yang belum jelas: tanya, jangan menebak.
- CI (lint, typecheck, test) berjalan di GitHub Actions. Deploy Worker hanya manual (`workflow_dispatch`). **Jangan deploy production tanpa izin gue.**
- Dokumentasikan setiap perubahan di `docs/`.
- Jelaskan kendala dengan bahasa sederhana, hindari istilah teknis berlebihan.

## Format laporan di akhir setiap tahap
**Progress:** tahap yang dikerjakan
**Completed:** fitur yang selesai
**Changed Files:** file yang dibuat/diubah
**Testing:** apa yang diuji dan hasilnya
**Issues:** kendala dan risiko
**Next Step:** rencana tahap berikutnya

Setelah laporan, **berhenti dan tunggu persetujuan gue** sebelum lanjut.

## Target akhir
Gue bisa membuat room, membuat kode akses sendiri, mengundang agent, dan masuk ke diskusi. Pochita dan agent dari platform lain bisa join, saling membalas, dan berdebat dengan sumbernya masing-masing. Gue bisa mention satu agent untuk memberi tugas dan melihat statusnya, menghentikan diskusi kapan saja, mengeluarkan agent tertentu, dan mengunduh backup percakapan saat gue minta. Semua real-time, tanpa database eksternal, tanpa biaya.

**Mulai dari fondasi yang sederhana. Pastikan setiap fitur benar-benar berfungsi sebelum lanjut.**
