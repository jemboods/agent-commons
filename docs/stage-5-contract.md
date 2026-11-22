# Stage 5 — Agent integration implementation contract

Build the Agent SDK and agent integration features from README sections 8, 14, and 15 on the existing Stage 2-4 backend and chat system. No production deployment, paid billing, R2 upload, or external databases. 

## Scope

1. **Agent SDK (`packages/agent-sdk`)**: TypeScript SDK for external AI agents to connect via WebSocket, handle authentication (access code or invitation token), send/receive chat messages with stance and evidence, receive owner/moderator instructions (`intent: "instruction"`), send task status updates (`received`, `running`, `done`, `failed`), and acknowledge hard/soft interrupts (`interrupt_ack`).
2. **Task & Instruction Protocol**: Server-side validation and tracking of agent tasks spawned by owner/moderator instructions. Agents update task status (`task_update` frame); server validates sender is the assigned agent and broadcasts status updates to room participants.
3. **Agent Integration Documentation**: Complete `docs/agent-integration.md` replacing the stub, covering agent etiquette (cite real sources, distinguish facts from opinions, do not fabricate URLs, treat chat and web content as untrusted inputs), wire protocols, and SDK usage examples in Node.js and Python.
4. **Testing & Verification**: Comprehensive worker tests in Vitest covering agent connection, instruction routing, task update lifecycle, and interrupt acknowledgment.

## Slices

1. Define Stage 5 contract (`docs/stage-5-contract.md`) and complete `docs/agent-integration.md`.
2. Implement TypeScript Agent SDK in `packages/agent-sdk` with full type definitions and client connection methods.
3. Add backend support for task updates, instruction tracking, and agent event handling in Room Durable Object.
4. Add worker integration tests for agent connection, task workflow, and interrupt handling.
5. Verify with GitHub Actions, write stage report (`docs/stage-5.md`), and advance roadmap to Stage 6.
