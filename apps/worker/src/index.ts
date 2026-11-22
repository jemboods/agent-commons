import { DurableObject } from 'cloudflare:workers';

const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const PBKDF2_ITERATIONS = 600_000;
const SESSION_MS = 24 * 60 * 60 * 1000;
const MAX_BODY = 16 * 1024;
const ROOM_REQUESTS_PER_MINUTE = 120;
const MAX_SESSIONS_PER_PARTICIPANT = 5;
const REPLY_TARGET_TTL_MS = 15 * 60 * 1000;
const MAX_REPLY_TARGETS = 500;
const TYPING_WINDOW_MS = 2_000;
const ALLOWED_ORIGINS = new Set([
  'https://jemboods.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

type Mode = 'public' | 'private' | 'hybrid';
type Kind = 'human' | 'agent';
type Role = 'owner' | 'moderator' | 'human' | 'agent' | 'observer';
type ChatState = 'active' | 'paused' | 'interrupted';
type Room = {
  id: string; name: string; description: string; mode: Mode; maxParticipants: number;
  createdAt: string; expiresAt: string; accessCodeEnabled: boolean; accessCode?: { salt: string; hash: string };
  ownerKeyHash: string; state: 'active' | 'deleted'; chatState: ChatState; participants: Participant[];
  sessions: Session[]; invitations: Invitation[]; lockouts: Lockout[]; rate: { key: string; count: number; until: number }[];
  recentMessages: { id: string; expiresAt: number }[];
};
type Participant = {
  id: string; name: string; kind: Kind; role: Role; joinedAt: string; canInstruct: boolean; muted: boolean;
};
type Session = { digest: string; participantId: string; expiresAt: number };
type Invitation = { digest: string; role: Exclude<Role, 'owner' | 'moderator'>; name?: string; maxUses: number; uses: number; expiresAt: number };
type Lockout = { key: string; failures: number; until: number };
type SocketAttachment =
  | { state: 'pending'; deadline: number }
  | { state: 'authenticated'; participantId: string; sessionDigest: string }
  | { state: 'closed'; participantId?: string };
type Env = { ROOMS: DurableObjectNamespace<RoomDurableObject> };

function response(value: unknown, status = 200, extra: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { ...HEADERS, ...extra } });
}
function failure(code: string, status = 400, extra: HeadersInit = {}): Response { return response({ error: code }, status, extra); }
function randomBytes(n: number): Uint8Array { return crypto.getRandomValues(new Uint8Array(n)); }
function b64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return b64(new Uint8Array(bytes));
}
async function hashCode(code: string, salt: Uint8Array): Promise<string> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, material, 256);
  return b64(new Uint8Array(bits));
}
function token(): string { return b64(randomBytes(32)); }
function uuid(): string { return crypto.randomUUID().replaceAll('-', '').toLowerCase(); }
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function allowedKeys(input: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(input).every((key) => allowed.includes(key));
}
function validString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max;
}
function iso(ms: number): string { return new Date(ms).toISOString(); }
function publicRoom(room: Room) {
  return {
    id: room.id, name: room.name, description: room.description, mode: room.mode,
    maxParticipants: room.maxParticipants, createdAt: room.createdAt, expiresAt: room.expiresAt,
    accessCodeEnabled: room.accessCodeEnabled, chatState: room.chatState,
  };
}
function publicParticipant(participant: Participant) { return { ...participant }; }
function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return failure(error.code, error.status);
  console.error('Room request failed:', error instanceof Error ? error.name : 'unknown error');
  return failure('INTERNAL_ERROR', 500);
}
class HttpError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      if (request.method !== 'GET') return failure('METHOD_NOT_ALLOWED', 405, { Allow: 'GET' });
      return response({ service: 'agent-commons', status: 'ok', stage: 1 });
    }
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const originError = checkOrigin(request);
      if (originError) return originError;
      try {
        const data = await readJson(request);
        if (!isObject(data) || !allowedKeys(data, ['name', 'description', 'accessCode', 'ownerName', 'mode', 'maxParticipants', 'lifetimeHours'])) {
          return failure('INVALID_REQUEST');
        }
        if (!validString(data.name, 1, 80) || !validString(data.ownerName, 1, 60) || !validString(data.accessCode, 12, 128)) return failure('INVALID_REQUEST');
        if (data.description !== undefined && !validString(data.description, 0, 500)) return failure('INVALID_REQUEST');
        const mode = data.mode === undefined ? 'hybrid' : data.mode;
        const max = data.maxParticipants === undefined ? 20 : data.maxParticipants;
        const hours = data.lifetimeHours === undefined ? 24 : data.lifetimeHours;
        if (!['public', 'private', 'hybrid'].includes(String(mode)) || !Number.isInteger(max) || (max as number) < 2 || (max as number) > 100 || !Number.isFinite(hours) || (hours as number) <= 0 || (hours as number) > 168) return failure('INVALID_REQUEST');
        const id = `r_${uuid()}`;
        const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
        const result = await stub.fetch('https://room.internal/__create', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...data, id, mode, maxParticipants: max, lifetimeHours: hours }),
        });
        return new Response(result.body, { status: result.status, headers: result.headers });
      } catch (error) { return errorResponse(error); }
    }
    const match = url.pathname.match(/^\/api\/rooms\/(r_[a-f0-9]{32})(?:\/(.*))?$/);
    if (!match) return failure('NOT_FOUND', 404);
    const originError = checkOrigin(request);
    if (originError) return originError;
    const stub = env.ROOMS.get(env.ROOMS.idFromName(match[1]));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

function checkOrigin(request: Request): Response | null {
  const origin = request.headers.get('Origin');
  if (origin && !ALLOWED_ORIGINS.has(origin)) return failure('FORBIDDEN', 403);
  return null;
}
async function readJson(request: Request): Promise<unknown> {
  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError('INVALID_REQUEST', 400);
  const length = request.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BODY) throw new HttpError('INVALID_REQUEST', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError('INVALID_REQUEST', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new HttpError('INVALID_REQUEST', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { throw new HttpError('INVALID_REQUEST', 400); }
}

export class RoomDurableObject extends DurableObject<Env> {
  private queue: Promise<void> = Promise.resolve();
  private readonly sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS room_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  async fetch(request: Request): Promise<Response> {
    return this.exclusive(async () => {
      try {
        if (new URL(request.url).pathname === '/__create') return await this.create(request);
        const room = this.load();
        if (!room || room.state !== 'active') return failure('NOT_FOUND', 404);
        if (Date.now() >= Date.parse(room.expiresAt)) {
          await this.destroy();
          return failure('ROOM_EXPIRED', 410);
        }
        this.prune(room);
        await this.checkRate(request, room);
        const path = new URL(request.url).pathname;
        if (path === `/api/rooms/${room.id}/ws`) return this.upgrade(request);
        const member = await this.authenticate(request, room, path);
        if (request.method === 'GET' && path === `/api/rooms/${room.id}`) {
          if (!member) return failure('UNAUTHORIZED', 401);
          return response({ room: publicRoom(room), participants: room.participants.map(publicParticipant), self: publicParticipant(member) });
        }
        if (request.method === 'POST' && path === `/api/rooms/${room.id}/join`) return await this.join(request, room);
        if (request.method === 'POST' && path === `/api/rooms/${room.id}/owner-session`) return await this.ownerSession(request, room);
        if (!member) return failure('UNAUTHORIZED', 401);
        if (request.method === 'PATCH' && path === `/api/rooms/${room.id}`) return await this.updateRoom(request, room, member);
        if (request.method === 'PUT' && path === `/api/rooms/${room.id}/access-code`) return await this.updateCode(request, room, member);
        if (request.method === 'POST' && path === `/api/rooms/${room.id}/invitations`) return await this.invite(request, room, member);
        const participantMatch = path.match(new RegExp(`^/api/rooms/${room.id}/participants/([^/]+)$`));
        if (request.method === 'PATCH' && participantMatch) return await this.updateParticipant(request, room, member, participantMatch[1]);
        if (request.method === 'POST' && path === `/api/rooms/${room.id}/leave`) return this.leave(room, member);
        if (request.method === 'DELETE' && path === `/api/rooms/${room.id}`) {
          if (member.role !== 'owner') return failure('FORBIDDEN', 403);
          await this.destroy();
          return response({ ok: true });
        }
        return failure('NOT_FOUND', 404);
      } catch (error) { return errorResponse(error); }
      finally {
        const room = this.load();
        if (room) await this.scheduleSocketAlarm(room);
      }
    });
  }

  private upgrade(request: Request): Response {
    const url = new URL(request.url);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.search || url.username || url.password) return failure('INVALID_REQUEST');
    const originError = checkOrigin(request);
    if (originError) return originError;
    if (request.method !== 'GET') return failure('METHOD_NOT_ALLOWED', 405, { Allow: 'GET' });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return failure('UPGRADE_REQUIRED', 426);
    const sockets = this.ctx.getWebSockets().filter((socket) => this.attachment(socket).state !== 'closed');
    if (sockets.length >= 200 || sockets.filter((socket) => this.attachment(socket).state === 'pending').length >= 16) return failure('RATE_LIMITED', 429);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ state: 'pending', deadline: Date.now() + 10_000 } satisfies SocketAttachment);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.exclusive(async () => {
      const room = this.load();
      if (!room || room.state !== 'active' || Date.parse(room.expiresAt) <= Date.now()) { this.closeSocket(socket, 'UNAUTHORIZED'); return; }
      this.sweepSockets(room);
      const attachment = this.attachment(socket);
      if (attachment.state === 'closed') return;
      if (typeof message !== 'string' || new TextEncoder().encode(message).byteLength > 32 * 1024) { this.closeSocket(socket, 'INVALID_MESSAGE'); return; }
      let frame: unknown;
      try { frame = JSON.parse(message); } catch { frame = null; }
      if (attachment.state === 'authenticated') {
        if (isObject(frame) && frame.type === 'control') {
          this.sendControl(socket, room, attachment, frame);
          return;
        }
        if (isObject(frame) && frame.type === 'typing') {
          if (!allowedKeys(frame, ['v', 'type', 'payload']) || frame.v !== 1 || !isObject(frame.payload) || Object.keys(frame.payload).length) {
            this.closeSocket(socket, 'INVALID_MESSAGE'); return;
          }
          this.sendTyping(socket, room, attachment);
          return;
        }
        this.sendChat(socket, room, attachment, frame);
        return;
      }
      if (!isObject(frame) || !allowedKeys(frame, ['v', 'type', 'payload']) || frame.v !== 1 || frame.type !== 'join' || !isObject(frame.payload) || !allowedKeys(frame.payload, ['sessionToken']) || typeof frame.payload.sessionToken !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(frame.payload.sessionToken)) {
        this.closeSocket(socket, 'INVALID_MESSAGE'); return;
      }
      const hash = await digest(frame.payload.sessionToken);
      const session = room.sessions.find((entry) => entry.digest === hash && entry.expiresAt > Date.now());
      const member = session && room.participants.find((entry) => entry.id === session.participantId);
      if (!session || !member) { this.closeSocket(socket, 'UNAUTHORIZED'); return; }
      const alreadyOnline = this.hasActiveConnection(room, member.id);
      socket.serializeAttachment({ state: 'authenticated', participantId: member.id, sessionDigest: hash } satisfies SocketAttachment);
      await this.scheduleSocketAlarm(room);
      // Only server-validated membership reaches this outbound authorization boundary.
      if (this.attachment(socket).state !== 'authenticated') return;
      socket.send(JSON.stringify({ v: 1, id: `evt_${uuid()}`, room: room.id, type: 'welcome', ts: iso(Date.now()),
        payload: { room: publicRoom(room), self: publicParticipant(member),
          participants: room.participants.map((participant) => ({ ...publicParticipant(participant), online: this.hasActiveConnection(room, participant.id) })), liveOnly: true },
      }));
      if (!alreadyOnline) this.broadcastPresence(room, member.id, true, socket);
    });
  }

  private sendChat(socket: WebSocket, room: Room, auth: Extract<SocketAttachment, { state: 'authenticated' }>, frame: unknown): void {
    if (!isObject(frame) || !allowedKeys(frame, ['v', 'type', 'payload']) || frame.v !== 1 || frame.type !== 'message' || !isObject(frame.payload) || !allowedKeys(frame.payload, ['text', 'replyTo', 'mentions']) || !validString(frame.payload.text, 1, 32 * 1024)) {
      this.closeSocket(socket, 'INVALID_MESSAGE'); return;
    }
    const member = room.participants.find((entry) => entry.id === auth.participantId)!;
    if (member.role === 'observer') { this.socketError(socket, room, 'FORBIDDEN'); return; }
    if (member.muted) { this.socketError(socket, room, 'MUTED'); return; }
    if (room.chatState === 'paused' && member.role !== 'owner' && member.role !== 'moderator') { this.socketError(socket, room, 'ROOM_PAUSED'); return; }
    const now = Date.now();
    this.prune(room);
    const replyTo = frame.payload.replyTo;
    if (replyTo !== undefined && (typeof replyTo !== 'string' || !/^msg_[a-f0-9]{32}$/.test(replyTo) || !room.recentMessages.some((entry) => entry.id === replyTo))) {
      this.closeSocket(socket, 'INVALID_MESSAGE'); return;
    }
    const mentions = frame.payload.mentions;
    if (mentions !== undefined && (!Array.isArray(mentions) || mentions.length > 50 || !mentions.every((id) => typeof id === 'string' && room.participants.some((participant) => participant.id === id)))) {
      this.closeSocket(socket, 'INVALID_MESSAGE'); return;
    }
    const payload = {
      text: frame.payload.text,
      ...(replyTo === undefined ? {} : { replyTo }),
      ...(mentions === undefined ? {} : { mentions }),
    };
    const id = `msg_${uuid()}`;
    const event = JSON.stringify({ v: 1, id, room: room.id, type: 'message',
      from: { id: member.id, name: member.name, kind: member.kind }, ts: iso(now), payload,
    });
    if (new TextEncoder().encode(event).byteLength > 32 * 1024) { this.closeSocket(socket, 'INVALID_MESSAGE'); return; }
    this.prune(room);
    const key = `chat:${member.id}`;
    let budget = room.rate.find((entry) => entry.key === key);
    if (!budget) { budget = { key, count: 0, until: now + 2000 }; room.rate.push(budget); }
    if (budget.count >= (member.kind === 'agent' ? 1 : 5)) { this.socketError(socket, room, 'RATE_LIMITED'); return; }
    budget.count++;
    room.recentMessages.push({ id, expiresAt: now + REPLY_TARGET_TTL_MS });
    if (room.recentMessages.length > MAX_REPLY_TARGETS) room.recentMessages.splice(0, room.recentMessages.length - MAX_REPLY_TARGETS);
    this.save(room);
    this.sweepSockets(room);
    for (const target of this.ctx.getWebSockets()) {
      if (this.attachment(target).state === 'authenticated') target.send(event);
    }
  }

  // Ephemeral typing carries no content and is never persisted; one frame per window per participant.
  private sendTyping(socket: WebSocket, room: Room, auth: Extract<SocketAttachment, { state: 'authenticated' }>): void {
    const member = room.participants.find((entry) => entry.id === auth.participantId);
    if (!member || member.role === 'observer' || member.muted) return;
    if (room.chatState === 'paused' && member.role !== 'owner' && member.role !== 'moderator') return;
    const now = Date.now();
    this.prune(room);
    const key = `typing:${member.id}`;
    let budget = room.rate.find((entry) => entry.key === key);
    if (!budget) { budget = { key, count: 0, until: now + TYPING_WINDOW_MS }; room.rate.push(budget); }
    if (budget.count >= 1) return;
    budget.count++;
    this.save(room);
    const event = JSON.stringify({ v: 1, id: `evt_${uuid()}`, room: room.id, type: 'typing',
      from: { id: member.id, name: member.name, kind: member.kind }, ts: iso(now), payload: {},
    });
    this.sweepSockets(room);
    for (const target of this.ctx.getWebSockets()) {
      if (target !== socket && this.attachment(target).state === 'authenticated') target.send(event);
    }
  }

  // Room controls are re-authorized against the sender's current role on every frame.
  private sendControl(socket: WebSocket, room: Room, auth: Extract<SocketAttachment, { state: 'authenticated' }>, frame: unknown): void {
    if (!isObject(frame) || !allowedKeys(frame, ['v', 'type', 'payload']) || frame.v !== 1 || !isObject(frame.payload) || !allowedKeys(frame.payload, ['action', 'participantId'])) {
      this.closeSocket(socket, 'INVALID_MESSAGE'); return;
    }
    const actor = room.participants.find((entry) => entry.id === auth.participantId);
    if (!actor) return;
    const action = frame.payload.action;
    if (action === 'pause' || action === 'resume') {
      if (frame.payload.participantId !== undefined) { this.closeSocket(socket, 'INVALID_MESSAGE'); return; }
      if (actor.role !== 'owner') { this.socketError(socket, room, 'FORBIDDEN'); return; }
      const next: ChatState = action === 'pause' ? 'paused' : 'active';
      if (room.chatState === next) return;
      room.chatState = next;
      this.save(room);
      this.broadcastState(room);
      return;
    }
    if (action === 'mute' || action === 'unmute') {
      const targetId = frame.payload.participantId;
      if (typeof targetId !== 'string' || !/^p_[a-f0-9]{32}$/.test(targetId)) { this.closeSocket(socket, 'INVALID_MESSAGE'); return; }
      if (actor.role !== 'owner' && actor.role !== 'moderator') { this.socketError(socket, room, 'FORBIDDEN'); return; }
      const target = room.participants.find((entry) => entry.id === targetId);
      if (!target) { this.socketError(socket, room, 'INVALID_MESSAGE'); return; }
      if (target.id === actor.id || target.role === 'owner' || (actor.role === 'moderator' && target.role === 'moderator')) {
        this.socketError(socket, room, 'FORBIDDEN'); return;
      }
      const muted = action === 'mute';
      if (target.muted === muted) return;
      target.muted = muted;
      this.save(room);
      this.broadcastState(room);
      return;
    }
    this.closeSocket(socket, 'INVALID_MESSAGE');
  }

  private broadcastState(room: Room): void {
    const event = JSON.stringify({ v: 1, id: `evt_${uuid()}`, room: room.id, type: 'state', ts: iso(Date.now()),
      payload: { chatState: room.chatState, muted: room.participants.filter((entry) => entry.muted).map((entry) => entry.id) },
    });
    this.sweepSockets(room);
    for (const target of this.ctx.getWebSockets()) {
      if (this.attachment(target).state === 'authenticated') target.send(event);
    }
  }

  private socketError(socket: WebSocket, room: Room, code: string): void {
    socket.send(JSON.stringify({ v: 1, id: `evt_${uuid()}`, room: room.id, type: 'error', ts: iso(Date.now()), payload: { code } }));
  }

  private hasActiveConnection(room: Room, participantId: string): boolean {
    const now = Date.now();
    return this.ctx.getWebSockets().some((socket) => {
      const auth = this.attachment(socket);
      return auth.state === 'authenticated' && auth.participantId === participantId &&
        room.sessions.some((session) => session.digest === auth.sessionDigest && session.participantId === participantId && session.expiresAt > now) &&
        room.participants.some((participant) => participant.id === participantId);
    });
  }

  private broadcastPresence(room: Room, participantId: string, online: boolean, except?: WebSocket): void {
    const event = JSON.stringify({ v: 1, id: `evt_${uuid()}`, room: room.id, type: 'presence', ts: iso(Date.now()),
      payload: { participantId, online },
    });
    this.sweepSockets(room);
    for (const target of this.ctx.getWebSockets()) {
      if (target !== except && this.attachment(target).state === 'authenticated') target.send(event);
    }
  }

  private attachment(socket: WebSocket): SocketAttachment {
    return (socket.deserializeAttachment() as SocketAttachment | null) ?? { state: 'closed' };
  }
  private closeSocket(socket: WebSocket, reason: string): void {
    const prior = this.attachment(socket);
    socket.serializeAttachment({ state: 'closed', ...(prior.state === 'authenticated' ? { participantId: prior.participantId } : {}) } satisfies SocketAttachment);
    socket.close(1008, reason);
  }
  private sweepSockets(room: Room): void {
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      const auth = this.attachment(socket);
      if (auth.state === 'closed') continue;
      const valid = room.state === 'active' && Date.parse(room.expiresAt) > now && (auth.state === 'pending'
        ? auth.deadline > now
        : room.sessions.some((session) => session.digest === auth.sessionDigest && session.participantId === auth.participantId && session.expiresAt > now)
          && room.participants.some((member) => member.id === auth.participantId));
      if (!valid) this.closeSocket(socket, 'UNAUTHORIZED');
    }
  }
  private async scheduleSocketAlarm(room: Room): Promise<void> {
    this.sweepSockets(room);
    let deadline = Date.parse(room.expiresAt);
    for (const socket of this.ctx.getWebSockets()) {
      const auth = this.attachment(socket);
      if (auth.state === 'pending') deadline = Math.min(deadline, auth.deadline);
      if (auth.state === 'authenticated') {
        const session = room.sessions.find((item) => item.digest === auth.sessionDigest);
        if (session) deadline = Math.min(deadline, session.expiresAt);
      }
    }
    if (await this.ctx.storage.getAlarm() !== deadline) await this.ctx.storage.setAlarm(deadline);
  }

  webSocketClose(socket: WebSocket): void {
    const prior = this.attachment(socket);
    socket.serializeAttachment({ state: 'closed' } satisfies SocketAttachment);
    socket.close();
    if (prior.state !== 'authenticated') return;
    // Presence goes offline only when the participant's last live connection is gone.
    void this.exclusive(async () => {
      const room = this.load();
      if (!room || room.state !== 'active') return;
      if (!this.hasActiveConnection(room, prior.participantId)) this.broadcastPresence(room, prior.participantId, false);
    });
  }
  webSocketError(socket: WebSocket): void { this.closeSocket(socket, 'SOCKET_ERROR'); }

  async alarm(): Promise<void> {
    return this.exclusive(async () => {
      const room = this.load();
      if (!room || room.state !== 'active') { await this.destroy(); return; }
      const expiry = Date.parse(room.expiresAt);
      if (expiry > Date.now()) {
        await this.scheduleSocketAlarm(room);
        return;
      }
      await this.destroy();
    });
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action, action);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
  private load(): Room | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM room_state WHERE key='room'").toArray()[0];
    if (!row) return null;
    try {
      const room = JSON.parse(row.value) as Room;
      room.recentMessages ??= [];
      room.chatState ??= 'active';
      for (const participant of room.participants) participant.muted ??= false;
      return room;
    } catch { return null; }
  }
  private save(room: Room): void {
    this.sql.exec('INSERT INTO room_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'room', JSON.stringify(room));
    this.sweepSockets(room);
  }
  private async destroy(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) this.closeSocket(socket, 'UNAUTHORIZED');
    this.sql.exec('DELETE FROM room_state');
    await this.ctx.storage.deleteAlarm();
  }
  private prune(room: Room): void {
    const now = Date.now();
    room.recentMessages = (room.recentMessages ?? []).filter((entry) => entry.expiresAt > now).slice(-MAX_REPLY_TARGETS);
    room.sessions = room.sessions.filter((session) => session.expiresAt > now && room.participants.some((p) => p.id === session.participantId));
    room.invitations = room.invitations.filter((invite) => invite.expiresAt > now && invite.uses < invite.maxUses);
    room.lockouts = room.lockouts.filter((lock) => lock.until > now || lock.failures < 5);
    room.rate = room.rate.filter((entry) => entry.until > now);
    if (room.lockouts.length > 500) room.lockouts = room.lockouts.slice(-500);
    if (room.rate.length > 1000) room.rate = room.rate.slice(-1000);
  }
  private async create(request: Request): Promise<Response> {
    if (this.load()) return failure('CONFLICT', 409);
    const data = await readJson(request);
    if (!isObject(data) || !validString(data.name, 1, 80) || !validString(data.ownerName, 1, 60) || !validString(data.accessCode, 12, 128)) return failure('INVALID_REQUEST');
    const now = Date.now();
    const expiresAt = now + Number(data.lifetimeHours) * 3_600_000;
    const ownerKey = token();
    const participant: Participant = { id: `p_${uuid()}`, name: data.ownerName, kind: 'human', role: 'owner', joinedAt: iso(now), canInstruct: true, muted: false };
    const salt = randomBytes(16);
    const room: Room = {
      id: String(data.id), name: String(data.name), description: typeof data.description === 'string' ? data.description : '',
      mode: data.mode as Mode, maxParticipants: Number(data.maxParticipants), createdAt: iso(now), expiresAt: iso(expiresAt),
      accessCodeEnabled: true, accessCode: { salt: b64(salt), hash: await hashCode(data.accessCode, salt) },
      ownerKeyHash: await digest(ownerKey), state: 'active', chatState: 'active', participants: [participant], sessions: [], invitations: [], lockouts: [], rate: [], recentMessages: [],
    };
    const sessionToken = await this.createSession(room, participant);
    this.save(room);
    await this.ctx.storage.setAlarm(expiresAt);
    return response({ room: publicRoom(room), participant, sessionToken, sessionExpiresAt: iso(Math.min(now + SESSION_MS, expiresAt)), ownerKey }, 201);
  }
  private async createSession(room: Room, participant: Participant): Promise<string> {
    const sessionToken = token();
    room.sessions.push({ digest: await digest(sessionToken), participantId: participant.id, expiresAt: Math.min(Date.now() + SESSION_MS, Date.parse(room.expiresAt)) });
    const sessionsForParticipant = room.sessions.filter((session) => session.participantId === participant.id);
    while (sessionsForParticipant.length > MAX_SESSIONS_PER_PARTICIPANT) {
      const oldest = sessionsForParticipant.shift();
      if (oldest) room.sessions.splice(room.sessions.indexOf(oldest), 1);
    }
    return sessionToken;
  }
  private async authenticate(request: Request, room: Room, path: string): Promise<Participant | null> {
    if (path.endsWith('/join') || path.endsWith('/owner-session')) return null;
    const header = request.headers.get('Authorization') || '';
    const match = header.match(/^Bearer ([A-Za-z0-9_-]{40,60})$/);
    if (!match) return null;
    const hash = await digest(match[1]);
    const session = room.sessions.find((item) => item.digest === hash && item.expiresAt > Date.now());
    return session ? room.participants.find((p) => p.id === session.participantId) || null : null;
  }
  private async ipKey(request: Request): Promise<string> {
    const forwarded = request.headers.get('CF-Connecting-IP');
    const address = forwarded || (new URL(request.url).hostname === 'localhost' || new URL(request.url).hostname === '127.0.0.1' ? 'loopback' : 'unknown');
    return digest(address);
  }
  private async checkRate(request: Request, room: Room): Promise<void> {
    const key = await this.ipKey(request);
    const now = Date.now();
    let entry = room.rate.find((item) => item.key === key && item.until > now);
    if (!entry) {
      entry = { key, count: 0, until: now + 60_000 };
      room.rate.push(entry);
    }
    if (entry.count >= ROOM_REQUESTS_PER_MINUTE) {
      this.save(room);
      throw new HttpError('RATE_LIMITED', 429);
    }
    entry.count++;
    this.save(room);
  }
  private async checkLockout(request: Request, room: Room): Promise<string> {
    const key = await this.ipKey(request);
    const lock = room.lockouts.find((entry) => entry.key === key);
    if (lock && lock.until > Date.now() && lock.failures >= 5) throw new HttpError('RATE_LIMITED', 429);
    return key;
  }
  private async failedCredential(room: Room, key: string): Promise<never> {
    let lock = room.lockouts.find((entry) => entry.key === key);
    if (!lock) { lock = { key, failures: 0, until: 0 }; room.lockouts.push(lock); }
    if (lock.failures >= 5 && lock.until <= Date.now()) {
      lock.failures = 0;
      lock.until = 0;
    }
    lock.failures++;
    if (lock.failures >= 5) lock.until = Date.now() + 15 * 60_000;
    this.save(room);
    if (lock.failures >= 5) throw new HttpError('RATE_LIMITED', 429);
    throw new HttpError('UNAUTHORIZED', 401);
  }
  private async join(request: Request, room: Room): Promise<Response> {
    const data = await readJson(request);
    if (!isObject(data) || !allowedKeys(data, ['name', 'kind', 'accessCode', 'invitationToken']) || !validString(data.name, 1, 60) || !['human', 'agent'].includes(String(data.kind))) return failure('INVALID_REQUEST');
    if ((typeof data.accessCode === 'string') === (typeof data.invitationToken === 'string')) return failure('INVALID_REQUEST');
    if (data.accessCode !== undefined && !validString(data.accessCode, 1, 128)) return failure('INVALID_REQUEST');
    if (data.invitationToken !== undefined && !validString(data.invitationToken, 40, 60)) return failure('INVALID_REQUEST');
    const key = await this.checkLockout(request, room);
    let role: Role;
    if (typeof data.invitationToken === 'string') {
      const inviteHash = await digest(data.invitationToken);
      const invitation = room.invitations.find((entry) => entry.digest === inviteHash && entry.expiresAt > Date.now() && entry.uses < entry.maxUses);
      if (!invitation || (invitation.name && invitation.name !== data.name) || (invitation.role !== 'observer' && invitation.role !== data.kind)) return await this.failedCredential(room, key);
      role = invitation.role;
      invitation.uses++;
    } else {
      if (room.mode === 'private' || !room.accessCodeEnabled || !room.accessCode) return await this.failedCredential(room, key);
      const candidate = await hashCode(String(data.accessCode), Uint8Array.from(atob(room.accessCode.salt.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0)));
      if (candidate !== room.accessCode.hash) return await this.failedCredential(room, key);
      role = data.kind as Kind;
    }
    if (room.participants.length >= room.maxParticipants) return failure('ROOM_FULL', 409);
    const participant: Participant = { id: `p_${uuid()}`, name: String(data.name), kind: data.kind as Kind, role, joinedAt: iso(Date.now()), canInstruct: false, muted: false };
    room.participants.push(participant);
    const sessionToken = await this.createSession(room, participant);
    room.lockouts = room.lockouts.filter((item) => item.key !== key);
    this.save(room);
    return response({ room: publicRoom(room), participant, sessionToken, sessionExpiresAt: iso(Math.min(Date.now() + SESSION_MS, Date.parse(room.expiresAt))) });
  }
  private async ownerSession(request: Request, room: Room): Promise<Response> {
    const data = await readJson(request);
    if (!isObject(data) || !allowedKeys(data, ['ownerKey']) || !validString(data.ownerKey, 40, 60)) return failure('INVALID_REQUEST');
    const key = await this.checkLockout(request, room);
    if (await digest(data.ownerKey) !== room.ownerKeyHash) return await this.failedCredential(room, key);
    const owner = room.participants.find((participant) => participant.role === 'owner');
    if (!owner) return failure('NOT_FOUND', 404);
    const sessionToken = await this.createSession(room, owner);
    room.lockouts = room.lockouts.filter((item) => item.key !== key);
    this.save(room);
    return response({ room: publicRoom(room), participant: owner, sessionToken, sessionExpiresAt: iso(Math.min(Date.now() + SESSION_MS, Date.parse(room.expiresAt))) });
  }
  private owner(room: Room, participant: Participant): boolean { return participant.role === 'owner'; }
  private async updateRoom(request: Request, room: Room, member: Participant): Promise<Response> {
    if (!this.owner(room, member)) return failure('FORBIDDEN', 403);
    const data = await readJson(request);
    if (!isObject(data) || !allowedKeys(data, ['name', 'description', 'mode', 'maxParticipants', 'expiresAt']) || !Object.keys(data).length) return failure('INVALID_REQUEST');
    if (data.name !== undefined) { if (!validString(data.name, 1, 80)) return failure('INVALID_REQUEST'); room.name = data.name; }
    if (data.description !== undefined) { if (!validString(data.description, 0, 500)) return failure('INVALID_REQUEST'); room.description = data.description; }
    if (data.mode !== undefined) { if (!['public', 'private', 'hybrid'].includes(String(data.mode))) return failure('INVALID_REQUEST'); room.mode = data.mode as Mode; }
    if (data.maxParticipants !== undefined) { if (!Number.isInteger(data.maxParticipants) || (data.maxParticipants as number) < room.participants.length || (data.maxParticipants as number) > 100) return failure('INVALID_REQUEST'); room.maxParticipants = data.maxParticipants as number; }
    if (data.expiresAt !== undefined) {
      const expiry = Date.parse(String(data.expiresAt));
      if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 168 * 3_600_000) return failure('INVALID_REQUEST');
      room.expiresAt = iso(expiry);
      room.sessions = room.sessions.map((session) => ({ ...session, expiresAt: Math.min(session.expiresAt, expiry) }));
      await this.ctx.storage.setAlarm(expiry);
    }
    this.save(room);
    return response({ room: publicRoom(room) });
  }
  private async updateCode(request: Request, room: Room, member: Participant): Promise<Response> {
    if (!this.owner(room, member)) return failure('FORBIDDEN', 403);
    const data = await readJson(request);
    if (!isObject(data) || !allowedKeys(data, ['accessCode']) || !(data.accessCode === null || validString(data.accessCode, 12, 128))) return failure('INVALID_REQUEST');
    if (data.accessCode === null) { room.accessCodeEnabled = false; delete room.accessCode; }
    else { const salt = randomBytes(16); room.accessCodeEnabled = true; room.accessCode = { salt: b64(salt), hash: await hashCode(data.accessCode as string, salt) }; }
    this.save(room);
    return response({ ok: true });
  }
  private async invite(request: Request, room: Room, member: Participant): Promise<Response> {
    if (!this.owner(room, member)) return failure('FORBIDDEN', 403);
    const data = await readJson(request);
    if (!isObject(data) || !allowedKeys(data, ['role', 'name', 'maxUses', 'expiresInSeconds']) || !['human', 'agent', 'observer'].includes(String(data.role))) return failure('INVALID_REQUEST');
    if (data.name !== undefined && !validString(data.name, 1, 60)) return failure('INVALID_REQUEST');
    const maxUses = data.maxUses === undefined ? 1 : data.maxUses;
    const expirySeconds = data.expiresInSeconds === undefined ? 3600 : data.expiresInSeconds;
    if (!Number.isInteger(maxUses) || (maxUses as number) < 1 || (maxUses as number) > 100 || !Number.isInteger(expirySeconds) || (expirySeconds as number) < 1 || (expirySeconds as number) > 86400) return failure('INVALID_REQUEST');
    if (room.invitations.length >= 1000) return failure('RATE_LIMITED', 429);
    const invitationToken = token();
    const expiresAt = Math.min(Date.now() + (expirySeconds as number) * 1000, Date.parse(room.expiresAt));
    const invitation: Invitation = { digest: await digest(invitationToken), role: data.role as Invitation['role'], ...(data.name ? { name: data.name as string } : {}), maxUses: maxUses as number, uses: 0, expiresAt };
    room.invitations.push(invitation);
    this.save(room);
    return response({ invitationToken, expiresAt: iso(expiresAt), maxUses }, 201);
  }
  private async updateParticipant(request: Request, room: Room, member: Participant, id: string): Promise<Response> {
    if (!this.owner(room, member)) return failure('FORBIDDEN', 403);
    const participant = room.participants.find((entry) => entry.id === id);
    if (!participant) return failure('NOT_FOUND', 404);
    if (participant.role === 'owner') return failure('FORBIDDEN', 403);
    const data = await readJson(request);
    if (!isObject(data) || !allowedKeys(data, ['role', 'canInstruct']) || !['moderator', 'human', 'agent', 'observer'].includes(String(data.role))) return failure('INVALID_REQUEST');
    if (data.canInstruct !== undefined && typeof data.canInstruct !== 'boolean') return failure('INVALID_REQUEST');
    const role = data.role as Exclude<Role, 'owner'>;
    if (participant.kind === 'agent' && ['human', 'moderator'].includes(role)) return failure('INVALID_REQUEST');
    if (participant.kind === 'human' && role === 'agent') return failure('INVALID_REQUEST');
    if (role === 'moderator' && participant.kind !== 'human') return failure('INVALID_REQUEST');
    participant.role = role;
    participant.canInstruct = role === 'moderator' && data.canInstruct === true;
    this.save(room);
    return response({ participant: publicParticipant(participant) });
  }
  private leave(room: Room, member: Participant): Response {
    room.sessions = room.sessions.filter((session) => session.participantId !== member.id);
    if (member.role !== 'owner') {
      room.participants = room.participants.filter((participant) => participant.id !== member.id);
    }
    this.save(room);
    return response({ ok: true });
  }
}
