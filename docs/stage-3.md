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

## Slice 2b — reply dan mention

- Payload chat menerima `replyTo` dan `mentions` dengan validasi ketat. Reply harus merujuk ID pesan dari room yang sama yang masih aktif; metadata berisi ID + expiry, maksimum 500 entri dan TTL 15 menit—tidak menyimpan teks. Mention dibatasi 50 target peserta dalam room yang sama.
- Event server meneruskan metadata reply/mention setelah validasi. Target lintas-room, tidak dikenal, atau kedaluwarsa ditolak; field server-authored tetap tidak dapat dipalsukan.
- RED terlihat sebelum implementasi: kasus reply/mention sah ditutup `INVALID_MESSAGE` karena backend hanya menerima `text`; empat tes baru mencakup payload valid, reply lintas-room, mention lintas-room, serta expiry dan ketiadaan isi pesan pada metadata.
- Tes fokus awal: `pnpm --filter @agent-commons/worker exec vitest run test/websocket.test.ts -t 'same-room reply|reply target from another room|mention target that is not'` — **3 lulus**. Verifikasi regresi final lokal: `pnpm --filter @agent-commons/worker exec vitest run test/websocket.test.ts test/rooms.test.ts` — **53 lulus**, 2 file; Worker typecheck, ESLint pada dua file Worker, dan `git diff --check` lulus.
- Tidak menjalankan Playwright/e2e, `pnpm check` penuh, atau deploy. CI penuh untuk checkpoint slice ini menunggu hasil GitHub Actions setelah push.

## Slice 3a — presence dan typing backend

- Presence dihitung dari koneksi live per peserta: `welcome` membawa `online` per peserta, event `presence` disiarkan hanya saat koneksi pertama dibuka dan koneksi terakhir ditutup. Multi-koneksi peserta sama dihitung satu kehadiran; pengirim tidak menerima presence miliknya.
- Typing efemeral `{v:1,type:"typing",payload:{}}` disiarkan ke socket terautentikasi lain dengan `from` server-authored, dibatasi satu frame per peserta per 2 detik (budget bersama semua socket/session). Observer diabaikan tanpa menutup koneksi; payload berisi field tambahan ditutup `INVALID_MESSAGE`. Tidak ada teks atau status typing yang disimpan.
- RED→GREEN nyata: tes presence gagal karena `online` belum ada di welcome dan tidak ada event presence; tes typing gagal karena frame typing ditutup `INVALID_MESSAGE` sebelum implementasi. Setelah implementasi, seluruh 4 tes baru hijau.
- Verifikasi lokal: `pnpm --filter @agent-commons/worker test` — **60 tes lulus**, 3 file, 9,44 detik; `pnpm --filter @agent-commons/worker typecheck`, ESLint pada dua file Worker yang berubah, dan `git diff --check` lulus. Peringatan proxy/pool Cloudflare lama tetap ada; tanpa dependency/teknologi baru.
- Commit `47a3e0115bf63ea6dafd0f830abc3caebc297c60`: [CI 44946549954 lulus](https://github.com/jemboods/agent-commons/actions/runs/44946549954).

## Lanjut

- Slice 1, 2a, 2b, dan 3a backend sudah di-commit dengan CI hijau. Sisa Tahap 3: integrasi chat di browser (koneksi + rejoin memakai session in-memory, timeline live, presence, kirim/reply/mention lewat ID peserta, kode sebagai teks, status koneksi/error jelas) dan slice 4 acceptance browser-ke-backend di GitHub Actions beserta dokumentasi wire shape final.
- Integrasi browser sengaja belum dimulai: menunggu keputusan owner setelah slice backend ini dilaporkan. Jangan menandai Tahap 3 selesai sebelum acceptance browser lulus di CI dan commit/link final dicatat.
