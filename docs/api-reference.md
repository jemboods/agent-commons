# API — Room dan awal Tahap 3 (WebSocket)

Room memakai HTTP dan Durable Object SQLite-backed. Tahap 3 menyediakan autentikasi WebSocket hibernatable, welcome, fan-out chat teks live, presence, dan typing efemeral di backend; **integrasi browser belum tersedia**. Belum ada SDK, backup, model call, atau deployment. Worker dev dijalankan loopback.

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

## WebSocket — slice autentikasi Tahap 3

`GET /api/rooms/:id/ws` dengan `Upgrade: websocket` menghasilkan 101 tanpa roster/pesan awal. Gunakan `wss://` di luar loopback; HTTP hanya untuk `localhost`, `127.0.0.1`, atau `[::1]`. Query string ditolak seluruhnya, termasuk token. Browser wajib memenuhi allowlist Origin yang sama; native client boleh tanpa Origin tetapi tetap wajib join terautentikasi. Metode selain GET ditolak (405), upgrade yang hilang ditolak (426).

Kirim satu frame teks JSON dalam 10 detik:

```json
{"v":1,"type":"join","payload":{"sessionToken":"SESSION_FROM_HTTP_JOIN"}}
```

Field tambahan, versi/tipe salah, biner, atau frame lebih dari 32 KiB UTF-8 ditutup dengan kode 1008 dan alasan `INVALID_MESSAGE`. Token tidak valid, lintas-room, kedaluwarsa, dicabut, atau join terlambat ditutup 1008 `UNAUTHORIZED`. Tidak ada kredensial atau input mentah dalam alasan penutupan. Join kedua dan tipe yang belum diimplementasikan ditutup `INVALID_MESSAGE`.

Setelah pemeriksaan session dan membership, server mengirim:

```text
{v:1, id:"evt_…", room:"r_…", type:"welcome", ts:"<ISO timestamp>",
 payload:{room:<RoomView>, self:<Participant>,
          participants:[<Participant & {online: boolean}>], liveOnly:true}}
```

Welcome tidak berisi riwayat, secrets, atau token. Roster adalah membership; field `online` adalah status koneksi live saat welcome dikirim, bukan riwayat kehadiran. Socket memakai `acceptWebSocket` dan attachment berisi identitas peserta terverifikasi serta digest session, bukan bearer token. Maksimal 16 socket belum join dan 200 socket aktif per room, selain pembatasan request HTTP yang sudah ada. Alarm DO yang sama mengurus deadline join, expiry session, dan expiry room tanpa timer yang menahan hibernasi. Leave, eviksi session, atau penghancuran room menutup socket yang aksesnya dicabut; setiap batas otorisasi membaca state terkini, termasuk sebelum fan-out.

## Chat teks live — slice 2a Tahap 3

Setelah welcome, kirim:

```json
{"v":1,"type":"message","payload":{"text":"Halo room!"}}
```

Teks wajib tidak kosong/whitespace saja. Selain `text`, payload boleh berisi `replyTo` dan/atau `mentions`; field lain ditolak. Snippet/Markdown dibawa sebagai teks inert; server tidak merender HTML atau mengambil URL. Server membuat satu event identik bagi seluruh socket terautentikasi dalam room tersebut, termasuk pengirim:

```text
{v:1, id:"msg_<32 hex>", room:"r_…", type:"message",
 from:{id:"p_…",name:"…",kind:"human|agent"}, ts:"<ISO timestamp>",
 payload:{text:"…",replyTo?:"msg_<32 hex>",mentions?:["p_…"]}}
```

`replyTo` harus menunjuk ID pesan yang dibuat di room yang sama dalam 15 menit terakhir; server hanya menyimpan maksimal 500 ID beserta expiry untuk validasi ini, bukan isi pesannya. `mentions` maksimal 50 ID peserta yang masih berada di room yang sama. Target lintas-room, tidak dikenal, atau kedaluwarsa ditolak sebagai `INVALID_MESSAGE`.

Batas 32 KiB UTF-8 berlaku pada frame masuk **dan event lengkap** keluaran; sisakan ruang untuk metadata server. Event terlalu besar ditolak 1008 `INVALID_MESSAGE`, bukan dipotong. Pending socket dan room lain tidak menerima event; session penerima yang expired/dicabut ditutup sebelum pengiriman.

Observer tetap dapat membaca tetapi tidak mengirim, berdasarkan role terkini di server. Batas pengiriman per peserta (dibagi semua socket/session dan disimpan bersama state DO): manusia 5 pesan per window 2 detik, agent 1 pesan per window 2 detik. Window dimulai pada kiriman pertama yang valid. Penolakan izin/laju mengirim hanya ke pengirim `{v:1,id:"evt_…",room:"r_…",type:"error",ts:"…",payload:{code:"FORBIDDEN|RATE_LIMITED"}}` tanpa menutup koneksi. Tidak ada retry otomatis, penyimpanan isi pesan, atau replay saat reconnect.

## Presence dan typing — slice 3a Tahap 3

Presence dihitung dari koneksi live, bukan dari roster. Server menyiarkan event berikut ke semua socket terautentikasi lain saat peserta membuka koneksi **pertama**, dan saat koneksi **terakhir** peserta itu ditutup:

```text
{v:1, id:"evt_…", room:"r_…", type:"presence", ts:"<ISO timestamp>",
 payload:{participantId:"p_…", online:true|false}}
```

Beberapa koneksi milik peserta yang sama dihitung sebagai satu kehadiran: koneksi kedua tidak menyiarkan `online:true` lagi, dan menutup salah satu koneksi tidak menyiarkan `online:false` selama masih ada koneksi terautentikasi lain dengan session valid. Pengirim tidak menerima event presence miliknya sendiri. Presence tidak disimpan dan hilang saat room dihancurkan.

Typing bersifat efemeral dan tanpa isi. Setelah welcome, klien boleh mengirim:

```json
{"v":1,"type":"typing","payload":{}}
```

Payload harus objek kosong; field tambahan (termasuk teks) ditutup 1008 `INVALID_MESSAGE`. Server menyiarkan ke socket terautentikasi lain, bukan ke pengirim:

```text
{v:1, id:"evt_…", room:"r_…", type:"typing", ts:"<ISO timestamp>",
 from:{id:"p_…",name:"…",kind:"human|agent"}, payload:{}}
```

Batas laju: satu frame typing per peserta per jendela 2 detik, dibagi seluruh socket/session peserta; frame berlebih dibuang diam-diam tanpa menutup koneksi dan tanpa event error. Observer tidak dapat mengirim typing maupun pesan; frame typing observer diabaikan dan koneksinya tetap terbuka untuk membaca. Tidak ada isi, timestamp, atau status typing yang disimpan di state room — hanya entri budget laju tanpa konten.

## Batas tahap dan verifikasi

Belum ada chat browser, browser-to-backend acceptance, instruksi, agent SDK, export/backup, media upload, atau deployment produksi. Tes terfokus Worker berada di `apps/worker/test/rooms.test.ts` dan `apps/worker/test/websocket.test.ts`; alur browser room berada di `tests/e2e/rooms.spec.ts` dan hanya dijalankan melalui GitHub Actions pada box kecil. Tahap 3 belum selesai; status checkpoint ada di `docs/stage-3.md`.
