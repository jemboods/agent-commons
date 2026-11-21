# Tahap 2 — agreed implementation contract

Owner approved stage 2 and these defaults in chat: Public accepts a valid code; Private only invitations; Hybrid either. Default 20 participants including owner, 24h room, 24h sessions clipped to room expiry, invitations one-use/1h, five wrong credentials -> 15-minute per-IP/per-room lockout. Access code never grants Owner/Moderator. No production deployment.

## Stage boundary

Implement real local create/join, invitations, participant list, roles and permission changes, owner recovery via owner key, room settings/access-code changes and deletion. No chat, WebSocket/presence/typing simulation, SDK, automatic backups, R2, or model calls. UI shows membership snapshot, not online presence. HTTP is allowed only on loopback dev. SQLite-backed DO binding one per room; built-in storage only.

## HTTP contract (JSON)

All protected routes require `Authorization: Bearer <opaque sessionToken>`; token never in URL. Rooms use server-generated ID `r_` + UUID without hyphens (32 lowercase hex). No lookup/global uniqueness by display name or shared code. Join requires room ID plus code or invitation; UI must make that clear. All responses no-store/nosniff; error body `{error: CODE}` without input reflection.

RoomView: `{id,name,description,mode,maxParticipants,createdAt,expiresAt,accessCodeEnabled}`; timestamps ISO strings. Participant: `{id,name,kind:'human'|'agent',role:'owner'|'moderator'|'human'|'agent'|'observer',joinedAt,canInstruct:boolean}`. Never return stored hashes/keys/tokens in room snapshots or participant records.

- POST `/api/rooms` body `{name,description?,accessCode,ownerName,mode?,maxParticipants?,lifetimeHours?}` -> 201 `{room,participant,sessionToken,sessionExpiresAt,ownerKey}`. Display ownerKey once, no persistent browser credential storage.
- POST `/api/rooms/:id/join` body `{name,kind,accessCode? ,invitationToken?}` -> 200 `{room,participant,sessionToken,sessionExpiresAt}`. Exactly one credential. No accepted role/permissions/user IDs from this request; reject unknown keys rather than accepting privilege injection.
- POST `/api/rooms/:id/owner-session` body `{ownerKey}` -> 200 same session response for the existing owner; never return ownerKey again.
- GET `/api/rooms/:id` -> 200 `{room,participants,self}` for authenticated member. No anonymous roster.
- PATCH `/api/rooms/:id` owner-only body subset `{name,description,mode,maxParticipants,expiresAt}` -> 200 `{room}`. New expiry must be future and bounded; never silently extend existing session expiry.
- PUT `/api/rooms/:id/access-code` owner-only `{accessCode: string|null}` -> 200 `{ok:true}`. Code >=12 chars when enabled. Rotation does not confer owner rights or reset existing sessions.
- POST `/api/rooms/:id/invitations` owner-only `{role:'human'|'agent'|'observer',name?,maxUses?,expiresInSeconds?}` -> 201 `{invitationToken,expiresAt,maxUses}`. Defaults one use/3600s; cap expiry at room expiry. Optional name restricts claimed display name, NOT verified identity. Observer may be human or agent but cannot instruct. Invitation must match role kind for human/agent.
- PATCH `/api/rooms/:id/participants/:pid` owner-only `{role:'moderator'|'human'|'agent'|'observer',canInstruct?:boolean}` -> 200 `{participant}`. Never replace/demote/promote to Owner. Agent-kind participant cannot become human/moderator/owner. Moderator permission defaults off; only owner may enable. Role changes apply immediately to existing sessions.
- POST `/api/rooms/:id/leave` member -> 200 `{ok:true}`; revoke participant sessions, remove nonowner membership (frees capacity); owner identity retained for owner-key recovery.
- DELETE `/api/rooms/:id` owner-only -> 200 `{ok:true}`; delete storage+alarm, no data exposed after destroy.

Existing GET /api/health and 404 GET /api/rooms can remain backwards compatible; add no dummy endpoints.

## Security and validation

Use PBKDF2-SHA256 + random 16-byte salt, target 600000 iterations with real runtime tests (never silently lower security); random 32-byte tokens and owner key, SHA256 digests for high-entropy credentials at rest. Persist metadata/participants/sessions/invitations/lockouts in SQLite DO storage. No plaintext credential persisted. Serialize read-modify-write to avoid invitation replay, capacity, role/expiry races; expiry checked on every route and an alarm cleans expired room storage. No external fetch. Origin exact allowlist for local web and target `https://jemboods.github.io`; allow no-Origin agent HTTP clients but still require credentials; origin not authentication. Production not deployable until account/free-tier/security review. Never trust forwarded participant identity/IP headers from public request; use Cloudflare connecting IP at edge, documented loopback development fallback. Per-room rate limiting persisted/bounded; creation abuse controls must be honestly documented if only isolate-local at this stage. Limit request body size and string/count/date fields; reject unknown privilege-bearing keys. All unauthorized and cross-room access rejected. Request logs must not include input/token content.

## Ownership of work

Backend task owns apps/worker/** only. Frontend task owns apps/web/**, tests/e2e/** only. Parent handles docs, dependency/config coordination, independent review, git/remote verification/CI. Do not commit or push from children. Do not add dependencies/technologies without parent approval. Follow tests-first RED/GREEN; no fabricated test results.
