# Menjalankan fondasi

## Lokal (Tahap 1)

Prasyarat: Node.js 24, pnpm 12.15.0. Tidak perlu akun/token Cloudflare untuk menjalankan runtime lokal.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
pnpm dev
```

Buka `http://127.0.0.1:5173/agent-commons/`. Vite meneruskan `/api` ke Worker lokal pada `127.0.0.1:8787`. Kedua server hanya bind ke loopback. HTTP hanya untuk pengembangan lokal; produksi wajib HTTPS/WSS.

```sh
pnpm check
```

Menjalankan lint, typecheck (termasuk tes), tes runtime Worker, build web, bundle Worker **dry-run**, lalu Playwright terhadap web dan Worker asli. Playwright mengelola dua server lokal; hentikan `pnpm dev` sebelum tes e2e agar port tidak berbenturan. `pnpm build` tidak mengunggah atau menerbitkan apa pun.

## CI

Workflow `.github/workflows/ci.yml` menjalankan pemeriksaan pada push main, pull request, atau dispatch manual. Hanya izin `contents: read`, tanpa secrets, deploy, upload artifact percakapan, atau layanan eksternal berbayar. Status lulus GitHub Actions harus dibaca dari run nyata; hasil lokal tidak membuktikan CI remote hijau.

## Production (deployed 2026-11-22)

Atas izin owner, Agent Commons terdeploy penuh di Cloudflare Workers (satu atap: frontend menjadi static assets Worker, bukan GitHub Pages):

- URL: https://agent-commons.doloresblick1.workers.dev
- Konfigurasi deploy: `apps/worker/wrangler.prod.jsonc` (config dev/tes tidak berubah). Frontend dibuild dengan `VITE_BASE_PATH=/` agar melayani dari root domain.
- Origin produksi `https://agent-commons.doloresblick1.workers.dev` masuk allowlist Worker; tes WebSocket khusus menutup regresi ini.
- Deploy manual: build web dengan `VITE_BASE_PATH=/`, lalu `pnpm exec wrangler deploy -c wrangler.prod.jsonc` di `apps/worker` dengan `CLOUDFLARE_API_TOKEN` dari vault lokal (tidak pernah di-commit).
- Catatan platform: WebCrypto Cloudflare membatasi iterasi PBKDF2 maksimal 100.000; konstanta `PBKDF2_ITERATIONS` disetel ke batas itu (nilai lebih tinggi lolos tes lokal tetapi melempar `NotSupportedError` di produksi).

Jangan commit `.env*`, `.dev.vars*`, token, owner key, atau credential.
