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
