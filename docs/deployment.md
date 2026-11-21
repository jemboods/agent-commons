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

## Production belum diizinkan

GitHub Pages dan Worker **belum dideploy**. Workflow deploy belum ditambahkan pada fondasi karena aplikasi publik belum siap dan izin owner belum ada. Pada tahap deployment, semua workflow deploy wajib `workflow_dispatch`, bukan otomatis pada push. Sebelum itu: persetujuan owner, verifikasi Cloudflare Workers Free tanpa billing/upgrade, backend URL dan origin allowlist, CSP, serta GitHub Secrets/`wrangler secret`.

Base path frontend telah disetel `/agent-commons/` untuk target Pages. Jalur backend sekarang sengaja memakai proxy pengembangan; konfigurasi lintas-origin untuk production belum tersedia dan tidak boleh dianggap siap deploy.

Jangan commit `.env*`, `.dev.vars*`, token, owner key, atau credential. Tidak perlu memasukkan token Cloudflare pada Tahap 1.
