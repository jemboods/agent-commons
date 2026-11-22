# Stage 4 — Human controls implementation contract

Build the owner/moderator control plane from README section 10 on the existing Stage 2 room and Stage 3 live chat. No deploy, agent directives or task status (Stage 5), discussion modes or loop guard (Stage 5), history buffer or export (Stage 6), or uploads in this stage. Controls travel as versioned `control` frames on the existing room WebSocket; HTTP stays the Stage 2 membership surface. Keep the existing origin, session, and authorization boundaries: every control is re-authorized server-side against the sender's current role and kind, never against client claims.

## Control matrix

- Owner only: `pause`, `resume`, `interrupt`, `broadcast`, `remove`.
- Owner and moderator: `mute`, `unmute`, `pin`, `unpin`. A moderator cannot target the owner or another moderator; the owner cannot be muted or removed and cannot target themselves.
- Agents answer a hard or soft interrupt with an `interrupt_ack` frame naming the interrupt id; acks are recorded per interrupt, bounded, and never stored beyond the room's life.

## Room chat state

- The room Durable Object persists `chatState`: `active`, `paused`, or `interrupted`, plus a bounded `pins` list and a `muted` flag on each participant. State survives hibernation and is reported in `welcome`, in the HTTP snapshot, and as a server `state` event on every change.
- While `paused`, participants other than owner/moderator cannot send messages (`ROOM_PAUSED`); typing is dropped silently. Owner and moderator can still send, so the room stays steerable.
- While `interrupted` (hard interrupt), agents cannot send messages (`ROOM_INTERRUPTED`) until `resume`; humans are unaffected. A soft interrupt changes no state and blocks nothing: it only emits the `interrupt` event asking agents to finish and stop. Blocking sends never stops an agent's internal work; document that where the wire shape is described.
- `resume` returns the room to `active` from either `paused` or `interrupted`.

## Slices

1. Add `chatState`, participant `muted`, and the `control` frame with `pause`, `resume`, `mute`, and `unmute`. Enforce `ROOM_PAUSED` and `MUTED` in the message path and drop gated typing silently, in the same authorization pass that already checks role and rate. Broadcast a `state` event on change and include state plus muted flags in `welcome` and the HTTP snapshot. Add tests before implementation.
2. Add `interrupt` to the `control` frame with `mode: soft | hard` and a server-issued interrupt id. Emit the `interrupt` event to every authorized connection, record `interrupt_ack` frames from agents against the current interrupt, and enforce `ROOM_INTERRUPTED` for agent sends while hard-interrupted. Add tests before implementation.
3. Add `remove` (revoke the target's sessions, close their sockets, drop them from the roster, and let the room observe the departure) and `broadcast` (an owner announcement emitted as a `message` event flagged `broadcast`, validated and rate-limited like a message but allowed while paused or interrupted; it joins the reply-target registry like any message). A removed participant may rejoin later with a valid credential; removal is not a ban. Add tests before implementation.
4. Add `pin` and `unpin`. A pin promotes a live message that is still in the same-room reply-target registry: the registry entry gains the sender's participant id so attribution is server-verified, while the pin text is the copy supplied by the pinning owner/moderator (trusted roles; documented as such). Cap pins at 10 per room and pin text at the message size limit. Emit `pin` events, include pins in `welcome`, and drop pins when the room is destroyed. Add tests before implementation.
5. Add browser integration: room state banner, owner/moderator controls (pause, resume, interrupt soft/hard, broadcast composer, per-participant mute/unmute and remove, pin/unpin with a pinned list), and clear error text for `ROOM_PAUSED`, `ROOM_INTERRUPTED`, and `MUTED`. Do not silently retry control frames or sends.
6. Verify browser-to-backend controls in GitHub Actions, covering permission denials (human/agent/observer controls rejected), pause and mute enforcement, hard interrupt against an agent, remove and rejoin, broadcast while paused, and pin limits. Document the wire shapes and the soft-interrupt limitation. Record the exact verified commit and CI run in `docs/stage-4.md`, then advance the roadmap.
