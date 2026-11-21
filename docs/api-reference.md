# API — Tahap 2 (Room)

Tahap 2 menyediakan room lokal melalui HTTP dan Durable Object SQLite-backed. API ini **bukan** chat real-time: belum ada WebSocket, presence, pesan, SDK, backup, atau model call. Worker dev dijalankan loopback; belum ada deployment.

## Perilaku umum

- JSON request harus memakai `Content-Type: application/json` dan dibatasi 16 KiB. Field tak dikenal ditolak.
- Respons memiliki `Cache-Control: no-store` dan `X-Content-Type-Options: nosniff`. Error berbentuk `{ "error": "CODE" }` tanpa mengulang input.
- Browser Origin dibatasi ke `https://jemboods.github.io`, `http://localhost:5173`, dan `http://127.0.0.1:5173`. Klien tanpa Origin dapat memakai API tetapi tetap harus menyertakan kredensial pada route terlindungi; Origin bukan autentikasi.
- Route room memakai ID `r_` + 32 digit heksadesimal huruf kecil. Tidak ada lookup berdasarkan nama atau kode akses.
- Route terlindungi memerlukan session token di header Authorization bertipe bearer; token tidak boleh ditempatkan di URL. Session disimpan sebagai digest dan berlaku paling lama 24 jam atau sampai room kedaluwarsa.
- Kode akses di-hash dengan PBKDF2-SHA256 dan salt acak 16 byte; owner key, session token, dan invitation token disimpan sebagai digest. Kredensial plaintext hanya dikembalikan saat diterbitkan.

## Endpoint

| Method & path | Akses | Hasil |
|---|---|---|
| `GET /api/health` | publik | 200, status Worker fondasi (`stage: 1`) |
| `POST /api/rooms` | publik | 201 `{room,participant,sessionToken,sessionExpiresAt,ownerKey}`; owner key ditampilkan satu kali |
| `POST /api/rooms/:id/join` | publik | 200 `{room,participant,sessionToken,sessionExpiresAt}`; tepat satu dari `accessCode` atau `invitationToken` |
| `POST /api/rooms/:id/owner-session` | owner key | 200 session owner baru; owner key tidak dikembalikan |
| `GET /api/rooms/:id` | anggota | 200 `{room,participants,self}`; tidak ada roster anonim |
| `PATCH /api/rooms/:id` | owner | 200 `{room}`; ubah nama, deskripsi, mode, kapasitas, atau expiry terbatas |
| `PUT /api/rooms/:id/access-code` | owner | 200 `{ok:true}`; `{accessCode:null}` menonaktifkan kode, string minimal 12 karakter merotasinya |
| `POST /api/rooms/:id/invitations` | owner | 201 `{invitationToken,expiresAt,maxUses}`; default satu penggunaan dan satu jam |
| `PATCH /api/rooms/:id/participants/:pid` | owner | 200 `{participant}`; ubah role/izin, tanpa pernah mengubah identitas owner |
| `POST /api/rooms/:id/leave` | anggota | 200 `{ok:true}`; sesi dicabut, non-owner dihapus dari roster |
| `DELETE /api/rooms/:id` | owner | 200 `{ok:true}`; menghapus state SQLite dan alarm room |

`RoomView` berisi `{id,name,description,mode,maxParticipants,createdAt,expiresAt,accessCodeEnabled}`. Record peserta berisi `{id,name,kind,role,joinedAt,canInstruct}`. Hash, session token, owner key, dan invitation token tidak disertakan dalam snapshot atau record peserta.

Mode: `public` menerima kode akses atau invitation; `private` hanya invitation; `hybrid` menerima keduanya. Kode akses tidak memberi hak owner. Invitation dapat membatasi nama, role `human`/`agent`/`observer`, jumlah penggunaan, dan masa berlaku (maksimal satu hari serta tidak melewati expiry room). Observer dapat berupa manusia atau agent dan tidak dapat memberi instruksi. Hanya owner dapat mengubah permission; izin moderator untuk memberi instruksi default mati.

Pembuatan room default 20 peserta dan 24 jam; kapasitas maksimum 100, durasi maksimum 168 jam. Lima kredensial salah per IP/room memicu lockout 15 menit. Tiap room juga membatasi request hingga 120 per menit per IP. Data lockout dan rate limit disimpan per-room; **belum ada pembatasan pembuatan room lintas-isolate/akun**, sehingga perlindungan penyalahgunaan pembuatan room belum global.

Status/error utama: `NOT_FOUND` (404), `INVALID_REQUEST` (400; body terlalu besar 413), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `ROOM_FULL` (409), `ROOM_EXPIRED` (410), `RATE_LIMITED` (429), dan `INTERNAL_ERROR` (500). Semua expiry divalidasi di setiap request; alarm menghapus state room yang kedaluwarsa.

## Batas tahap dan verifikasi

Route HTTP hanya untuk fondasi room lokal. Tidak ada WebSocket, chat, online presence, typing, instruksi, agent SDK, export/backup, media upload, atau deployment produksi. Tes Worker berada di `apps/worker/test/rooms.test.ts`; alur browser berada di `tests/e2e/rooms.spec.ts` dan hanya dijalankan melalui GitHub Actions pada box kecil.
