# Tahap 3 — Chat

Status: **selesai dan terverifikasi**. Kontrak: `docs/stage-3-contract.md`. Commit terverifikasi: `bd87ca8`, [CI 44986578161 lulus](https://github.com/jemboods/agent-commons/actions/runs/44986578161).

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


## Slice 3b — integrasi chat di browser

- Commit `834443e`: hook `useRoomChat` di `apps/web/src/chat.ts` (join frame membawa session token dari memori, tanpa retry otomatis, tanpa penyimpanan browser) dan UI chat di `App.tsx`: timeline live, presence dari welcome/event, indikator typing, kirim/reply, mention lewat ID peserta dari roster, teks tetap inert, status koneksi dan error per kode (FORBIDDEN/RATE_LIMITED) ditampilkan jelas.
- Commit `b70aa94`: dev loopback mengarahkan WebSocket langsung ke Worker (5173 ke 8787) karena proxy Vite tidak meneruskan upgrade WebSocket; allowlist origin Worker tetap berlaku.
- Tes browser `tests/e2e/chat.spec.ts`: dua browser bertukar pesan, reply, dan mention; typing dan presence terlihat lintas halaman; observer ditolak saat mengirim; storage browser tetap kosong.

## Perbaikan acceptance

- CI untuk `834443e` (run 44947379602) dan `b70aa94` (run 44948096141) merah. Slice 3b ditulis Hermes; perbaikan acceptance berikut dikerjakan Muse atas instruksi owner karena kuota harian Hermes habis. Log CI tidak dapat diunduh dari box, jadi kegagalan direproduksi lokal di luar box dengan Playwright melawan backend asli.
- Commit `9063d10`: roster halaman hanya berasal dari snapshot HTTP, jadi peserta yang join setelah snapshot tidak punya baris roster; presence, typing, dan tombol mention untuk mereka tidak pernah tampil. Halaman kini menyinkronkan ulang roster secara diam-diam saat presence menampilkan peserta online yang belum dikenal, sekali per set peserta baru.
- Commit `bd87ca8`: `getByLabel('Message')` pada spec ambigu karena pencocokan substring; ia ikut mencocokkan form "Send a live message" dan tombol "Reply to message from ...". Semua pemanggilan kini memakai `{ exact: true }`, pola yang sama dengan 'Room ID' pada spec yang sama.

## Slice 4 — verifikasi final

- Suite penuh `pnpm check` (lint, typecheck, tes Worker, build, Playwright e2e) hijau di GitHub Actions untuk commit `bd87ca8`: [CI 44986578161](https://github.com/jemboods/agent-commons/actions/runs/44986578161). E2E 11 tes lulus (foundation, rooms, chat); tes Worker 60 lulus.
- Cakupan acceptance kontrak slice 4 (origin buruk, auth invalid/expired/revoked, isolasi room, penolakan observer, batas ukuran dan laju, close/leave/presence, pengiriman multi-klien) tercakup oleh tes Worker dan e2e chat.
- Bentuk wire dan batas live-only didokumentasikan di `docs/api-reference.md`. Tidak ada deployment pada tahap ini.

## Selesai

- Tahap 3 selesai. Roadmap berlanjut ke Tahap 4 (Kontrol manusia) sesuai `docs/roadmap-execution.md`; penulis otomatis `auto-resume-stage-work` masih dijeda, jadi tahap berikutnya menunggu instruksi owner.
