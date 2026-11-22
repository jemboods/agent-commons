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
function rawMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true }));
}
function matchingMessage(socket: WebSocket, predicate: (event: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', listener);
      reject(new Error('Timed out waiting for matching WebSocket event'));
    }, 1000);
    const listener = (messageEvent: MessageEvent) => {
      const event = JSON.parse(String(messageEvent.data)) as Record<string, unknown>;
      if (!predicate(event)) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', listener);
      resolve(event);
    };
    socket.addEventListener('message', listener);
  });
}
function message(socket: WebSocket): Promise<string> {
  return rawMessage(socket).then((raw) => JSON.parse(raw).type === 'presence' ? message(socket) : raw);
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
    const onMessage = (event: MessageEvent) => {
      const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (parsed.type === 'presence') return;
      socket.removeEventListener('message', onMessage);
      resolve(parsed);
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', (event) => resolve({ closed: event.reason }), { once: true });
  });
}
function chat(socket: WebSocket, payload: unknown) {
  socket.send(JSON.stringify({ v: 1, type: 'message', payload }));
}

it('broadcasts participant presence only on first connection and final disconnect', async () => {
  const room = await createRoom();
  const owner = await authenticated(room);
  const joined = await SELF.fetch(`https://example.com/api/rooms/${room.room.id}/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Presence guest', kind: 'human', accessCode: 'socket-test-code' }),
  });
  expect(joined.status).toBe(200);
  const guest = await joined.json() as Access;
  const events: Record<string, unknown>[] = [];
  const observer = (event: MessageEvent) => events.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  owner.addEventListener('message', observer);

  try {
    const online = matchingMessage(owner, (event) => event.type === 'presence' &&
      (event.payload as Record<string, unknown>).participantId === guest.participant.id &&
      (event.payload as Record<string, unknown>).online === true);
    const first = await authenticated(guest);
    expect(await online).toMatchObject({ type: 'presence', room: room.room.id,
      payload: { participantId: guest.participant.id, online: true } });

    const duplicate = await authenticated(guest);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.filter((event) => event.type === 'presence' &&
      (event.payload as Record<string, unknown>).participantId === guest.participant.id)).toHaveLength(1);

    duplicate.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.filter((event) => event.type === 'presence' &&
      (event.payload as Record<string, unknown>).participantId === guest.participant.id &&
      (event.payload as Record<string, unknown>).online === false)).toHaveLength(0);

    const offline = matchingMessage(owner, (event) => event.type === 'presence' &&
      (event.payload as Record<string, unknown>).participantId === guest.participant.id &&
      (event.payload as Record<string, unknown>).online === false);
    first.close();
    expect(await offline).toMatchObject({ type: 'presence', room: room.room.id,
      payload: { participantId: guest.participant.id, online: false } });
  } finally { owner.removeEventListener('message', observer); owner.close(); }
});

it('relays rate-limited typing to other authorized connections without persisting content', async () => {
  const room = await createRoom();
  const sender = await authenticated(room);
  const watcher = await authenticated(room);
  const events: Record<string, unknown>[] = [];
  const observer = (event: MessageEvent) => events.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  watcher.addEventListener('message', observer);
  const typing = () => sender.send(JSON.stringify({ v: 1, type: 'typing', payload: {} }));
  try {
    const first = matchingMessage(watcher, (event) => event.type === 'typing');
    typing();
    expect(await first).toMatchObject({ v: 1, room: room.room.id, type: 'typing',
      from: { id: room.participant.id, name: 'Owner', kind: 'human' }, payload: {} });
    typing();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events.filter((event) => event.type === 'typing')).toHaveLength(1);

    await runInDurableObject(stub(room), async (_instance, state) => {
      const row = state.storage.sql.exec<{ value: string }>("SELECT value FROM room_state WHERE key='room'").one();
      const saved = JSON.parse(row.value);
      expect(saved.recentMessages).toEqual([]);
      saved.rate = saved.rate.map((entry: { key: string }) => entry.key.startsWith('typing:') ? { ...entry, until: Date.now() - 1 } : entry);
      state.storage.sql.exec("UPDATE room_state SET value=? WHERE key='room'", JSON.stringify(saved));
    });
    const recovered = matchingMessage(watcher, (event) => event.type === 'typing');
    typing();
    expect(await recovered).toMatchObject({ type: 'typing', from: { id: room.participant.id } });
  } finally { watcher.removeEventListener('message', observer); sender.close(); watcher.close(); }
});

it('rejects typing frames that carry extra fields or content', async () => {
  const room = await createRoom();
  const sender = await authenticated(room);
  try {
    const rejected = outcome(sender);
    sender.send(JSON.stringify({ v: 1, type: 'typing', payload: { text: 'smuggled' } }));
    expect(await rejected).toEqual({ closed: 'INVALID_MESSAGE' });
  } finally { sender.close(); }
});

it('drops typing from an observer while keeping the read connection open', async () => {
  const room = await createRoom();
  const sender = await authenticated(room);
  const watcher = await authenticated(room);
  const events: Record<string, unknown>[] = [];
  const observer = (event: MessageEvent) => events.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  watcher.addEventListener('message', observer);
  try {
    await runInDurableObject(stub(room), async (_instance, state) => {
      const row = state.storage.sql.exec<{ value: string }>("SELECT value FROM room_state WHERE key='room'").one();
      const saved = JSON.parse(row.value);
      saved.participants[0].role = 'observer';
      state.storage.sql.exec("UPDATE room_state SET value=? WHERE key='room'", JSON.stringify(saved));
    });
    sender.send(JSON.stringify({ v: 1, type: 'typing', payload: {} }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events.filter((event) => event.type === 'typing')).toEqual([]);
    const alive = outcome(sender);
    chat(sender, { text: 'Still readable' });
    expect(await alive).toMatchObject({ type: 'error', payload: { code: 'FORBIDDEN' } });
  } finally { watcher.removeEventListener('message', observer); sender.close(); watcher.close(); }
});

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

it('accepts the production workers.dev origin', async () => {
  const room = await createRoom();
  const socket = await connect(room, 'https://agent-commons.doloresblick1.workers.dev');
  try {
    const reply = message(socket);
    join(socket, room.sessionToken);
    expect(JSON.parse(await reply).type).toBe('welcome');
  } finally { socket.close(); }
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

function control(socket: WebSocket, payload: unknown) {
  socket.send(JSON.stringify({ v: 1, type: 'control', payload }));
}

async function joinGuest(room: Access, name: string, kind: 'human' | 'agent' = 'human'): Promise<Access> {
  const joined = await SELF.fetch(`https://example.com/api/rooms/${room.room.id}/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, kind, accessCode: 'socket-test-code' }),
  });
  expect(joined.status).toBe(200);
  return joined.json() as Promise<Access>;
}

async function welcomeOf(access: Access) {
  const socket = await connect(access);
  const welcome = message(socket);
  join(socket, access.sessionToken);
  const parsed = JSON.parse(await welcome) as Record<string, unknown>;
  socket.close();
  return parsed;
}

it('pauses and resumes room chat for non-privileged participants', async () => {
  const room = await createRoom();
  const owner = await authenticated(room);
  const guest = await joinGuest(room, 'Pause guest');
  const guestSocket = await authenticated(guest);
  try {
    const stateEvent = matchingMessage(guestSocket, (event) => event.type === 'state');
    control(owner, { action: 'pause' });
    expect(await stateEvent).toMatchObject({ type: 'state', payload: { chatState: 'paused' } });

    const paused = outcome(guestSocket);
    chat(guestSocket, { text: 'Tidak terkirim' });
    expect(await paused).toMatchObject({ type: 'error', payload: { code: 'ROOM_PAUSED' } });

    const ownerMessage = matchingMessage(guestSocket, (event) => event.type === 'message');
    chat(owner, { text: 'Owner tetap bisa' });
    expect(await ownerMessage).toMatchObject({ type: 'message', payload: { text: 'Owner tetap bisa' } });

    const snapshot = await SELF.fetch(`https://example.com/api/rooms/${room.room.id}`, {
      headers: { authorization: `Bearer ${room.sessionToken}` },
    });
    expect(snapshot.status).toBe(200);
    const view = await snapshot.json() as { room: Record<string, unknown> };
    expect(view.room.chatState).toBe('paused');

    const resumed = matchingMessage(guestSocket, (event) => event.type === 'state');
    control(owner, { action: 'resume' });
    expect(await resumed).toMatchObject({ type: 'state', payload: { chatState: 'active' } });

    const delivered = matchingMessage(owner, (event) => event.type === 'message');
    chat(guestSocket, { text: 'Sudah bisa lagi' });
    expect(await delivered).toMatchObject({ type: 'message', payload: { text: 'Sudah bisa lagi' } });
  } finally { owner.close(); guestSocket.close(); }
});

it('rejects room controls from a participant without control permission', async () => {
  const room = await createRoom();
  const owner = await authenticated(room);
  const guest = await joinGuest(room, 'Control guest');
  const guestSocket = await authenticated(guest);
  try {
    const denied = outcome(guestSocket);
    control(guestSocket, { action: 'pause' });
    expect(await denied).toMatchObject({ type: 'error', payload: { code: 'FORBIDDEN' } });

    const delivered = matchingMessage(owner, (event) => event.type === 'message');
    chat(guestSocket, { text: 'Room tidak ikut pause' });
    expect(await delivered).toMatchObject({ type: 'message', payload: { text: 'Room tidak ikut pause' } });
  } finally { owner.close(); guestSocket.close(); }
});

it('mutes and unmutes a participant and reports it in welcome', async () => {
  const room = await createRoom();
  const owner = await authenticated(room);
  const guest = await joinGuest(room, 'Mute guest');
  const guestSocket = await authenticated(guest);
  try {
    const stateEvent = matchingMessage(guestSocket, (event) => event.type === 'state');
    control(owner, { action: 'mute', participantId: guest.participant.id });
    expect(await stateEvent).toMatchObject({ type: 'state',
      payload: { muted: [guest.participant.id] } });

    const muted = outcome(guestSocket);
    chat(guestSocket, { text: 'Sedang dibisukan' });
    expect(await muted).toMatchObject({ type: 'error', payload: { code: 'MUTED' } });

    const welcome = await welcomeOf(guest);
    const participants = (welcome.payload as Record<string, unknown>).participants as Record<string, unknown>[];
    expect(participants.find((entry) => entry.id === guest.participant.id)).toMatchObject({ muted: true });

    const cleared = matchingMessage(guestSocket, (event) => event.type === 'state');
    control(owner, { action: 'unmute', participantId: guest.participant.id });
    expect(await cleared).toMatchObject({ type: 'state', payload: { muted: [] } });

    const delivered = matchingMessage(owner, (event) => event.type === 'message');
    chat(guestSocket, { text: 'Sudah bersuara' });
    expect(await delivered).toMatchObject({ type: 'message', payload: { text: 'Sudah bersuara' } });
  } finally { owner.close(); guestSocket.close(); }
});

it('lets a moderator mute a human but not pause or mute the owner', async () => {
  const room = await createRoom();
  const owner = await authenticated(room);
  const moderator = await joinGuest(room, 'Mod guest');
  const target = await joinGuest(room, 'Target guest');
  const promoted = await SELF.fetch(`https://example.com/api/rooms/${room.room.id}/participants/${moderator.participant.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${room.sessionToken}` },
    body: JSON.stringify({ role: 'moderator' }),
  });
  expect(promoted.status).toBe(200);
  const moderatorSocket = await authenticated(moderator);
  const targetSocket = await authenticated(target);
  try {
    const modState = matchingMessage(targetSocket, (event) => event.type === 'state');
    control(moderatorSocket, { action: 'mute', participantId: target.participant.id });
    expect(await modState).toMatchObject({ type: 'state', payload: { muted: [target.participant.id] } });
    const muted = outcome(targetSocket);
    chat(targetSocket, { text: 'Dibisukan moderator' });
    expect(await muted).toMatchObject({ type: 'error', payload: { code: 'MUTED' } });

    const pauseDenied = outcome(moderatorSocket);
    control(moderatorSocket, { action: 'pause' });
    expect(await pauseDenied).toMatchObject({ type: 'error', payload: { code: 'FORBIDDEN' } });

    const ownerMuteDenied = outcome(moderatorSocket);
    control(moderatorSocket, { action: 'mute', participantId: room.participant.id });
    expect(await ownerMuteDenied).toMatchObject({ type: 'error', payload: { code: 'FORBIDDEN' } });
  } finally { owner.close(); moderatorSocket.close(); targetSocket.close(); }
});

function ack(socket: WebSocket, interruptId: string) {
  socket.send(JSON.stringify({ v: 1, type: 'interrupt_ack', payload: { interruptId } }));
}

async function roomSnapshot(room: Access) {
  const snapshot = await SELF.fetch(`https://example.com/api/rooms/${room.room.id}`, {
    headers: { authorization: `Bearer ${room.sessionToken}` },
  });
  expect(snapshot.status).toBe(200);
  return snapshot.json() as Promise<{ room: Record<string, unknown>; participants: Record<string, unknown>[] }>;
}

it('hard interrupt blocks agent messages until resume and records acks', async () => {
  const room = await createRoom();
  const owner = await authenticated(room);
  const agent = await joinGuest(room, 'Worker agent', 'agent');
  const human = await joinGuest(room, 'Watching human');
  const agentSocket = await authenticated(agent);
  const humanSocket = await authenticated(human);
  try {
    const interruptEvent = matchingMessage(agentSocket, (event) => event.type === 'interrupt');
    const stateEvent = matchingMessage(agentSocket, (event) => event.type === 'state');
    control(owner, { action: 'interrupt', mode: 'hard' });
    const interrupt = await interruptEvent;
    expect(interrupt).toMatchObject({ type: 'interrupt', payload: { mode: 'hard', by: room.participant.id } });
    const interruptId = (interrupt.payload as Record<string, unknown>).interruptId as string;
    expect(interruptId).toMatch(/^int_[a-f0-9]{32}$/);
    expect(await stateEvent).toMatchObject({ type: 'state', payload: { chatState: 'interrupted' } });

    const blocked = outcome(agentSocket);
    chat(agentSocket, { text: 'Agent mencoba bicara' });
    expect(await blocked).toMatchObject({ type: 'error', payload: { code: 'ROOM_INTERRUPTED' } });

    const humanCopy = matchingMessage(humanSocket, (event) => event.type === 'message');
    chat(owner, { text: 'Manusia tetap bisa' });
    expect(await humanCopy).toMatchObject({ type: 'message', payload: { text: 'Manusia tetap bisa' } });

    ack(agentSocket, interruptId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const view = await roomSnapshot(room);
    const record = view.room.interrupt as Record<string, unknown>;
    expect(record.mode).toBe('hard');
    expect(record.acks).toEqual([agent.participant.id]);

    const resumed = matchingMessage(agentSocket, (event) => event.type === 'state');
    control(owner, { action: 'resume' });
    expect(await resumed).toMatchObject({ type: 'state', payload: { chatState: 'active' } });

    const delivered = matchingMessage(humanSocket, (event) => event.type === 'message');
    chat(agentSocket, { text: 'Agent lanjut lagi' });
    expect(await delivered).toMatchObject({ type: 'message', payload: { text: 'Agent lanjut lagi' } });

    const cleared = await roomSnapshot(room);
    expect(cleared.room.interrupt).toBeNull();
  } finally { owner.close(); agentSocket.close(); humanSocket.close(); }
});

it('soft interrupt notifies agents without blocking their messages', async () => {
  const room = await createRoom();
  const owner = await authenticated(room);
  const agent = await joinGuest(room, 'Soft agent', 'agent');
  const agentSocket = await authenticated(agent);
  try {
    const interruptEvent = matchingMessage(agentSocket, (event) => event.type === 'interrupt');
    control(owner, { action: 'interrupt', mode: 'soft' });
    expect(await interruptEvent).toMatchObject({ type: 'interrupt', payload: { mode: 'soft' } });

    const delivered = matchingMessage(owner, (event) => event.type === 'message');
    chat(agentSocket, { text: 'Agent tetap jalan' });
    expect(await delivered).toMatchObject({ type: 'message', payload: { text: 'Agent tetap jalan' } });

    const view = await roomSnapshot(room);
    expect(view.room.chatState).toBe('active');
    expect((view.room.interrupt as Record<string, unknown>).mode).toBe('soft');
  } finally { owner.close(); agentSocket.close(); }
});

it('rejects interrupt from a participant who is not the owner', async () => {
  const room = await createRoom();
  const owner = await authenticated(room);
  const agent = await joinGuest(room, 'Guard agent', 'agent');
  const human = await joinGuest(room, 'Plain human');
  const agentSocket = await authenticated(agent);
  const humanSocket = await authenticated(human);
  try {
    const denied = outcome(humanSocket);
    control(humanSocket, { action: 'interrupt', mode: 'hard' });
    expect(await denied).toMatchObject({ type: 'error', payload: { code: 'FORBIDDEN' } });

    const view = await roomSnapshot(room);
    expect(view.room.interrupt).toBeNull();
    expect(view.room.chatState).toBe('active');
  } finally { owner.close(); agentSocket.close(); humanSocket.close(); }
});

it('removes a participant, revoking their session and closing their socket', async () => {
  const room = await createRoom();
  const owner = await authenticated(room);
  const guest = await joinGuest(room, 'Removed guest');
  const guestSocket = await authenticated(guest);
  try {
    const offline = matchingMessage(owner, (event) => event.type === 'presence' &&
      (event.payload as Record<string, unknown>).participantId === guest.participant.id &&
      (event.payload as Record<string, unknown>).online === false);
    const closing = closed(guestSocket);
    control(owner, { action: 'remove', participantId: guest.participant.id });
    expect((await closing).reason).toBe('UNAUTHORIZED');
    expect(await offline).toMatchObject({ type: 'presence', payload: { online: false } });

    const view = await roomSnapshot(room);
    expect(view.participants.map((entry) => entry.id)).not.toContain(guest.participant.id);

    const stale = await connect(guest);
    const rejected = outcome(stale);
    join(stale, guest.sessionToken);
    expect(await rejected).toEqual({ closed: 'UNAUTHORIZED' });
    stale.close();

    const rejoined = await joinGuest(room, 'Removed guest returns');
    const rejoinedSocket = await authenticated(rejoined);
    const delivered = matchingMessage(owner, (event) => event.type === 'message');
    chat(rejoinedSocket, { text: 'Balik lagi' });
    expect(await delivered).toMatchObject({ type: 'message', payload: { text: 'Balik lagi' } });
    rejoinedSocket.close();
  } finally { owner.close(); guestSocket.close(); }
});

it('rejects remove for the owner and from a moderator', async () => {
  const room = await createRoom();
  const owner = await authenticated(room);
  const moderator = await joinGuest(room, 'Remove mod');
  const human = await joinGuest(room, 'Remove target');
  const promoted = await SELF.fetch(`https://example.com/api/rooms/${room.room.id}/participants/${moderator.participant.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${room.sessionToken}` },
    body: JSON.stringify({ role: 'moderator' }),
  });
  expect(promoted.status).toBe(200);
  const moderatorSocket = await authenticated(moderator);
  try {
    const modDenied = outcome(moderatorSocket);
    control(moderatorSocket, { action: 'remove', participantId: human.participant.id });
    expect(await modDenied).toMatchObject({ type: 'error', payload: { code: 'FORBIDDEN' } });

    const selfDenied = outcome(owner);
    control(owner, { action: 'remove', participantId: room.participant.id });
    expect(await selfDenied).toMatchObject({ type: 'error', payload: { code: 'FORBIDDEN' } });

    const view = await roomSnapshot(room);
    expect(view.participants.map((entry) => entry.id)).toContain(human.participant.id);
  } finally { owner.close(); moderatorSocket.close(); }
});

it('delivers an owner broadcast to everyone while the room is paused', async () => {
  const room = await createRoom();
  const owner = await authenticated(room);
  const guest = await joinGuest(room, 'Broadcast guest');
  const guestSocket = await authenticated(guest);
  try {
    const paused = matchingMessage(guestSocket, (event) => event.type === 'state');
    control(owner, { action: 'pause' });
    expect(await paused).toMatchObject({ type: 'state', payload: { chatState: 'paused' } });

    const denied = outcome(guestSocket);
    control(guestSocket, { action: 'broadcast', text: 'Bukan pengumuman resmi' });
    expect(await denied).toMatchObject({ type: 'error', payload: { code: 'FORBIDDEN' } });

    const announcement = matchingMessage(guestSocket, (event) => event.type === 'message');
    control(owner, { action: 'broadcast', text: 'Pengumuman: room di-pause dulu' });
    expect(await announcement).toMatchObject({ type: 'message',
      payload: { text: 'Pengumuman: room di-pause dulu', broadcast: true } });
  } finally { owner.close(); guestSocket.close(); }
});

it('pins and unpins a live message with server-verified attribution', async () => {
  const room = await createRoom();
  const owner = await authenticated(room);
  const guest = await joinGuest(room, 'Pin guest');
  const guestSocket = await authenticated(guest);
  try {
    const sent = matchingMessage(owner, (event) => event.type === 'message');
    chat(guestSocket, { text: 'Pin kalimat ini' });
    const messageId = (await sent).id as string;

    const guestDenied = outcome(guestSocket);
    control(guestSocket, { action: 'pin', messageId, text: 'Pin kalimat ini' });
    expect(await guestDenied).toMatchObject({ type: 'error', payload: { code: 'FORBIDDEN' } });

    const pinned = matchingMessage(guestSocket, (event) => event.type === 'state');
    const ownerPinned = matchingMessage(owner, (event) => event.type === 'state');
    control(owner, { action: 'pin', messageId, text: 'Pin kalimat ini' });
    const state = await pinned;
    await ownerPinned;
    const pins = (state.payload as Record<string, unknown>).pins as Record<string, unknown>[];
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ messageId, text: 'Pin kalimat ini', pinnedBy: room.participant.id });
    expect(pins[0].from).toMatchObject({ id: guest.participant.id, name: 'Pin guest', kind: 'human' });

    const duplicate = outcome(owner);
    control(owner, { action: 'pin', messageId, text: 'Pin kalimat ini' });
    expect(await duplicate).toMatchObject({ type: 'error', payload: { code: 'INVALID_MESSAGE' } });

    const unpinned = matchingMessage(guestSocket, (event) => event.type === 'state');
    control(owner, { action: 'unpin', messageId });
    expect(((await unpinned).payload as Record<string, unknown>).pins).toEqual([]);

    const view = await roomSnapshot(room);
    expect(view.room.pins).toEqual([]);
  } finally { owner.close(); guestSocket.close(); }
});

it('rejects pinning an unknown message and closes on a malformed message id', async () => {
  const room = await createRoom();
  const owner = await authenticated(room);
  const moderator = await joinGuest(room, 'Pin mod');
  const promoted = await SELF.fetch(`https://example.com/api/rooms/${room.room.id}/participants/${moderator.participant.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${room.sessionToken}` },
    body: JSON.stringify({ role: 'moderator' }),
  });
  expect(promoted.status).toBe(200);
  const moderatorSocket = await authenticated(moderator);
  try {
    const unknown = outcome(owner);
    control(owner, { action: 'pin', messageId: `msg_${'0'.repeat(32)}`, text: 'Tidak ada' });
    expect(await unknown).toMatchObject({ type: 'error', payload: { code: 'INVALID_MESSAGE' } });

    const closing = closed(moderatorSocket);
    control(moderatorSocket, { action: 'pin', messageId: 'bukan-id', text: 'Rusak' });
    expect((await closing).reason).toBe('INVALID_MESSAGE');
  } finally { owner.close(); moderatorSocket.close(); }
});

it('caps the pin list at ten messages', async () => {
  const room = await createRoom();
  const owner = await authenticated(room);
  const guestA = await joinGuest(room, 'Cap guest A');
  const guestB = await joinGuest(room, 'Cap guest B');
  const socketA = await authenticated(guestA);
  const socketB = await authenticated(guestB);
  const seen: Record<string, unknown>[] = [];
  owner.addEventListener('message', (event) => {
    const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
    if (parsed.type === 'message') seen.push(parsed);
  });
  try {
    for (let index = 1; index <= 5; index++) {
      chat(socketA, { text: `Pesan A${index}` });
      chat(socketB, { text: `Pesan B${index}` });
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seen).toHaveLength(10);

    for (let index = 0; index < 10; index++) {
      const messageId = seen[index].id as string;
      const text = (seen[index].payload as Record<string, unknown>).text as string;
      const pinned = matchingMessage(owner, (event) => event.type === 'state' &&
        ((event.payload as Record<string, unknown>).pins as unknown[]).length === index + 1);
      control(owner, { action: 'pin', messageId, text });
      await pinned;
    }

    const extra = matchingMessage(owner, (event) => event.type === 'message');
    chat(owner, { text: 'Pesan kesebelas' });
    const extraId = (await extra).id as string;
    const overflow = outcome(owner);
    control(owner, { action: 'pin', messageId: extraId, text: 'Pesan kesebelas' });
    expect(await overflow).toMatchObject({ type: 'error', payload: { code: 'INVALID_MESSAGE' } });

    const view = await roomSnapshot(room);
    expect(view.room.pins as unknown[]).toHaveLength(10);
  } finally { owner.close(); socketA.close(); socketB.close(); }
});
