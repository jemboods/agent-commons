# Tahap 3 — checkpoint Chat

Status: **berjalan, belum selesai**. Kontrak: `docs/stage-3-contract.md`.

## Slice 1 — transport dan autentikasi WebSocket

- Menambahkan route room-scoped `/api/rooms/:id/ws`, Hibernation API, join v1 lewat frame (tanpa token di URL), dan welcome server-authored setelah validasi session serta membership.
- Origin allowlist tetap berlaku; native tanpa Origin tetap wajib autentikasi. Cleartext hanya loopback. Frame teks dibatasi 32 KiB UTF-8 dan schema join menolak field tambahan.
- Attachment hanya menyimpan identitas terverifikasi/digest; pending socket dibatasi 16 per room dan 10 detik, total socket aktif dibatasi 200. Alarm DO mempertahankan cleanup room sekaligus expiry koneksi. Leave/revocation/destroy menutup socket tanpa membocorkan roster.
- Wire shape dan batas live-only didokumentasikan di `docs/api-reference.md`. Belum ada fan-out pesan, presence, typing, browser chat, atau reconnect history.

## Hasil verifikasi lokal checkpoint

- RED awal: tes welcome gagal karena endpoint lama mengembalikan 401, bukan upgrade 101. RED keamanan berikutnya: 7 kegagalan nyata untuk cleartext/query, metadata deadline, field ekstra, alarm pending, cap pending, dan revocation HTTP.
- GREEN: `pnpm --filter @agent-commons/worker exec vitest run test/websocket.test.ts test/rooms.test.ts` — **34 tes lulus** (dua file, 5,67 detik total).
- `pnpm --filter @agent-commons/worker typecheck`, ESLint pada dua file Worker yang berubah, dan `git diff --check` lulus.
- Peringatan runtime yang sudah dikenal tetap ada: proxy environment dan package pool Cloudflare yang berganti nama. Tidak mengganti stack/dependency.
- Tidak menjalankan Playwright, e2e, `pnpm check` penuh, atau deploy di box. Suite penuh diserahkan kepada GitHub Actions setelah push checkpoint ini; jangan menganggap tahap atau CI baru lulus sebelum hasil remote dibaca.
- Baseline remote sebelum implementasi: `943281744435ab0714ea83a6bdf90fff97be90c1`, [CI lulus](https://github.com/jemboods/agent-commons/actions/runs/44928886851).

## Slice 1 — verifikasi remote

Commit `e9bf9170e1c64f23eddff08b05a1aa1b2cd72a63`: [CI 44930120673 lulus](https://github.com/jemboods/agent-commons/actions/runs/44930120673), dibaca sebelum memulai slice berikutnya. Baseline lokal WebSocket juga lulus: 23 tes, satu file, 2,94 detik.

## Slice 2a — fan-out chat teks terotorisasi

- Backend menerima frame `message` v1 dengan payload `text` saja, membuat ID/pengirim/room/timestamp dari server, dan mengirim event identik ke semua koneksi terautentikasi room itu, termasuk pengirim. Pending socket, room lain, session expired/dicabut tidak menerima pesan.
- Validasi field ketat dan UTF-8 maksimum 32 KiB pada frame masuk maupun event lengkap; snippet tetap teks. Observer read-only berdasarkan role terkini. Error izin/laju hanya dikirim ke pengirim tanpa menutup koneksi.
- Budget tersimpan di state DO dan dibagi semua socket/session peserta: manusia 5 pesan/2 detik, agent 1 pesan/2 detik. Tidak menyimpan isi pesan atau menjanjikan replay/history. Reply/mention belum didukung; slice 2 sengaja dibagi agar checkpoint tetap kecil.
- RED→GREEN nyata untuk fan-out (sebelumnya ditutup `INVALID_MESSAGE`), observer (sebelumnya dapat mengirim), budget multi-socket (sebelumnya lolos), batas agent, serta event keluaran yang melewati 32 KiB. Ditambah regresi field spoofing, Unicode, isolasi room dan expiry/revocation penerima.
- `pnpm --filter @agent-commons/worker exec vitest run test/websocket.test.ts test/rooms.test.ts`: **49 tes lulus**, 2 file, 7,25 detik. Worker typecheck, ESLint kedua file Worker yang diubah, dan `git diff --check` lulus. Peringatan proxy/pool Cloudflare lama tetap ada; tanpa dependency/teknologi baru.
- Full suite, Playwright/e2e dan deploy tidak dijalankan di box. CI checkpoint baru belum dinyatakan lulus; periksa hasil remote setelah push.

## Lanjut

Periksa CI checkpoint slice 2a; perbaiki bila gagal dan tunggu tick berikutnya jika masih berjalan. Setelah hijau, lanjut slice 2b: target reply dan mention satu room dengan metadata reply bounded/short-lived, tanpa menyimpan isi percakapan sebelum Tahap 6. Selanjutnya slice 3 presence/typing/browser dan slice 4 acceptance di CI. Tahap 3 baru selesai setelah seluruh acceptance termasuk browser-ke-backend lulus dan commit/link CI final dicatat.
