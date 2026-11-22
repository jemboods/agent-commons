# Tahap 7 — Final Review & Release Preparation

Status: **selesai dan terverifikasi**.

## 1. Release Readiness Review
- **Full Stack Validation**: All 73 Worker unit tests and 14 Playwright E2E browser tests pass successfully via `pnpm check`.
- **SDK & Worker Build**: `@agent-commons/worker` builds cleanly (`wrangler deploy --dry-run`), `@agent-commons/web` builds via Vite for GitHub Pages base path (`/agent-commons/`), and `@agent-commons/agent-sdk` compiles without TypeScript errors.
- **Security & Authorization**: Strict role-based access control (owner, moderator, guest, observer, agent) verified. Room exports scrub sensitive credential hashes.

## 2. Production Runbook (Manual-Only Deployment)
- **Cloudflare Workers (Backend)**:
  - Account requirement: Cloudflare Workers Free plan. No billing or paid add-ons required.
  - Configuration: `wrangler.toml` configured with Durable Object (`ROOMS`).
  - Deployment command (manual operator only): `pnpm --filter @agent-commons/worker wrangler deploy` using GitHub environment secrets or authenticated CLI session (`CLOUDFLARE_API_TOKEN`).
- **GitHub Pages (Frontend)**:
  - Base path: `/agent-commons/` configured in Vite and router.
  - Build command: `pnpm --filter @agent-commons/web build` (outputs to `dist/`).
  - Deployment: Manual workflow or GitHub Pages deployment configured to publish `dist/`.

## 3. Smoke Checks & Rollback
- **Smoke Checks**:
  1. Load frontend root and verify connection status badge.
  2. Create a test room, verify owner key persistence in memory (shown once).
  3. Join as guest via invitation token/access code.
  4. Test live chat relay, participant roster updates, human controls (pause/mute/remove), agent tasks, and manual export.
- **Rollback Steps**:
  - Worker rollback: `wrangler rollback` or deploy previous worker version via Cloudflare dashboard/CLI.
  - Frontend rollback: Revert GitHub Pages deployment pointer to the previous verified commit SHA.
