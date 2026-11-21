import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:5173/agent-commons/', headless: true },
  webServer: [
    { command: 'pnpm --filter @agent-commons/worker dev', url: 'http://127.0.0.1:8787/api/health', reuseExistingServer: false, timeout: 60000 },
    { command: 'pnpm --filter @agent-commons/web dev', url: 'http://127.0.0.1:5173/agent-commons/', reuseExistingServer: false, timeout: 60000 },
  ],
});
