import { SELF, runDurableObjectAlarm } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

type Json = {
  [key: string]: unknown;
  name?: string;
  description?: string;
  accessCode?: string;
  ownerName?: string;
  role?: string;
  maxParticipants?: number;
};
type Participant = { id: string; name: string; kind: string; role: string; joinedAt: string; canInstruct: boolean };
type RoomSnapshot = { id: string; name: string; description: string; mode: string; maxParticipants: number; createdAt: string; expiresAt: string; accessCodeEnabled: boolean };
type ApiBody = {
  room: RoomSnapshot;
  participant: Participant;
  sessionToken: string;
  ownerKey: string;
  sessionExpiresAt: string;
  participants: Participant[];
  self: Participant;
  invitationToken: string;
  expiresAt: string;
  maxUses: number;
  error: string;
};

async function json<T extends object = ApiBody>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

async function createRoom(overrides: Json = {}) {
  const response = await SELF.fetch('https://example.com/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'TDD Room',
      description: 'temporary room',
      accessCode: 'stage-two-code',
      ownerName: 'Owner',
      ...overrides,
    }),
  });
  return { response, body: await json(response) };
}

async function joinRoom(id: string, input: Json, origin?: string) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (origin) headers.set('Origin', origin);
  const response = await SELF.fetch(`https://example.com/api/rooms/${id}/join`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  return { response, body: await json(response) };
}

describe('Stage 2 room membership API', () => {
  it('treats a room with no SQLite state as not found', async () => {
    const response = await SELF.fetch(`https://example.com/api/rooms/r_${'a'.repeat(32)}`);
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ error: 'NOT_FOUND' });
  });

  it('creates a persistent SQLite-backed room and joins with a code without granting owner rights', async () => {
    const created = await createRoom();
    expect(created.response.status).toBe(201);
    expect(created.body.room).toMatchObject({
      name: 'TDD Room',
      description: 'temporary room',
      mode: 'hybrid',
      maxParticipants: 20,
      accessCodeEnabled: true,
    });
    expect(created.body.room.id).toMatch(/^r_[a-f0-9]{32}$/);
    expect(created.body.participant).toMatchObject({ name: 'Owner', kind: 'human', role: 'owner' });
    expect(created.body.ownerKey).toEqual(expect.any(String));
    expect(created.body.sessionToken).toEqual(expect.any(String));
    expect(JSON.stringify(created.body)).not.toContain('stage-two-code');

    const joined = await joinRoom(created.body.room.id, {
      name: 'Aster', kind: 'agent', accessCode: 'stage-two-code',
    });
    expect(joined.response.status).toBe(200);
    expect(joined.body.participant).toMatchObject({ name: 'Aster', kind: 'agent', role: 'agent', canInstruct: false });
    expect(joined.body.sessionToken).not.toBe(created.body.sessionToken);

    const roster = await SELF.fetch(`https://example.com/api/rooms/${created.body.room.id}`, {
      headers: { Authorization: `Bearer ${joined.body.sessionToken}` },
    });
    expect(roster.status).toBe(200);
    const snapshot = await json(roster);
    expect(snapshot.participants).toHaveLength(2);
    expect(snapshot.self.id).toBe(joined.body.participant.id);
    expect(snapshot.room).not.toHaveProperty('accessCode');
    expect(snapshot.room).not.toHaveProperty('ownerKeyHash');
    expect(JSON.stringify(snapshot)).not.toMatch(/sessionToken|ownerKey|stage-two-code/i);
  });

  it('does not allow the owner to demote their own owner identity', async () => {
    const created = await createRoom();
    const response = await SELF.fetch(`https://example.com/api/rooms/${created.body.room.id}/participants/${created.body.participant.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${created.body.sessionToken}` },
      body: JSON.stringify({ role: 'human' }),
    });
    expect(response.status).toBe(403);
    const roster = await SELF.fetch(`https://example.com/api/rooms/${created.body.room.id}`, {
      headers: { Authorization: `Bearer ${created.body.sessionToken}` },
    });
    expect((await json(roster)).self.role).toBe('owner');
  });

  it('locks an IP out after five wrong credentials within the room', async () => {
    const created = await createRoom();
    const roomId = created.body.room.id as string;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const joined = await joinRoom(roomId, { name: 'Wrong', kind: 'human', accessCode: 'incorrect-code' });
      statuses.push(joined.response.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 429]);
    const blocked = await joinRoom(roomId, { name: 'Correct', kind: 'human', accessCode: 'stage-two-code' });
    expect(blocked.response.status).toBe(429);
  });

  it('resets the persisted credential lockout after successful owner recovery', async () => {
    const created = await createRoom();
    const roomId = created.body.room.id as string;
    const badOwnerKey = async () => SELF.fetch(`https://example.com/api/rooms/${roomId}/owner-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ownerKey: 'incorrect-owner-key-that-is-long-enough1' }),
    });

    for (let attempt = 0; attempt < 4; attempt++) expect((await badOwnerKey()).status).toBe(401);
    const recovered = await SELF.fetch(`https://example.com/api/rooms/${roomId}/owner-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ownerKey: created.body.ownerKey }),
    });
    expect(recovered.status).toBe(200);

    for (let attempt = 0; attempt < 4; attempt++) expect((await badOwnerKey()).status).toBe(401);
    expect((await badOwnerKey()).status).toBe(429);
  });

  it('rate-limits repeated requests independently inside each room', async () => {
    const created = await createRoom();
    const roomId = created.body.room.id as string;
    const headers = { Authorization: `Bearer ${created.body.sessionToken}` };
    for (let request = 0; request < 120; request++) {
      const response = await SELF.fetch(`https://example.com/api/rooms/${roomId}`, { headers });
      expect(response.status).toBe(200);
    }
    const limited = await SELF.fetch(`https://example.com/api/rooms/${roomId}`, { headers });
    expect(limited.status).toBe(429);
    expect(await json(limited)).toEqual({ error: 'RATE_LIMITED' });
  });

  it('rejects declared oversized JSON before consuming the body', async () => {
    const response = await SELF.fetch('https://example.com/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(16 * 1024 + 1) },
      body: '{}',
    });
    expect(response.status).toBe(413);
    expect(await json(response)).toEqual({ error: 'INVALID_REQUEST' });
  });

  it('does not consume a single-use invitation when the room is full', async () => {
    const created = await createRoom({ maxParticipants: 2 });
    const roomId = created.body.room.id as string;
    const invitationResponse = await SELF.fetch(`https://example.com/api/rooms/${roomId}/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${created.body.sessionToken}` },
      body: JSON.stringify({ role: 'human' }),
    });
    const invitation = await json(invitationResponse);
    expect(invitationResponse.status).toBe(201);
    const occupant = await joinRoom(roomId, { name: 'Occupant', kind: 'human', accessCode: 'stage-two-code' });
    expect(occupant.response.status).toBe(200);

    const full = await joinRoom(roomId, { name: 'Invitee', kind: 'human', invitationToken: invitation.invitationToken });
    expect(full.response.status).toBe(409);
    const left = await SELF.fetch(`https://example.com/api/rooms/${roomId}/leave`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${occupant.body.sessionToken}` },
    });
    expect(left.status).toBe(200);
    const retry = await joinRoom(roomId, { name: 'Invitee', kind: 'human', invitationToken: invitation.invitationToken });
    expect(retry.response.status).toBe(200);
  });

  it('revokes the oldest owner session after the per-participant session cap', async () => {
    const created = await createRoom();
    const roomId = created.body.room.id as string;
    const tokens = [created.body.sessionToken as string];
    for (let session = 0; session < 5; session++) {
      const recovered = await SELF.fetch(`https://example.com/api/rooms/${roomId}/owner-session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ownerKey: created.body.ownerKey }),
      });
      expect(recovered.status).toBe(200);
      tokens.push((await json(recovered)).sessionToken as string);
    }
    const evicted = await SELF.fetch(`https://example.com/api/rooms/${roomId}`, {
      headers: { Authorization: `Bearer ${tokens[0]}` },
    });
    expect(evicted.status).toBe(401);
    const newest = await SELF.fetch(`https://example.com/api/rooms/${roomId}`, {
      headers: { Authorization: `Bearer ${tokens.at(-1)}` },
    });
    expect(newest.status).toBe(200);
  });

  it('reschedules a still-future room alarm instead of deleting the room', async () => {
    const created = await createRoom();
    const roomId = created.body.room.id as string;
    const updated = await SELF.fetch(`https://example.com/api/rooms/${roomId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${created.body.sessionToken}` },
      body: JSON.stringify({ expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() }),
    });
    expect(updated.status).toBe(200);
    const rooms = (env as unknown as { ROOMS: DurableObjectNamespace }).ROOMS;
    const stub = rooms.get(rooms.idFromName(roomId));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const roster = await SELF.fetch(`https://example.com/api/rooms/${roomId}`, {
      headers: { Authorization: `Bearer ${created.body.sessionToken}` },
    });
    expect(roster.status).toBe(200);
  });

  it('allows the owner to leave while retaining recoverable ownership', async () => {
    const created = await createRoom();
    const roomId = created.body.room.id as string;
    const leave = await SELF.fetch(`https://example.com/api/rooms/${roomId}/leave`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.body.sessionToken}` },
    });
    expect(leave.status).toBe(200);
    expect(await json(leave)).toEqual({ ok: true });

    const oldSession = await SELF.fetch(`https://example.com/api/rooms/${roomId}`, {
      headers: { Authorization: `Bearer ${created.body.sessionToken}` },
    });
    expect(oldSession.status).toBe(401);

    const recovered = await SELF.fetch(`https://example.com/api/rooms/${roomId}/owner-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ownerKey: created.body.ownerKey }),
    });
    expect(recovered.status).toBe(200);
    const body = await json(recovered);
    expect(body.participant).toMatchObject({ role: 'owner', name: 'Owner' });
    expect(body).not.toHaveProperty('ownerKey');
    const roster = await SELF.fetch(`https://example.com/api/rooms/${roomId}`, {
      headers: { Authorization: `Bearer ${body.sessionToken}` },
    });
    expect(roster.status).toBe(200);
  });
});
