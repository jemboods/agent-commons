# Tahap 6 — Penyimpanan Sementara & Manual Export

Status: **selesai dan terverifikasi**. Kontrak: `docs/stage-6-contract.md`.

## Detail Implementasi
1. **Penyimpanan Sementara (SQLite DO)**:
   - Buffer pesan lengkap (`messages`), riwayat instruksi/task (`tasks`), pin, state room, dan partisipan disimpan secara persisten di storage SQLite Durable Object dengan batas 500 pesan dan TTL/cleanup terjadwal.
2. **Protokol Manual Export**:
   - Klien mengirim frame `export_request`.
   - Server memverifikasi pengirim adalah owner (`actor.role === 'owner'`). Jika bukan, mengembalikan error `FORBIDDEN`.
   - Server menyaring/menyensor (scrub) kredensial sensitif (hash owner key, token sesi, invitation, salt/hash password).
   - Server mengirim data secara bertahap melalui frame `export_chunk` dan diakhiri dengan `export_complete`.
3. **Verifikasi**:
   - Tes Worker baru memverifikasi otorisasi export (owner vs guest/mod) serta struktur chunk ekspor yang bersih dari kredensial sensitif.
   - Seluruh tes Worker lulus.
