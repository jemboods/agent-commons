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

## Lanjut

Pada tick berikutnya, periksa CI commit implementasi slice ini; perbaiki bila gagal dan tunggu jika masih berjalan. Setelah hijau, lanjut slice 2: pesan server-authored dan fan-out hanya ke socket yang session/membership-nya masih valid, observer read-only, target reply/mention satu room, serta rate limit peserta. Tahap 3 baru selesai setelah seluruh acceptance termasuk browser-ke-backend di CI lulus dan commit/link CI final dicatat.
