# Tahap 2 — Room

## Progress

Tahap 2 selesai dan terverifikasi. Implementasi hanya menyediakan room HTTP lokal dengan satu SQLite-backed Durable Object per room; tidak melakukan deployment.

## Completed

- Membuat room dan owner key satu kali; kode akses dan invitation untuk join.
- Mode Public/Private/Hybrid, roster snapshot, kapasitas dan expiry.
- Session 24 jam yang dibatasi expiry room; pemulihan owner melalui owner key.
- Perubahan pengaturan dan kode akses, invitation terbatas, role/izin peserta, leave, dan penghapusan room.
- Validasi input/ukuran request, autentikasi/otorisasi backend, hashing kredensial, lockout dan rate limit per-room.
- UI memakai backend lokal nyata; kredensial tidak disimpan di localStorage/sessionStorage. Roster tidak mengklaim presence.
- Dokumentasi endpoint dan kontrak Tahap 2 diperbarui.

## Changed Files

- `apps/worker/src/index.ts`, `apps/worker/wrangler.jsonc`, `apps/worker/test/rooms.test.ts`
- `apps/web/src/App.tsx`, `apps/web/src/api.ts`, `apps/web/src/main.tsx`, `apps/web/src/style.css`
- `tests/e2e/rooms.spec.ts`, `tests/e2e/foundation.spec.ts`
- `docs/api-reference.md`, `docs/architecture.md`, `docs/stage-2-contract.md`, `docs/stage-2.md`

## Testing

- Lokal: lint, typecheck, build web, Worker dry-run build, dan 14 tes Worker lulus.
- GitHub Actions CI lulus untuk commit `6a03d2a47679d9e7b6947dc65ff9a01971f7854c`, run 44889972483: audit, lint, typecheck, tes Worker, build, dan e2e browser seluruhnya lulus. E2E dijalankan di CI, bukan di box lokal.
- Tes regresi tambahan membuktikan lockout credential terhapus secara persisten setelah owner berhasil memulihkan sesi. Kegagalan e2e untuk room yang sudah dihapus juga diperbaiki dan tervalidasi di CI.

## Issues / batasan

- Tidak ada pembatasan global pembuatan room lintas-isolate/akun; mitigasi ini belum tersedia dan tidak boleh dianggap sebagai perlindungan penyalahgunaan global.
- Worker masih mempertahankan health response `stage: 1` demi kompatibilitas fondasi.
- Peringatan CI: `@cloudflare/vitest-pool-workers` telah berganti nama; migrasi package menunggu persetujuan karena kontrak tidak mengizinkan penambahan teknologi diam-diam. Action CI juga memberi peringatan Node.js 20 deprecated, tetapi job berhasil.
- Tidak ada chat, WebSocket, SDK, penyimpanan riwayat pesan, backup/export, upload media, atau deployment.

## Next Step

Tahap 3 (Chat) hanya dimulai setelah owner menyetujui tahap berikutnya. Jangan deploy Worker atau frontend tanpa izin owner.
