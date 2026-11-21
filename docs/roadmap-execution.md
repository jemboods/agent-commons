# Roadmap execution and recovery

The owner authorized implementation of all remaining MVP stages and asked for automatic recovery after restarts. This replaces the per-stage approval requirement for the agreed MVP only. Work in order and file a report after each stage; advance after its acceptance tests pass, without another routine approval.

- Done: 1 Foundation, 2 Room (`9290176`, CI run `44890145439`).
- Active: 3 Chat. See `docs/stage-3-contract.md`. First slice: authenticated hibernatable WebSocket plus connection/security tests.
- Next: 4 Human controls; 5 Agent integration; 6 Temporary storage and manual export; 7 Final review and release preparation.
- Still separately gated: production deployment (Worker **and** Pages), GitHub backup, direct media/R2 upload, paid services/billing and additions outside the agreed stack. SQLite in the room Durable Object was already approved. Do not treat optional features or deployment as part of this authorization. No automatic backups.

## Restart checkpoint

Use Git commits and GitHub Actions as the durable record, not conversation memory. Read the active contract, `git status`, recent history and CI for the active checkpoint. If the last slice was committed locally but not pushed, verify and push it first. Resume known partial edits without discarding them; never overwrite unexplained changes. Keep `Active` and `Next` current and record the tested commit and linked successful CI run in each stage report. Record new blockers with an explicit description; don't re-report the same blocker each tick. Do not advance while the active stage's checks are failing.

The existing Hermes job `auto-resume-stage-work` is the automatic project writer. It works one small, testable slice per invocation. Do not run Playwright, full `pnpm check`, or other heavy tests on the box; use focused lightweight checks there and the existing GitHub Actions workflow for the full suite. Do not use generated Wrangler state, cache, dependencies or log mtimes as evidence of another editor. Never start a second writer against the same working tree. Once all authorized work is verified, stop making changes and report release readiness separately from deployment.
