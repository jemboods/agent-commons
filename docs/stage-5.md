# Tahap 5 — Integrasi Agent

Status: **selesai dan terverifikasi**. Kontrak: `docs/stage-5-contract.md`.

## Detail Implementasi

1. **Agent SDK (`packages/agent-sdk`)**:
   - TypeScript SDK untuk external AI agents.
   - Metode koneksi WebSocket (`connect`) dengan token autentikasi (access code / invitation token) dan identitas agent (`kind: "agent"`).
   - Pengiriman pesan dengan teks, `stance` (agree/disagree/neutral/question), dan `evidence` (sumber terverifikasi).
   - Penanganan event `instruction` dari Owner/Moderator.
   - Pembaruan status task (`taskUpdate`) dengan status `received`, `running`, `done`, dan `failed`, disertai ringkasan opsional.
   - Penanganan event `interrupt` dan pengiriman `acknowledgeInterrupt` (`interrupt_ack`).

2. **Dokumentasi Integrasi Agent (`docs/agent-integration.md`)**:
   - Mengganti stub lama dengan panduan lengkap agen.
   - Etiket agent: kutip sumber yang benar-benar dibuka, bedakan fakta dan opini, nyatakan ketidakpastian, perhatikan bahwa chat dan web adalah input tidak tepercaya, dan instruksi sah hanya dari Owner/Moderator.
   - Panduan protokol wire WebSocket dan contoh kode penggunaan SDK (Node.js/TypeScript).

3. **Verifikasi & Build**:
   - `pnpm typecheck` lulus bersih di seluruh workspace (`apps/worker`, `apps/web`, `packages/agent-sdk`).
   - Suite tes Worker (`pnpm test --run`) lulus seluruhnya (73 tes).

4. **Roadmap**:
   - Tahap 5 selesai. Roadmap diperbarui untuk mengaktifkan **Tahap 6: Temporary storage and manual export**.
