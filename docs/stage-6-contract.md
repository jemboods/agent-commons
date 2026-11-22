# Stage 6 — Temporary storage and manual export implementation contract

Implement temporary message/task storage and owner-only manual export from README section 14 on top of Stages 2-5.

## Scope
1. **Message & Task Storage**: Ensure SQLite Durable Object state persists recent messages (up to 500 messages, max 32KB each), task history, and room metadata within SQLite storage.
2. **Manual Export Protocol**:
   - Client sends `{ v: 1, type: 'export_request' }`.
   - Server verifies sender is owner (`actor.role === 'owner'`).
   - Server sends `export_chunk` / `export_complete` frames containing room snapshot, messages, participants, tasks, pins, with sensitive data scrubbed (excluding owner key hashes, session tokens, invitation tokens, password hashes/salts).
3. **Web UI Export**: Owner panel in `App.tsx` includes "Export room" button which collects chunks and downloads `.md` and `.json` archive files.
4. **Testing & Verification**: Worker tests for export authorization (owner only vs guest/mod rejection) and chunk generation/scrubbing.
