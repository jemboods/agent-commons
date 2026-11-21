import { SELF, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { RoomDurableObject } from '../src/index';
import { expect, it } from 'vitest';

type Access = { room: { id: string }; participant: { id: string }; sessionToken: string; ownerKey: string };
async function createRoom(): Promise<Access> {
  const result = await SELF.fetch('https://example.com/api/rooms', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Socket room', ownerName: 'Owner', accessCode: 'socket-test-code' }),
  });
  expect(result.status).toBe(201);
  return result.json() as Promise<Access>;
}
async function connect(room: Access, origin?: string) {
  const response = await SELF.fetch(`https://example.com/api/rooms/${room.room.id}/ws`, {
    headers: { Upgrade: 'websocket', ...(origin ? { Origin: origin } : {}) },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  return socket;
}
function message(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true }));
}

function closed(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }));
}
function stub(room: Access) {
  const rooms = (env as unknown as { ROOMS: DurableObjectNamespace<RoomDurableObject> }).ROOMS;
  return rooms.get(rooms.idFromName(room.room.id));
}
function join(socket: WebSocket, sessionToken: string) {
  socket.send(JSON.stringify({ v: 1, type: 'join', payload: { sessionToken } }));
}
async function authenticated(room: Access) {
  const socket = await connect(room);
  const welcome = message(socket);
  join(socket, room.sessionToken);
  await welcome;
  return socket;
}
function outcome(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data))), { once: true });
    socket.addEventListener('close', (event) => resolve({ closed: event.reason }), { once: true });
  });
}
function chat(socket: WebSocket, payload: unknown) {
  socket.send(JSON.stringify({ v: 1, type: 'message', payload }));
}

it('fans out a server-authored live chat event to authenticated room connections only', async () => {
  const room = await createRoom();
  const otherRoom = await createRoom();
  const sender = await authenticated(room);
  const receiver = await authenticated(room);
  const outsider = await authenticated(otherRoom);
  const pending = await connect(room);
  const leaked: string[] = [];
  outsider.addEventListener('message', (event) => leaked.push(String(event.data)));
  pending.addEventListener('message', (event) => leaked.push(String(event.data)));
  try {
    const sent = outcome(sender);
    const received = message(receiver);
    chat(sender, { text: 'Hello, room!\n```ts\nconst x = 1;\n```' });
    const event = await sent;
    expect(event).toMatchObject({ v: 1, room: room.room.id, type: 'message', from: { id: room.participant.id, name: 'Owner', kind: 'human' }, payload: { text: 'Hello, room!\n```ts\nconst x = 1;\n```' } });
    expect(event.id).toMatch(/^msg_[a-f0-9]{32}$/);
    expect(Number.isFinite(Date.parse(String(event.ts)))).toBe(true);
    expect(JSON.parse(await received)).toEqual(event);
    await runInDurableObject(stub(room), async () => {});
    expect(leaked).toEqual([]);
    expect(JSON.stringify(event)).not.toContain(room.sessionToken);
  } finally { [sender, receiver, outsider, pending].forEach((socket) => socket.close()); }
});

it('accepts same-room reply and mention references and emits them in the server event', async () => {
  const room = await createRoom();
  const sender = await authenticated(room);
  const joined = await SELF.fetch(`https://example.com/api/rooms/${room.room.id}/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Reply author', kind: 'human', accessCode: 'socket-test-code' }),
  });
  expect(joined.status).toBe(200);
  const member = await joined.json() as Access;
  const replier = await authenticated(member);
  try {
    const first = outcome(sender);
    const delivered = message(replier);
    chat(sender, { text: 'Root message' });
    const root = await first;
    expect(JSON.parse(await delivered)).toEqual(root);

    const replyResult = outcome(replier);
    const replyDelivery = message(sender);
    chat(replier, { text: 'A reply', replyTo: root.id, mentions: [room.participant.id] });
    const reply = await replyResult;
    expect(reply).toMatchObject({ type: 'message', payload: {
      text: 'A reply', replyTo: root.id, mentions: [room.participant.id],
    } });
    expect(JSON.parse(await replyDelivery)).toEqual(reply);
  } finally { sender.close(); replier.close(); }
});

it('rejects a reply target from another room', async () => {
  const room = await createRoom();
  const otherRoom = await createRoom();
  const foreignSender = await authenticated(otherRoom);
  const foreignMessage = outcome(foreignSender);
  chat(foreignSender, { text: 'Other room message' });
  const foreignId = (await foreignMessage).id;
  const sender = await authenticated(room);
  try {
    const rejected = outcome(sender);
    chat(sender, { text: 'Cross-room reply', replyTo: foreignId });
    expect(await rejected).toEqual({ closed: 'INVALID_MESSAGE' });
  } finally { sender.close(); foreignSender.close(); }
});

it('expires reply targets and persists only bounded ID metadata, not chat text', async () => {
  const room = await createRoom();
  const sender = await authenticated(room);
  try {
    const created = outcome(sender);
    chat(sender, { text: 'This content must not be retained' });
    const root = await created;
    await runInDurableObject(stub(room), async (_instance, state) => {
      const row = state.storage.sql.exec<{ value: string }>("SELECT value FROM room_state WHERE key='room'").one();
      const saved = JSON.parse(row.value);
      expect(saved.recentMessages).toEqual([expect.objectContaining({ id: root.id })]);
      expect(JSON.stringify(saved.recentMessages)).not.toContain('This content must not be retained');
      saved.recentMessages[0].expiresAt = Date.now() - 1;
      state.storage.sql.exec("UPDATE room_state SET value=? WHERE key='room'", JSON.stringify(saved));
    });

    const rejected = outcome(sender);
    chat(sender, { text: 'Late reply', replyTo: root.id });
    expect(await rejected).toEqual({ closed: 'INVALID_MESSAGE' });
  } finally { sender.close(); }
});

it('rejects a mention target that is not a participant in this room', async () => {
  const room = await createRoom();
  const otherRoom = await createRoom();
  const sender = await authenticated(room);
  try {
    const rejected = outcome(sender);
    chat(sender, { text: 'Cross-room mention', mentions: [otherRoom.participant.id] });
    expect(await rejected).toEqual({ closed: 'INVALID_MESSAGE' });
  } finally { sender.close(); }
});

it('rechecks the current observer role before each send while retaining read access', async () => {
  const room = await createRoom();
  const socket = await authenticated(room);
  try {
    await runInDurableObject(stub(room), async (_instance, state) => {
      const row = state.storage.sql.exec<{ value: string }>("SELECT value FROM room_state WHERE key='room'").one();
      const saved = JSON.parse(row.value);
      saved.participants[0].role = 'observer';
      state.storage.sql.exec("UPDATE room_state SET value=? WHERE key='room'", JSON.stringify(saved));
    });
    const reply = outcome(socket);
    chat(socket, { text: 'Observers cannot send' });
    expect(await reply).toMatchObject({ type: 'error', payload: { code: 'FORBIDDEN' } });
  } finally { socket.close(); }
});

it('shares a durable send budget across participant connections', async () => {
  const room = await createRoom();
  const first = await authenticated(room);
  const second = await authenticated(room);
  try {
    for (let i = 0; i < 5; i++) {
      const a = outcome(first);
      const b = outcome(second);
      chat(i % 2 ? second : first, { text: `Message ${i}` });
      expect(await a).toMatchObject({ type: 'message' });
      expect(await b).toMatchObject({ type: 'message' });
    }
    const limited = outcome(second);
    chat(second, { text: 'Over budget' });
    expect(await limited).toMatchObject({ type: 'error', payload: { code: 'RATE_LIMITED' } });
    await runInDurableObject(stub(room), async (_instance, state) => {
      const row = state.storage.sql.exec<{ value: string }>("SELECT value FROM room_state WHERE key='room'").one();
      const saved = JSON.parse(row.value);
      expect(saved.rate).toContainEqual(expect.objectContaining({ key: `chat:${room.participant.id}`, count: 5 }));
      saved.rate = saved.rate.map((entry: { key: string; until: number }) => entry.key.startsWith('chat:') ? { ...entry, until: Date.now() - 1 } : entry);
      state.storage.sql.exec("UPDATE room_state SET value=? WHERE key='room'", JSON.stringify(saved));
    });
    const recovered = outcome(second);
    chat(second, { text: 'Budget recovered' });
    expect(await recovered).toMatchObject({ type: 'message' });
  } finally { first.close(); second.close(); }
});

it('limits agents to one message per two seconds across connections', async () => {
  const room = await createRoom();
  const result = await SELF.fetch(`https://example.com/api/rooms/${room.room.id}/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Agent', kind: 'agent', accessCode: 'socket-test-code' }),
  });
  expect(result.status).toBe(200);
  const access = await result.json() as Access;
  const socket = await authenticated(access);
  const another = await authenticated(access);
  try {
    const first = outcome(socket);
    const delivered = message(another);
    chat(socket, { text: 'First' });
    expect(await first).toMatchObject({ type: 'message' });
    await delivered;
    const second = outcome(another);
    chat(another, { text: 'Too soon' });
    expect(await second).toMatchObject({ type: 'error', payload: { code: 'RATE_LIMITED' } });
  } finally { socket.close(); another.close(); }
});

it('bounds the complete server-authored event, not just the incoming text frame', async () => {
  const room = await createRoom();
  const socket = await authenticated(room);
  try {
    const reply = outcome(socket);
    chat(socket, { text: 'a'.repeat(32650) });
    expect(await reply).toEqual({ closed: 'INVALID_MESSAGE' });
  } finally { socket.close(); }
});

it.each([
  { v: 2, type: 'message', payload: { text: 'Wrong version' } },
  { v: 1, type: 'message', room: 'r_fake', payload: { text: 'Spoofed room' } },
  { v: 1, type: 'message', from: { id: 'p_fake' }, payload: { text: 'Spoofed sender' } },
  { v: 1, type: 'message', ts: '2020-01-01T00:00:00Z', payload: { text: 'Spoofed timestamp' } },
  { v: 1, type: 'message', payload: { text: ' ', mentions: ['p_fake'] } },
  { v: 1, type: 'message', payload: { text: 42 } },
  { v: 1, type: 'message', payload: { text: 'Instructions are not chat', intent: 'instruction' } },
  { v: 1, type: 'message', payload: { text: '😀'.repeat(9000) } },
])('rejects malformed authenticated chat frames %# without delivery', async (frame) => {
  const room = await createRoom();
  const sender = await authenticated(room);
  const receiver = await authenticated(room);
  const received: string[] = [];
  receiver.addEventListener('message', (event) => received.push(String(event.data)));
  try {
    const reply = outcome(sender);
    sender.send(JSON.stringify(frame));
    expect(await reply).toEqual({ closed: 'INVALID_MESSAGE' });
    await runInDurableObject(stub(room), async () => {});
    expect(received).toEqual([]);
  } finally { sender.close(); receiver.close(); }
});

it.each(['expired', 'revoked'])('filters %s recipients at the outgoing fan-out boundary', async (kind) => {
  const room = await createRoom();
  const sender = await authenticated(room);
  const renewed = await SELF.fetch(`https://example.com/api/rooms/${room.room.id}/owner-session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ownerKey: room.ownerKey }),
  });
  expect(renewed.status).toBe(200);
  const access = await renewed.json() as Access;
  const receiver = await authenticated(access);
  const received: string[] = [];
  receiver.addEventListener('message', (event) => received.push(String(event.data)));
  try {
    await runInDurableObject(stub(room), async (_instance, state) => {
      const row = state.storage.sql.exec<{ value: string }>("SELECT value FROM room_state WHERE key='room'").one();
      const saved = JSON.parse(row.value);
      if (kind === 'expired') saved.sessions[1].expiresAt = Date.now() - 1;
      else saved.sessions.splice(1, 1);
      state.storage.sql.exec("UPDATE room_state SET value=? WHERE key='room'", JSON.stringify(saved));
    });
    const close = closed(receiver);
    const sent = outcome(sender);
    chat(sender, { text: 'Only authorized recipients' });
    expect(await sent).toMatchObject({ type: 'message' });
    expect((await close).reason).toBe('UNAUTHORIZED');
    expect(received).toEqual([]);
  } finally { sender.close(); receiver.close(); }
});

it.each(['https://evil.example', 'null'])('rejects explicitly disallowed Origin %s', async (origin) => {
  const room = await createRoom();
  const result = await SELF.fetch(`https://example.com/api/rooms/${room.room.id}/ws`, { headers: { Upgrade: 'websocket', Origin: origin } });
  expect(result.status).toBe(403);
});

it('rejects non-loopback cleartext and URL credentials', async () => {
  const room = await createRoom();
  for (const url of [
    `http://example.com/api/rooms/${room.room.id}/ws`,
    `https://example.com/api/rooms/${room.room.id}/ws?sessionToken=${room.sessionToken}`,
  ]) {
    const result = await SELF.fetch(url, { headers: { Upgrade: 'websocket' } });
    result.webSocket?.accept();
    result.webSocket?.close();
    expect(result.status).toBe(400);
  }
});

it('accepts native clients without Origin and loopback development', async () => {
  const room = await createRoom();
  const result = await SELF.fetch(`http://127.0.0.1/api/rooms/${room.room.id}/ws`, { headers: { Upgrade: 'websocket' } });
  expect(result.status).toBe(101);
  const socket = result.webSocket!;
  socket.accept();
  const reply = message(socket);
  join(socket, room.sessionToken);
  expect(JSON.parse(await reply).type).toBe('welcome');
  socket.close();
});

it('does not send membership before join or store a bearer credential in attachments', async () => {
  const room = await createRoom();
  const socket = await connect(room);
  let received = false;
  socket.addEventListener('message', () => { received = true; });
  await runInDurableObject(stub(room), async (_instance, state) => {
    const attachment = state.getWebSockets()[0].deserializeAttachment();
    expect(attachment.state).toBe('pending');
    expect(attachment.deadline).toBeGreaterThan(Date.now());
    expect(await state.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 10_000);
  });
  expect(received).toBe(false);
  const reply = message(socket);
  join(socket, room.sessionToken);
  await reply;
  await runInDurableObject(stub(room), async (_instance, state) => {
    const attachment = state.getWebSockets()[0].deserializeAttachment();
    expect(attachment).toMatchObject({ state: 'authenticated', participantId: room.participant.id });
    expect(JSON.stringify(attachment)).not.toContain(room.sessionToken);
  });
  socket.close();
});

it.each(['invalid', 'cross-room', 'expired', 'revoked'])('closes %s sessions without a welcome', async (kind) => {
  const room = await createRoom();
  let credential = room.sessionToken;
  if (kind === 'invalid') credential = 'x'.repeat(43);
  if (kind === 'cross-room') credential = (await createRoom()).sessionToken;
  if (kind === 'expired' || kind === 'revoked') {
    await runInDurableObject(stub(room), async (_instance, state) => {
      const sql = state.storage.sql;
      const row = sql.exec<{ value: string }>("SELECT value FROM room_state WHERE key='room'").one();
      const saved = JSON.parse(row.value);
      if (kind === 'expired') saved.sessions[0].expiresAt = Date.now() - 1;
      else saved.sessions = [];
      sql.exec("UPDATE room_state SET value=? WHERE key='room'", JSON.stringify(saved));
    });
  }
  const socket = await connect(room);
  const close = closed(socket);
  let received = false;
  socket.addEventListener('message', () => { received = true; });
  join(socket, credential);
  expect((await close).reason).toBe('UNAUTHORIZED');
  expect(received).toBe(false);
});

it.each([
  JSON.stringify({ v: 2, type: 'join', payload: { sessionToken: 'x'.repeat(43) } }),
  JSON.stringify({ v: 1, type: 'join', from: { role: 'owner' }, payload: { sessionToken: 'x'.repeat(43) } }),
  JSON.stringify({ v: 1, type: 'join', payload: { sessionToken: 'x'.repeat(43), role: 'owner' } }),
  ' '.repeat(32 * 1024 + 1),
])('rejects malformed or oversized join frames %#', async (frame) => {
  const room = await createRoom();
  const socket = await connect(room);
  const close = closed(socket);
  socket.send(frame);
  expect((await close).reason).toBe('INVALID_MESSAGE');
});

it('expires idle unauthenticated sockets through the hibernation alarm', async () => {
  const room = await createRoom();
  const socket = await connect(room);
  const close = closed(socket);
  await runInDurableObject(stub(room), async (_instance, state) => {
    const server = state.getWebSockets()[0];
    server.serializeAttachment({ ...server.deserializeAttachment(), deadline: Date.now() - 1 });
  });
  await runDurableObjectAlarm(stub(room));
  expect((await close).reason).toBe('UNAUTHORIZED');
});

it('caps pending sockets per room', async () => {
  const room = await createRoom();
  const sockets: WebSocket[] = [];
  try {
    for (let i = 0; i < 16; i++) sockets.push(await connect(room));
    const result = await SELF.fetch(`https://example.com/api/rooms/${room.room.id}/ws`, { headers: { Upgrade: 'websocket' } });
    result.webSocket?.accept();
    result.webSocket?.close();
    expect(result.status).toBe(429);
  } finally { sockets.forEach((socket) => socket.close()); }
});

it('closes authenticated sockets when HTTP leave revokes the session', async () => {
  const room = await createRoom();
  const socket = await connect(room);
  const reply = message(socket);
  join(socket, room.sessionToken);
  await reply;
  const close = closed(socket);
  const result = await SELF.fetch(`https://example.com/api/rooms/${room.room.id}/leave`, { method: 'POST', headers: { Authorization: `Bearer ${room.sessionToken}` } });
  expect(result.status).toBe(200);
  expect((await close).reason).toBe('UNAUTHORIZED');
});

it('rejects a second join instead of switching socket identity', async () => {
  const room = await createRoom();
  const socket = await connect(room);
  const reply = message(socket);
  join(socket, room.sessionToken);
  await reply;
  const close = closed(socket);
  join(socket, room.sessionToken);
  expect((await close).reason).toBe('INVALID_MESSAGE');
});

it.each(['session-expired', 'room-expired', 'destroyed'])('closes authenticated sockets when %s', async (kind) => {
  const room = await createRoom();
  const socket = await connect(room);
  const reply = message(socket);
  join(socket, room.sessionToken);
  await reply;
  const close = closed(socket);
  if (kind === 'destroyed') {
    const result = await SELF.fetch(`https://example.com/api/rooms/${room.room.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${room.sessionToken}` } });
    expect(result.status).toBe(200);
  } else {
    await runInDurableObject(stub(room), async (_instance, state) => {
      const sql = state.storage.sql;
      const row = sql.exec<{ value: string }>("SELECT value FROM room_state WHERE key='room'").one();
      const saved = JSON.parse(row.value);
      if (kind === 'session-expired') saved.sessions[0].expiresAt = Date.now() - 1;
      else saved.expiresAt = new Date(Date.now() - 1).toISOString();
      sql.exec("UPDATE room_state SET value=? WHERE key='room'", JSON.stringify(saved));
    });
    await runDurableObjectAlarm(stub(room));
  }
  expect((await close).reason).toBe('UNAUTHORIZED');
});

it.each([new Uint8Array([1, 2]).buffer, JSON.stringify({ v: 1, type: 'join', payload: { sessionToken: '😀'.repeat(9000) } })])('rejects binary and UTF-8 oversized frames %#', async (frame) => {
  const room = await createRoom();
  const socket = await connect(room);
  const close = closed(socket);
  socket.send(frame);
  expect((await close).reason).toBe('INVALID_MESSAGE');
});

it('authenticates the join frame before sending a server-authored welcome', async () => {
  const room = await createRoom();
  const socket = await connect(room, 'https://jemboods.github.io');
  try {
    const reply = message(socket);
    socket.send(JSON.stringify({ v: 1, type: 'join', payload: { sessionToken: room.sessionToken } }));
    const raw = await reply;
    expect(JSON.parse(raw)).toMatchObject({ v: 1, room: room.room.id, type: 'welcome', payload: {
      self: { id: room.participant.id, role: 'owner' }, participants: [{ id: room.participant.id }], liveOnly: true,
    } });
    expect(raw).not.toContain(room.sessionToken);
    expect(raw).not.toContain(room.ownerKey);
    expect(raw).not.toContain('ownerKeyHash');
  } finally { socket.close(); }
});
