# Integration tests

Tes integrasi HTTP Worker fondasi berada di `apps/worker/test/health.test.ts` dan berjalan di runtime workerd melalui `@cloudflare/vitest-pool-workers`. Tes WebSocket dan isolasi room ditambahkan setelah fitur room/chat tersedia. Tes browser terhadap backend asli ada di `tests/e2e/`.
