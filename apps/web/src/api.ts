export type RoomMode = 'public' | 'private' | 'hybrid';
export type ParticipantKind = 'human' | 'agent';
export type ParticipantRole = 'owner' | 'moderator' | 'human' | 'agent' | 'observer';
export type ChatState = 'active' | 'paused' | 'interrupted';

export interface InterruptView {
  id: string;
  mode: 'soft' | 'hard';
  by: string;
  ts: string;
  acks: string[];
}

export interface PinView {
  messageId: string;
  text: string;
  from: { id: string; name: string; kind: ParticipantKind };
  pinnedBy: string;
  ts: string;
}

export interface RoomView {
  id: string;
  name: string;
  description: string;
  mode: RoomMode;
  maxParticipants: number;
  createdAt: string;
  expiresAt: string;
  accessCodeEnabled: boolean;
  chatState: ChatState;
  interrupt: InterruptView | null;
  pins: PinView[];
}

export interface Participant {
  id: string;
  name: string;
  kind: ParticipantKind;
  role: ParticipantRole;
  joinedAt: string;
  canInstruct: boolean;
  muted: boolean;
}

export interface CreateRoomInput {
  name: string;
  description?: string;
  accessCode: string;
  ownerName: string;
  mode?: RoomMode;
  maxParticipants?: number;
  lifetimeHours?: number;
}

export interface SessionResponse {
  room: RoomView;
  participant: Participant;
  sessionToken: string;
  sessionExpiresAt: string;
}

export interface CreateRoomResponse extends SessionResponse {
  ownerKey: string;
}

export interface RoomSnapshot {
  room: RoomView;
  participants: Participant[];
  self: Participant;
}

export interface InvitationResponse {
  invitationToken: string;
  expiresAt: string;
  maxUses: number;
}

export class ApiError extends Error {
  constructor(readonly code: string) {
    super('Request failed');
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options: {
  method?: string;
  body?: unknown;
  sessionToken?: string;
} = {}): Promise<T> {
  const headers = new Headers();
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.sessionToken) headers.set('Authorization', `Bearer ${options.sessionToken}`);

  const response = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
  });
  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const code = typeof payload === 'object' && payload !== null &&
      'error' in payload && typeof payload.error === 'string' ? payload.error : 'REQUEST_FAILED';
    throw new ApiError(code);
  }
  return payload as T;
}

export function checkHealth(signal?: AbortSignal): Promise<Response> {
  return fetch('/api/health', { signal, cache: 'no-store' });
}

export function createRoom(input: CreateRoomInput): Promise<CreateRoomResponse> {
  return request<CreateRoomResponse>('/rooms', { method: 'POST', body: input });
}

export function joinRoom(roomId: string, input: {
  name: string;
  kind: ParticipantKind;
  accessCode?: string;
  invitationToken?: string;
}): Promise<SessionResponse> {
  return request<SessionResponse>(`/rooms/${encodeURIComponent(roomId)}/join`, { method: 'POST', body: input });
}

export function recoverOwner(roomId: string, ownerKey: string): Promise<SessionResponse> {
  return request<SessionResponse>(`/rooms/${encodeURIComponent(roomId)}/owner-session`, { method: 'POST', body: { ownerKey } });
}

export function getRoom(roomId: string, sessionToken: string): Promise<RoomSnapshot> {
  return request<RoomSnapshot>(`/rooms/${encodeURIComponent(roomId)}`, { sessionToken });
}

export function updateRoom(roomId: string, sessionToken: string, input: {
  name: string;
  description: string;
  mode: RoomMode;
  maxParticipants: number;
  expiresAt?: string;
}): Promise<{ room: RoomView }> {
  return request<{ room: RoomView }>(`/rooms/${encodeURIComponent(roomId)}`, { method: 'PATCH', sessionToken, body: input });
}

export function updateAccessCode(roomId: string, sessionToken: string, accessCode: string | null): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/rooms/${encodeURIComponent(roomId)}/access-code`, {
    method: 'PUT', sessionToken, body: { accessCode },
  });
}

export function createInvitation(roomId: string, sessionToken: string, input: {
  role: Exclude<ParticipantRole, 'owner' | 'moderator'>;
  name?: string;
  maxUses?: number;
  expiresInSeconds?: number;
}): Promise<InvitationResponse> {
  return request<InvitationResponse>(`/rooms/${encodeURIComponent(roomId)}/invitations`, {
    method: 'POST', sessionToken, body: input,
  });
}

export function updateParticipant(roomId: string, sessionToken: string, participantId: string, input: {
  role: Exclude<ParticipantRole, 'owner'>;
  canInstruct?: boolean;
}): Promise<{ participant: Participant }> {
  return request<{ participant: Participant }>(
    `/rooms/${encodeURIComponent(roomId)}/participants/${encodeURIComponent(participantId)}`,
    { method: 'PATCH', sessionToken, body: input },
  );
}

export function leaveRoom(roomId: string, sessionToken: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/rooms/${encodeURIComponent(roomId)}/leave`, { method: 'POST', sessionToken });
}

export function deleteRoom(roomId: string, sessionToken: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/rooms/${encodeURIComponent(roomId)}`, { method: 'DELETE', sessionToken });
}
