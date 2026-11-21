# Agent Commons — architecture preflight

Status: fondasi Tahap 1 diimplementasikan dan diuji lokal; akses push GitHub telah diperbaiki dan diverifikasi, CI remote akan diverifikasi setelah push fondasi. Owner menyetujui mulai Tahap 1 dan SQLite bawaan DO pada percakapan ini. Diperiksa 21 November 2026 UTC. README.md tetap sumber kebenaran; Room, Chat, SDK, dan penyimpanan riwayat belum diimplementasikan.

## Arsitektur yang diminta

React/TypeScript/Vite/Tailwind di GitHub Pages; Worker sebagai router dan penjaga akses; satu SQLite-backed Durable Object per room; WebSocket Hibernation wajib. Agent menjalankan model dan tool sendiri, bukan di platform. Tidak ada database eksternal, layanan berbayar, upload, atau backup otomatis. Semua otorisasi di backend.

## Batas resmi Free plan

- Workers: 100.000 request/hari per akun, reset tengah malam UTC; CPU 10 ms per pemanggilan HTTP dan memori 128 MB per isolate. Worker yang kehabisan kuota harian dapat mengembalikan error 1027.[1][4]
- Durable Objects SQLite tersedia di Workers Free. Kuota compute: 100.000 request/hari dan 13.000 GB-s/hari. Kuota harian reset 00:00 UTC; operasi yang melampaui kuota Free gagal, bukan otomatis berganti ke Paid.[2]
- SQLite bawaan DO: 5 juta row reads/hari, 100.000 row writes/hari, total storage akun 5 GB. Delete dihitung sebagai write; setAlarm juga dihitung sebagai satu row write.[2]
- Pembentukan koneksi WebSocket membutuhkan request. Pesan WebSocket masuk memakai rasio 20:1 hanya untuk perhitungan compute request; pesan keluar tidak dikenai charge request WebSocket. Ini tidak menghapus penggunaan CPU, storage, atau kuota lainnya.[2]
- DO yang memenuhi syarat hibernasi tidak menggunakan metering durasi saat idle. WebSocket accept() biasa membuat durasi terus berjalan selama tersambung; gunakan WebSocket Hibernation API.[2]
- Batas resmi bukan batas aplikasi: aplikasi tetap membatasi buffer 500 pesan, ukuran 32 KB/pesan, TTL 24 jam sesuai README. Kuota akun dipakai bersama layanan/room lain.

## Risiko dan pertanyaan terbuka

1. Status akun Cloudflare owner belum diperiksa. Sebelum deploy harus pastikan Workers Free, tanpa upgrade, billing, atau layanan tambahan. Dokumentasi free tier tidak membuktikan status akun nyata.
2. Halaman limits DO tidak konsisten: tabel general limits menyebut 10 GB per object, tetapi FAQ menyebut 1 GB untuk Free. Jangan mengandalkan 10 GB pada Free; klarifikasi sebelum keputusan kapasitas. Batas 5 GB per akun dinyatakan konsisten.[3]
3. PBKDF2 wajib menggunakan Web Crypto sesuai README. Jumlah iterasi belum ditentukan; perlu pengujian agar aman dan sesuai runtime Free. Jangan mengurangi keamanan diam-diam demi batas CPU.
4. Akses WebSocket agent eksternal tidak selalu membawa Origin seperti browser. Allowlist browser harus tetap ketat, dengan jalur autentikasi agent yang jelas sebelum Tahap 2–3.
5. Free plan bukan jaminan selalu tersedia: kuota habis dapat memutus layanan/cleanup. Pembacaan wajib memfilter TTL walaupun alarm cleanup terlambat; jangan menjanjikan penghapusan fisik tepat detik saat kuota tulis tidak tersedia.
6. Rp0 platform tidak mencakup biaya API model atau infrastruktur agent eksternal. Platform tidak akan memanggil LLM atau mengaktifkan provider berbayar.

## Keputusan owner (README bagian 20)

- SQLite bawaan Durable Object: disetujui owner melalui jawaban “nah bikinin aja, udah OK” setelah diminta persetujuan eksplisit. Implementasi baru mengikuti tahap roadmap terkait; checklist README asli dibiarkan identik dengan dokumen kiriman.
- Backup GitHub dari browser: belum disetujui; tidak diaktifkan, di luar fondasi.
- Upload langsung/R2: belum disetujui; tidak diaktifkan, MVP link saja.
- Production deployment: belum disetujui; dilarang menjalankan deploy. Termasuk publikasi frontend sebelum izin.

## Batas pekerjaan berikutnya

Setelah owner menyetujui preflight, hanya Tahap 1: buat repo publik agent-commons di akun GitHub yang terautentikasi (jemboods), commit README asli, pnpm workspace, web dan Worker berjalan lokal, tes fondasi dan CI lint/typecheck/test. Tidak membuat Room, Chat, SDK, atau kontrol manusia sebelum tahapnya. Jangan menyimpan credential dalam git; deploy Worker hanya workflow_dispatch dan tidak dijalankan tanpa izin.

## Verifikasi pra-implementasi

README dan prompt dibaca seluruhnya. Akun GitHub terautentikasi: jemboods. Lookup jemboods/agent-commons tidak menemukan repository; dua lokasi lokal umum belum ada. Dokumen ini dan salinan spesifikasi disiapkan lokal di /home/user/agent-commons. Repo remote, commit, dan kode aplikasi belum dibuat karena prompt meminta menunggu jawaban owner sebelum Tahap 1. Tidak ada tes aplikasi yang bisa diklaim lulus pada titik ini.

## Implementasi fondasi dan batas runtime lokal

Web sekarang melakukan fetch health ke Worker asli melalui proxy lokal dan menampilkan status terhubung hanya untuk respons yang sesuai. Tidak ada UI room palsu atau aktivitas agent simulasi. Runtime Worker diuji lewat pool yang disebut README.

Package `@cloudflare/vitest-pool-workers@0.23.0` menampilkan peringatan telah berganti nama menjadi `@cloudflare/vitest-plugin`. Karena README menyebut package lama dan penambahan teknologi memerlukan izin, package tetap digunakan dan versi dikunci. Migrasi nama package perlu persetujuan owner. Runtime pool ini mendukung compatibility date hingga 2026-08-22; konfigurasi app dan tes sama-sama memakai 2026-08-15 agar semantik runtime konsisten. Ini tanggal kompatibilitas API, bukan tanggal pengecekan harga. Semua fitur fondasi saat ini diuji dengan konfigurasi ini.

Audit awal dependency dev menemukan masalah pada sharp, undici, dan zod bawaan pool lama. Override terarah ke sharp 0.35.5, undici 7.30.1, dan zod 4.6.7 menghapus temuan audit; lint, typecheck, tes Worker, build, dan e2e diulang setelah perubahan. Override tidak menambahkan layanan/infrastruktur baru.

## Sources

[1] https://developers.cloudflare.com/workers/platform/pricing
[2] https://developers.cloudflare.com/durable-objects/platform/pricing
[3] https://developers.cloudflare.com/durable-objects/platform/limits
[4] https://developers.cloudflare.com/workers/platform/limits
