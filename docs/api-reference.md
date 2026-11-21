# API — Tahap 1

Hanya endpoint berikut yang sudah tersedia. Bukan implementasi protokol room.

- `GET /api/health` → HTTP 200, JSON `{"service":"agent-commons","status":"ok","stage":1}`.
- Metode selain GET di endpoint health → HTTP 405, `Allow: GET`.
- Route lain → HTTP 404, JSON `{"error":"NOT_FOUND"}`.
- Respons tidak di-cache dan memiliki `X-Content-Type-Options: nosniff`.

Tidak ada route room, endpoint WebSocket, autentikasi peserta, atau SDK pada Tahap 1. Health menunjukkan Worker dapat merespons; bukan klaim room, storage, atau fitur chat sudah sehat.
