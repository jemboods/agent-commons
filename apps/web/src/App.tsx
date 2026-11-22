import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  checkHealth,
  createInvitation,
  createRoom,
  deleteRoom,
  getRoom,
  joinRoom,
  leaveRoom,
  recoverOwner,
  updateAccessCode,
  updateParticipant,
  updateRoom,
  type CreateRoomResponse,
  type Participant,
  type ParticipantKind,
  type ParticipantRole,
  type RoomMode,
  type RoomSnapshot,
  type SessionResponse,
} from './api';
import { useRoomChat, type ChatErrorCode, type ChatMessage, type ChatStatus } from './chat';

type Connection = 'checking' | 'connected' | 'unavailable';
type CredentialType = 'access-code' | 'invitation';
type RoleDraft = { role: Exclude<ParticipantRole, 'owner'>; canInstruct: boolean };

const SHORTENER_INVITE_URL = 'https://go.jemboods.workers.dev/api/shorten-invite';

// Builds the long invite URL that pre-fills the join form for a room.
function buildInviteUrl(roomId: string, accessCode: string): string {
  const payload = btoa(JSON.stringify({ r: roomId, c: accessCode })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `${window.location.origin}${window.location.pathname}?invite=${payload}`;
}

// Asks the personal shortener for a short version of an invite link.
// Returns null when shortening is unavailable; callers keep the long link.
async function requestShortInviteUrl(longUrl: string): Promise<string | null> {
  try {
    const response = await fetch(SHORTENER_INVITE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: longUrl }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { shortUrl?: unknown };
    return typeof data.shortUrl === 'string' ? data.shortUrl : null;
  } catch {
    return null;
  }
}

const SENDER_NAME_COLORS = ['#8fdfbd', '#f2c94c', '#7cc7ff', '#ff9d9d', '#c39bff', '#ffa26b', '#6be3d4', '#f49ad6'] as const;

// Picks a stable display color for a participant from their id, so each
// sender keeps the same name and avatar color across the whole room.
function senderColor(participantId: string): string {
  let hash = 0;
  for (let index = 0; index < participantId.length; index++) {
    hash = (hash * 31 + participantId.charCodeAt(index)) >>> 0;
  }
  return SENDER_NAME_COLORS[hash % SENDER_NAME_COLORS.length];
}

// Up to two initials shown in the avatar circle next to a sender's bubbles.
function senderInitials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part.charAt(0).toUpperCase()).join('') || '?';
}

function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'The server could not be reached. Your credentials were not saved.';
  if (error.code === 'ROOM_FULL') return 'This room is full.';
  if (error.code === 'ROOM_EXPIRED') return 'This room has expired.';
  if (error.code === 'FORBIDDEN') return 'This action is not allowed for your membership.';
  if (error.code === 'RATE_LIMITED') return 'Too many failed credentials. Try again later.';
  if (error.code === 'UNAUTHORIZED' || error.code === 'NOT_FOUND' || error.code.includes('INVALID') || error.code.includes('EXPIRED')) {
    return 'The room ID or credential is invalid or expired.';
  }
  if (error.code.includes('PRIVATE')) return 'This room only accepts invited participants.';
  return 'The request was rejected. Check the room details and try again.';
}

function toDateTimeLocal(value: string): string {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function modeLabel(mode: RoomMode): string {
  return mode[0].toUpperCase() + mode.slice(1);
}

function chatStatusLabel(status: ChatStatus): string {
  if (status === 'live') return 'Live chat connected';
  if (status === 'connecting') return 'Connecting live chat…';
  if (status === 'closed') return 'Live chat disconnected';
  return 'Live chat idle';
}

function chatErrorText(code: ChatErrorCode): string {
  if (code === 'FORBIDDEN') return 'You cannot send messages with your current role.';
  if (code === 'RATE_LIMITED') return 'Slow down: the room is rate limiting your messages.';
  if (code === 'ROOM_PAUSED') return 'The room is paused. Only the owner and moderators can send right now.';
  if (code === 'ROOM_INTERRUPTED') return 'Agents are interrupted. Agent messages stay blocked until the owner resumes.';
  if (code === 'MUTED') return 'You are muted in this room, so your message was not sent.';
  if (code === 'UNAUTHORIZED') return 'Your live session is no longer authorized.';
  if (code === 'SOCKET_ERROR') return 'The live connection failed. Reconnect when you are ready.';
  return 'The server rejected that frame. Nothing was sent.';
}

export default function App() {
  const [connection, setConnection] = useState<Connection>('checking');
  const [roomName, setRoomName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [accessCodeMode, setAccessCodeMode] = useState<'generate' | 'custom'>('generate');
  const [accessCode, setAccessCode] = useState(() => Math.random().toString(36).slice(2, 10));
  const [joinRoomId, setJoinRoomId] = useState('');
  const [joinName, setJoinName] = useState('');
  const [joinKind, setJoinKind] = useState<ParticipantKind>('human');
  const [credentialType, setCredentialType] = useState<CredentialType>('access-code');
  const [joinCredential, setJoinCredential] = useState('');
  const [recoveryRoomId, setRecoveryRoomId] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [ownerKey, setOwnerKey] = useState<string | null>(null);
  const [createdAccessCode, setCreatedAccessCode] = useState('');
  const [shortInvite, setShortInvite] = useState<{ forUrl: string; shortUrl: string } | null>(null);
  const [keySaved, setKeySaved] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [settingsName, setSettingsName] = useState('');
  const [settingsDescription, setSettingsDescription] = useState('');
  const [settingsMode, setSettingsMode] = useState<RoomMode>('hybrid');
  const [settingsMaxParticipants, setSettingsMaxParticipants] = useState('20');
  const [settingsExpiresAt, setSettingsExpiresAt] = useState('');
  const [newAccessCode, setNewAccessCode] = useState('');
  const [inviteRole, setInviteRole] = useState<'human' | 'agent' | 'observer'>('human');
  const [inviteName, setInviteName] = useState('');
  const [inviteMaxUses, setInviteMaxUses] = useState('1');
  const [inviteExpiry, setInviteExpiry] = useState('3600');
  const [invitationToken, setInvitationToken] = useState('');
  const [roleDrafts, setRoleDrafts] = useState<Record<string, RoleDraft>>({});
  const [chatText, setChatText] = useState('');
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [broadcastMode, setBroadcastMode] = useState(false);
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [showGroupInfo, setShowGroupInfo] = useState(true);
  const chat = useRoomChat({
    roomId: session?.room.id ?? '',
    sessionToken: session?.sessionToken ?? '',
    active: session !== null,
  });

  useEffect(() => {
    const controller = new AbortController();
    checkHealth(controller.signal)
      .then(async (response) => {
        const data: unknown = await response.json();
        if (!response.ok || typeof data !== 'object' || data === null ||
            !('service' in data) || data.service !== 'agent-commons' ||
            !('status' in data) || data.status !== 'ok' ||
            !('stage' in data) || data.stage !== 1) {
          throw new Error('Invalid health response');
        }
        setConnection('connected');
      })
      .catch(() => { if (!controller.signal.aborted) setConnection('unavailable'); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const invite = params.get('invite');
    const room = params.get('room');
    const code = params.get('accessCode') || params.get('code');
    const token = params.get('invitation');

    if (invite) {
      try {
        const decoded = JSON.parse(atob(invite.replaceAll('-', '+').replaceAll('_', '/')));
        if (decoded.r) setJoinRoomId(decoded.r);
        if (decoded.c) {
          setCredentialType('access-code');
          setJoinCredential(decoded.c);
        } else if (decoded.i) {
          setCredentialType('invitation');
          setJoinCredential(decoded.i);
        }
      } catch {
        // A malformed invite payload in the URL is ignored; the join form stays empty.
      }
    } else {
      if (room) setJoinRoomId(room);
      if (code) {
        setCredentialType('access-code');
        setJoinCredential(code);
      } else if (token) {
        setCredentialType('invitation');
        setJoinCredential(token);
      }
    }
  }, []);

  // Presence can reveal a participant who joined after this page's snapshot
  // was taken. Resync the roster quietly, once per unknown set, so their
  // presence, typing, and mention controls appear without a manual refresh.
  const rosterSyncRef = useRef('');
  useEffect(() => {
    if (!session || !snapshot) return;
    const known = new Set(snapshot.participants.map((participant) => participant.id));
    const unknown = Object.entries(chat.online)
      .filter(([id, online]) => online && !known.has(id))
      .map(([id]) => id)
      .sort()
      .join(',');
    if (!unknown || rosterSyncRef.current === unknown) return;
    rosterSyncRef.current = unknown;
    let cancelled = false;
    getRoom(session.room.id, session.sessionToken)
      .then((next) => { if (!cancelled) applySnapshot(next); })
      .catch(() => { /* roster stays stale until a manual refresh */ });
    return () => { cancelled = true; };
  }, [chat.online, session, snapshot]);

  function clearMessages() {
    setError('');
    setNotice('');
  }

  function showError(requestError: unknown) {
    setError(errorMessage(requestError));
    setNotice('');
  }

  function applySnapshot(next: RoomSnapshot) {
    setSnapshot(next);
    setSettingsName(next.room.name);
    setSettingsDescription(next.room.description);
    setSettingsMode(next.room.mode);
    setSettingsMaxParticipants(String(next.room.maxParticipants));
    setSettingsExpiresAt(toDateTimeLocal(next.room.expiresAt));
  }

  async function enterSession(result: SessionResponse, initialSnapshot?: RoomSnapshot) {
    setSession(result);
    setJoinRoomId('');
    setJoinName('');
    setJoinCredential('');
    setRecoveryRoomId('');
    setRecoveryKey('');
    if (initialSnapshot) applySnapshot(initialSnapshot);
    else applySnapshot(await getRoom(result.room.id, result.sessionToken));
  }

  async function onCreateRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearMessages();
    setBusy(true);
    try {
      const result: CreateRoomResponse = await createRoom({ name: roomName, ownerName, accessCode });
      const { ownerKey: createdOwnerKey, ...sessionResponse } = result;
      setCreatedAccessCode(accessCode);
      const initialSnapshot: RoomSnapshot = { room: result.room, participants: [result.participant], self: result.participant };
      setOwnerKey(createdOwnerKey);
      setKeySaved(false);
      await enterSession(sessionResponse, initialSnapshot);
      setRoomName('');
      setOwnerName('');
      setAccessCode('');
    } catch (requestError) {
      showError(requestError);
    } finally {
      setBusy(false);
    }
  }

  async function onJoinRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearMessages();
    setBusy(true);
    try {
      const credential = credentialType === 'access-code' ? { accessCode: joinCredential } : { invitationToken: joinCredential };
      const result = await joinRoom(joinRoomId.trim(), { name: joinName, kind: joinKind, ...credential });
      await enterSession(result);
    } catch (requestError) {
      showError(requestError);
    } finally {
      setBusy(false);
    }
  }

  async function onRecoverOwner(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearMessages();
    setBusy(true);
    try {
      const result = await recoverOwner(recoveryRoomId.trim(), recoveryKey);
      await enterSession(result);
    } catch (requestError) {
      showError(requestError);
    } finally {
      setBusy(false);
    }
  }

  async function refreshSnapshot() {
    if (!session) return;
    clearMessages();
    setBusy(true);
    try {
      applySnapshot(await getRoom(session.room.id, session.sessionToken));
      setNotice('Room snapshot refreshed.');
    } catch (requestError) {
      showError(requestError);
    } finally {
      setBusy(false);
    }
  }

  async function onSaveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    clearMessages();
    setBusy(true);
    try {
      const result = await updateRoom(session.room.id, session.sessionToken, {
        name: settingsName,
        description: settingsDescription,
        mode: settingsMode,
        maxParticipants: Number(settingsMaxParticipants),
        expiresAt: new Date(settingsExpiresAt).toISOString(),
      });
      if (snapshot) applySnapshot({ ...snapshot, room: result.room });
      setNotice('Room settings saved.');
    } catch (requestError) {
      showError(requestError);
    } finally {
      setBusy(false);
    }
  }

  async function onRotateAccessCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    clearMessages();
    setBusy(true);
    try {
      await updateAccessCode(session.room.id, session.sessionToken, newAccessCode);
      setNewAccessCode('');
      setNotice('Access code updated.');
      if (snapshot) setSnapshot({ ...snapshot, room: { ...snapshot.room, accessCodeEnabled: true } });
    } catch (requestError) {
      showError(requestError);
    } finally {
      setBusy(false);
    }
  }

  async function onDisableAccessCode() {
    if (!session) return;
    clearMessages();
    setBusy(true);
    try {
      await updateAccessCode(session.room.id, session.sessionToken, null);
      setNotice('Access code disabled.');
      if (snapshot) setSnapshot({ ...snapshot, room: { ...snapshot.room, accessCodeEnabled: false } });
    } catch (requestError) {
      showError(requestError);
    } finally {
      setBusy(false);
    }
  }

  async function onCreateInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    clearMessages();
    setBusy(true);
    try {
      const result = await createInvitation(session.room.id, session.sessionToken, {
        role: inviteRole,
        ...(inviteName.trim() ? { name: inviteName.trim() } : {}),
        maxUses: Number(inviteMaxUses),
        expiresInSeconds: Number(inviteExpiry),
      });
      setInvitationToken(result.invitationToken);
      setInviteName('');
      setNotice('Invitation created. Copy it now; it is shown only in this page.');
    } catch (requestError) {
      showError(requestError);
    } finally {
      setBusy(false);
    }
  }

  async function onSaveParticipant(participant: Participant) {
    if (!session) return;
    const draft = roleDrafts[participant.id] ?? { role: participant.role as Exclude<ParticipantRole, 'owner'>, canInstruct: participant.canInstruct };
    clearMessages();
    setBusy(true);
    try {
      const result = await updateParticipant(session.room.id, session.sessionToken, participant.id, {
        role: draft.role,
        ...(draft.role === 'moderator' ? { canInstruct: draft.canInstruct } : {}),
      });
      if (snapshot) {
        const participants = snapshot.participants.map((item) => item.id === participant.id ? result.participant : item);
        applySnapshot({ ...snapshot, participants, self: snapshot.self.id === participant.id ? result.participant : snapshot.self });
      }
      setRoleDrafts((current) => {
        const next = { ...current };
        delete next[participant.id];
        return next;
      });
      setNotice(`Role updated for ${participant.name}.`);
    } catch (requestError) {
      showError(requestError);
    } finally {
      setBusy(false);
    }
  }

  async function onLeaveRoom() {
    if (!session) return;
    clearMessages();
    setBusy(true);
    try {
      await leaveRoom(session.room.id, session.sessionToken);
      setSession(null);
      setSnapshot(null);
      setOwnerKey(null);
      setInvitationToken('');
      setNotice('You left the room.');
    } catch (requestError) {
      showError(requestError);
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteRoom() {
    if (!session) return;
    clearMessages();
    setBusy(true);
    try {
      await deleteRoom(session.room.id, session.sessionToken);
      setSession(null);
      setSnapshot(null);
      setOwnerKey(null);
      setInvitationToken('');
      setNotice('Room deleted.');
    } catch (requestError) {
      showError(requestError);
    } finally {
      setBusy(false);
    }
  }

  function dismissOwnerKey() {
    setOwnerKey(null);
    setKeySaved(true);
  }

  function updateRoleDraft(participant: Participant, value: Partial<RoleDraft>) {
    setRoleDrafts((current) => ({
      ...current,
      [participant.id]: {
        role: current[participant.id]?.role ?? (participant.role === 'owner' ? 'human' : participant.role),
        canInstruct: current[participant.id]?.canInstruct ?? participant.canInstruct,
        ...value,
      },
    }));
  }

  function onSendChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chatText.trim()) return;
    if (broadcastMode && isOwner) {
      if (!chat.sendControl({ action: 'broadcast', text: chatText })) {
        setNotice('');
        setError('The live connection is not ready, so the broadcast was not sent. Nothing is retried automatically.');
        return;
      }
      setChatText('');
      setBroadcastMode(false);
      return;
    }
    const sent = chat.send(chatText, {
      ...(replyTarget ? { replyTo: replyTarget.id } : {}),
      mentions: mentionIds,
    });
    if (!sent) {
      setNotice('');
      setError('The live connection is not ready, so the message was not sent. Nothing is retried automatically.');
      return;
    }
    setChatText('');
    setReplyTarget(null);
    setMentionIds([]);
  }

  function toggleMention(participantId: string) {
    setMentionIds((current) => current.includes(participantId)
      ? current.filter((id) => id !== participantId)
      : [...current, participantId]);
  }

  const selfId = snapshot?.self.id ?? '';
  const onlineIds = new Set(Object.entries(chat.online).filter(([, online]) => online).map(([id]) => id));
  const typingNames = snapshot
    ? snapshot.participants
      .filter((participant) => participant.id !== selfId && (chat.typing[participant.id] ?? 0) > Date.now())
      .map((participant) => participant.name)
    : [];
  const canSendChat = chat.status === 'live' && snapshot?.self.role !== 'observer';
  const selfRole = snapshot?.self.role;
  const canControl = selfRole === 'owner' || selfRole === 'moderator';
  const interruptByName = chat.interrupt
    ? snapshot?.participants.find((participant) => participant.id === chat.interrupt?.by)?.name ?? 'the owner'
    : '';
  const replyTargetText = replyTarget
    ? chat.messages.find((message) => message.id === replyTarget.id)?.text ?? replyTarget.text
    : '';

  const isOwner = snapshot?.self.role === 'owner';
  const inviteLongUrl = session && createdAccessCode ? buildInviteUrl(session.room.id, createdAccessCode) : null;

  useEffect(() => {
    if (!inviteLongUrl) return;
    let cancelled = false;
    void requestShortInviteUrl(inviteLongUrl).then((shortUrl) => {
      if (!cancelled && shortUrl) setShortInvite({ forUrl: inviteLongUrl, shortUrl });
    });
    return () => {
      cancelled = true;
    };
  }, [inviteLongUrl]);

  const inviteDisplayUrl = inviteLongUrl && shortInvite?.forUrl === inviteLongUrl ? shortInvite.shortUrl : inviteLongUrl;

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="./" aria-label="Agent Commons home">
          <span className="brand-mark" aria-hidden="true">AC</span><span>Agent Commons</span>
        </a>
        <div className="connection" role="status" aria-live="polite">
          <span className={`connection-dot ${connection}`} aria-hidden="true" />
          {connection === 'checking' ? 'Checking local Worker…' : connection === 'connected' ? 'Local Worker connected' : 'Local Worker unavailable'}
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar" aria-label="Room actions">
          <p className="eyebrow">Workspace</p>
          <p className="sidebar-note">Create a room or join one with a room ID and a credential.</p>
          <div className="sidebar-foot">Stage 4 · Human controls</div>
        </aside>

        <section className="main-panel">
          {error && <p className="error-banner" role="alert">{error}</p>}
          {notice && <p className="notice" role="status">{notice}</p>}
          {snapshot && session ? (
            <div className="tg-room-layout">
              <header className="tg-topbar">
                <div className="tg-topbar-left">
                  <span className="room-avatar" aria-hidden="true">{senderInitials(snapshot.room.name)}</span>
                  <div>
                    <h1 className="tg-room-title">{snapshot.room.name}</h1>
                    <p className="tg-room-subtitle">
                      {snapshot.participants.length} participants · {onlineIds.size} online · {modeLabel(snapshot.room.mode)} mode · {chatStatusLabel(chat.status)}
                    </p>
                  </div>
                </div>
                <div className="tg-topbar-right">
                  <button className="secondary-button" type="button" onClick={refreshSnapshot} disabled={busy}>{busy ? 'Working…' : 'Refresh roster'}</button>
                  <button className="secondary-button" type="button" aria-pressed={showGroupInfo} onClick={() => setShowGroupInfo((v) => !v)}>
                    {showGroupInfo ? 'Hide Info ✕' : 'Group Info ℹ️'}
                  </button>
                  {!isOwner ? (
                    <button className="secondary-button" type="button" onClick={onLeaveRoom} disabled={busy}>Leave room</button>
                  ) : (
                    <button className="danger-button" type="button" onClick={onDeleteRoom} disabled={busy}>Delete room</button>
                  )}
                </div>
              </header>

              <div className="tg-workspace">
                <section className="tg-chat-pane">
                  {chat.error && <p className="error-banner" role="alert">{chatErrorText(chat.error)}</p>}
                  {chat.chatState === 'paused' && <p className="notice" role="status">Room paused by the owner. Sending is limited to the owner and moderators.</p>}
                  {chat.chatState === 'interrupted' && <p className="notice" role="status">Agents interrupted by the owner. Agent messages are blocked until the owner resumes the room.</p>}
                  {chat.interrupt && chat.chatState === 'active' && <p className="field-hint">Soft interrupt sent by {interruptByName}. Agents were notified; chat continues.</p>}
                  
                  {isOwner && chat.status === 'live' && (
                    <div className="control-row" aria-label="Room controls">
                      {chat.chatState === 'active' ? (
                        <button className="small-button" type="button" onClick={() => chat.sendControl({ action: 'pause' })}>Pause room</button>
                      ) : (
                        <button className="small-button" type="button" onClick={() => chat.sendControl({ action: 'resume' })}>Resume room</button>
                      )}
                      <button className="small-button" type="button" onClick={() => chat.sendControl({ action: 'interrupt', mode: 'soft' })}>Interrupt agents (soft)</button>
                      <button className="small-button" type="button" onClick={() => chat.sendControl({ action: 'interrupt', mode: 'hard' })}>Interrupt agents (hard)</button>
                    </div>
                  )}

                  {chat.pins.length > 0 && (
                    <section className="pinned-panel" aria-label="Pinned messages">
                      <p className="eyebrow">Pinned messages</p>
                      <ul className="pinned-list">
                        {chat.pins.map((pin) => (
                          <li key={pin.messageId} className="pinned-item">
                            <strong>{pin.from.name}</strong>
                            <span className="pinned-text">{pin.text}</span>
                            {canControl && <button className="small-button" type="button" aria-label={`Unpin message from ${pin.from.name}`} onClick={() => chat.sendControl({ action: 'unpin', messageId: pin.messageId })}>Unpin</button>}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  <ol className="timeline tg-timeline" aria-label="Live timeline">
                    {chat.messages.length === 0 && <li className="timeline-empty">No live messages yet. Send the first message to start the conversation!</li>}
                    {chat.messages.map((message, index) => {
                      const quoted = message.replyTo ? chat.messages.find((item) => item.id === message.replyTo) : undefined;
                      const isOwn = message.from.id === snapshot.self.id;
                      const color = senderColor(message.from.id);
                      const time = new Date(message.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                      const previous = index > 0 ? chat.messages[index - 1] : undefined;
                      const grouped = previous !== undefined && !previous.broadcast && previous.from.id === message.from.id;
                      if (message.broadcast) {
                        return (
                          <li className="timeline-item broadcast-row" key={message.id} data-testid="chat-message">
                            <div className="broadcast-bubble">
                              <p className="broadcast-label"><span className="broadcast-badge">Broadcast</span> {message.from.name}</p>
                              <p className="bubble-text">{message.text}</p>
                              <p className="bubble-time"><time dateTime={message.ts}>{time}</time></p>
                            </div>
                          </li>
                        );
                      }
                      return (
                        <li className={`timeline-item${isOwn ? ' own' : ''}${grouped ? ' grouped' : ''}`} key={message.id} data-testid="chat-message">
                          {!isOwn && <span className={`avatar${grouped ? ' ghost' : ''}`} style={{ backgroundColor: `${color}26`, color }} aria-hidden="true">{senderInitials(message.from.name)}</span>}
                          <div className="bubble-col">
                            <div className={`bubble${isOwn ? ' own' : ''}`}>
                              {!isOwn && !grouped && (
                                <p className="bubble-name" style={{ color }}>
                                  {message.from.name}
                                  {message.from.kind === 'agent' && <span className="bubble-kind">agent</span>}
                                </p>
                              )}
                              {message.replyTo && <blockquote className="reply-quote">Replying to {quoted ? `${quoted.from.name}: ${quoted.text.slice(0, 80)}` : 'an earlier message'}</blockquote>}
                              <p className="bubble-text">{message.text}</p>
                              {message.mentions && message.mentions.length > 0 && (
                                <p className="mention-line">Mentions: {message.mentions.map((id) => snapshot.participants.find((participant) => participant.id === id)?.name ?? 'unknown participant').join(', ')}</p>
                              )}
                              <p className="bubble-time"><time dateTime={message.ts}>{time}</time></p>
                            </div>
                            <div className="bubble-actions">
                              <button className="small-button" type="button" aria-label={`Reply to message from ${message.from.name}`} onClick={() => setReplyTarget(message)}>Reply</button>
                              {canControl && <button className="small-button" type="button" aria-label={`Pin message from ${message.from.name}`} onClick={() => chat.sendControl({ action: 'pin', messageId: message.id, text: message.text })}>Pin</button>}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ol>

                  {typingNames.length > 0 && <p className="typing-line" aria-live="polite">{typingNames.join(', ')} {typingNames.length === 1 ? 'is' : 'are'} typing…</p>}
                  
                  {chat.status === 'closed' && (
                    <div className="chat-reconnect">
                      <p className="field-hint">The live connection closed{chat.closeReason ? ` (${chat.closeReason})` : ''}.</p>
                      <button className="small-button" type="button" onClick={chat.reconnect}>Reconnect live chat</button>
                    </div>
                  )}

                  {canSendChat ? (
                    <form className="chat-form" aria-label="Send a live message" onSubmit={onSendChat}>
                      {replyTarget && (
                        <div className="reply-banner">
                          <span>Replying to {replyTarget.from.name}: {replyTargetText.slice(0, 60)}</span>
                          <button className="small-button" type="button" aria-label="Cancel reply" onClick={() => setReplyTarget(null)}>Cancel</button>
                        </div>
                      )}
                      {mentionIds.length > 0 && (
                        <p className="field-hint">Mentions: {mentionIds.map((id) => snapshot.participants.find((participant) => participant.id === id)?.name ?? 'unknown participant').join(', ')}</p>
                      )}
                      <label className="field-label sr-only" htmlFor="chat-message-text">Message</label>
                      <div className="composer-row">
                        <button className="composer-icon-button" type="button" aria-label="Attach" title="Attach">📎</button>
                        <button className="composer-icon-button" type="button" aria-label="Emoji" title="Emoji">😊</button>
                        <textarea id="chat-message-text" className="text-input textarea" rows={1} maxLength={32000} value={chatText} onChange={(event) => { setChatText(event.target.value); chat.notifyTyping(); }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Type a message" />
                        <button className="send-button" type="submit" disabled={!chatText.trim()}>
                          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.4 20.4l17.8-7.5c.8-.35.8-1.45 0-1.8L3.4 3.6c-.66-.29-1.39.2-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .72.73 1.2 1.39.91z" /></svg>
                          <span className="send-label">Send message</span>
                        </button>
                      </div>
                      {isOwner && <button className="small-button" type="button" aria-pressed={broadcastMode} onClick={() => setBroadcastMode((value) => !value)} style={{ marginTop: '8px' }}>Broadcast</button>}
                      {broadcastMode && isOwner && <p className="field-hint">Broadcast mode: the next send is an owner announcement, delivered even while the room is paused.</p>}
                    </form>
                  ) : (
                    chat.status === 'live' && <p className="field-hint">You are an observer in this room: live messages are readable, sending is disabled.</p>
                  )}
                </section>

                {showGroupInfo && (
                  <aside className="tg-group-sidebar" aria-label="Group info and participants">
                    <div className="group-info-header">
                      <h3>Group Info</h3>
                      <button className="small-button" type="button" onClick={() => setShowGroupInfo(false)}>✕ Close</button>
                    </div>

                    <div className="group-info-section">
                      <p className="room-id">Room ID: {snapshot.room.id}</p>
                      {snapshot.room.description && <p className="group-desc">{snapshot.room.description}</p>}
                      <dl className="room-facts">
                        <div><dt>Mode</dt><dd>{modeLabel(snapshot.room.mode)}</dd></div>
                        <div><dt>Expires</dt><dd>{new Date(snapshot.room.expiresAt).toLocaleString()}</dd></div>
                        <div><dt>Your Role</dt><dd>{snapshot.self.role}</dd></div>
                      </dl>
                    </div>

                    {ownerKey && !keySaved && (
                      <section className="secret-card" aria-labelledby="owner-key-heading">
                        <p id="owner-key-heading" className="eyebrow">Owner key — shown once</p>
                        <p>Keep this key safe. Needed to recover owner access.</p>
                        <input id="owner-key" className="text-input secret-input" aria-label="Owner key" value={ownerKey} readOnly />
                        <button className="small-button" type="button" onClick={dismissOwnerKey}>I saved the owner key</button>
                      </section>
                    )}

                    {isOwner && createdAccessCode && (
                      <section className="secret-card" aria-labelledby="invite-link-heading">
                        <p id="invite-link-heading" className="eyebrow">Invite link</p>
                        <input className="text-input secret-input" value={inviteDisplayUrl ?? ''} readOnly />
                        <button className="small-button" type="button" onClick={() => {
                          if (!inviteDisplayUrl) return;
                          navigator.clipboard.writeText(inviteDisplayUrl);
                          setNotice('Invite link copied to clipboard.');
                        }}>Copy invite link</button>
                      </section>
                    )}

                    <section className="panel-card roster-card">
                      <div className="card-heading">
                        <div><p className="eyebrow">Members</p><h2>Participants ({snapshot.participants.length}/{snapshot.room.maxParticipants})</h2></div>
                      </div>
                      <ul className="participant-list">
                        {snapshot.participants.map((participant) => {
                          const draft = roleDrafts[participant.id] ?? { role: participant.role === 'owner' ? 'human' : participant.role, canInstruct: participant.canInstruct };
                          const online = onlineIds.has(participant.id);
                          return (
                            <li className="participant-row" key={participant.id}>
                              <div className="participant-identity">
                                <span className={`presence-dot ${online ? 'online' : 'offline'}`} role="img" aria-label={`${participant.name} ${online ? 'online' : 'offline'}`} />
                                <span className="avatar" aria-hidden="true">{participant.name.slice(0, 1).toUpperCase()}</span>
                                <div><strong>{participant.name} · {participant.role}</strong><span className="participant-meta">{participant.kind}{participant.id === snapshot.self.id ? ' · you' : ''}</span></div>
                              </div>
                              {participant.id !== snapshot.self.id && (
                                <button className="small-button" type="button" aria-pressed={mentionIds.includes(participant.id)} aria-label={`Mention ${participant.name}`} onClick={() => toggleMention(participant.id)}>{mentionIds.includes(participant.id) ? 'Mentioned' : 'Mention'}</button>
                              )}
                              {canControl && participant.role !== 'owner' && participant.id !== snapshot.self.id && !(selfRole === 'moderator' && participant.role === 'moderator') && (
                                <div className="participant-controls">
                                  {chat.mutedIds.includes(participant.id) ? (
                                    <button className="small-button" type="button" aria-label={`Unmute ${participant.name}`} onClick={() => chat.sendControl({ action: 'unmute', participantId: participant.id })}>Unmute</button>
                                  ) : (
                                    <button className="small-button" type="button" aria-label={`Mute ${participant.name}`} onClick={() => chat.sendControl({ action: 'mute', participantId: participant.id })}>Mute</button>
                                  )}
                                  {isOwner && <button className="small-button" type="button" aria-label={`Remove ${participant.name}`} onClick={() => chat.sendControl({ action: 'remove', participantId: participant.id })}>Remove</button>}
                                </div>
                              )}
                              {isOwner && participant.role !== 'owner' && (
                                <div className="role-controls">
                                  <label className="sr-only" htmlFor={`role-${participant.id}`}>Participant role for {participant.name}</label>
                                  <select id={`role-${participant.id}`} className="text-input compact-input" value={draft.role} onChange={(event) => updateRoleDraft(participant, { role: event.target.value as Exclude<ParticipantRole, 'owner'> })}>
                                    {participant.kind === 'human' && <><option value="human">Human</option><option value="moderator">Moderator</option></>}
                                    {participant.kind === 'agent' && <option value="agent">Agent</option>}
                                    <option value="observer">Observer</option>
                                  </select>
                                  {draft.role === 'moderator' && <label className="saved-check compact-check"><input type="checkbox" checked={draft.canInstruct} onChange={(event) => updateRoleDraft(participant, { canInstruct: event.target.checked })} /><span>Instruct</span></label>}
                                  <button className="small-button" type="button" onClick={() => onSaveParticipant(participant)} disabled={busy} aria-label={`Save role for ${participant.name}`}>Save</button>
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </section>

                    {isOwner && (
                      <div className="management-stack">
                        <section className="panel-card">
                          <div className="card-heading"><div><p className="eyebrow">Owner</p><h2>Room Settings</h2></div></div>
                          <form onSubmit={onSaveSettings}>
                            <label className="field-label" htmlFor="room-name-setting">Room name</label>
                            <input id="room-name-setting" className="text-input" aria-label="Room name setting" value={settingsName} onChange={(event) => setSettingsName(event.target.value)} required maxLength={80} />
                            <label className="field-label" htmlFor="room-description-setting">Description</label>
                            <textarea id="room-description-setting" className="text-input textarea" aria-label="Room description setting" value={settingsDescription} onChange={(event) => setSettingsDescription(event.target.value)} maxLength={500} rows={2} />
                            <label className="field-label" htmlFor="room-mode-setting">Access mode</label>
                            <select id="room-mode-setting" className="text-input" aria-label="Room access mode" value={settingsMode} onChange={(event) => setSettingsMode(event.target.value as RoomMode)}><option value="public">Public</option><option value="private">Private</option><option value="hybrid">Hybrid</option></select>
                            <label className="field-label" htmlFor="max-participants-setting">Maximum participants</label>
                            <input id="max-participants-setting" className="text-input" type="number" min={snapshot.participants.length} max={100} value={settingsMaxParticipants} onChange={(event) => setSettingsMaxParticipants(event.target.value)} required />
                            <label className="field-label" htmlFor="room-expiry-setting">Room expires</label>
                            <input id="room-expiry-setting" className="text-input" type="datetime-local" aria-label="Room expiry" min={toDateTimeLocal(new Date().toISOString())} value={settingsExpiresAt} onChange={(event) => setSettingsExpiresAt(event.target.value)} required />
                            <button className="primary-button" type="submit" disabled={busy}>Save room settings</button>
                          </form>
                        </section>

                        <section className="panel-card" aria-labelledby="access-code-heading">
                          <div className="card-heading"><div><p className="eyebrow">Credential control</p><h2 id="access-code-heading">Access code</h2></div></div>
                          <p className="field-hint">{snapshot.room.accessCodeEnabled ? 'Enabled. Existing sessions are not affected by rotation.' : 'Disabled. Invitations remain available.'}</p>
                          <form onSubmit={onRotateAccessCode}>
                            <label className="field-label" htmlFor="new-access-code">New access code</label>
                            <input id="new-access-code" className="text-input" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={newAccessCode} onChange={(event) => setNewAccessCode(event.target.value)} required />
                            <button className="primary-button" type="submit" disabled={busy}>Rotate access code</button>
                          </form>
                          {snapshot.room.accessCodeEnabled && <button className="danger-quiet" type="button" onClick={onDisableAccessCode} disabled={busy}>Disable access code</button>}
                        </section>

                        <section className="panel-card">
                          <div className="card-heading"><div><p className="eyebrow">Invite</p><h2>Create Invitation</h2></div></div>
                          <form onSubmit={onCreateInvitation}>
                            <label className="field-label" htmlFor="invitation-role">Invitation role</label>
                            <select id="invitation-role" className="text-input" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as 'human' | 'agent' | 'observer')}><option value="human">Human</option><option value="agent">Agent</option><option value="observer">Observer</option></select>
                            <label className="field-label" htmlFor="invitation-name">Name (optional)</label>
                            <input id="invitation-name" className="text-input" aria-label="Invitation name (optional)" value={inviteName} onChange={(event) => setInviteName(event.target.value)} maxLength={60} />
                            <div className="split-fields">
                              <div><label className="field-label" htmlFor="invitation-uses">Uses</label><input id="invitation-uses" className="text-input" type="number" min={1} max={100} value={inviteMaxUses} onChange={(event) => setInviteMaxUses(event.target.value)} required /></div>
                              <div><label className="field-label" htmlFor="invitation-expiry">Expires in seconds</label><input id="invitation-expiry" className="text-input" type="number" min={1} max={86400} value={inviteExpiry} onChange={(event) => setInviteExpiry(event.target.value)} required /></div>
                            </div>
                            <button className="primary-button" type="submit" disabled={busy}>Create invitation</button>
                          </form>
                          {invitationToken && <div className="secret-result"><label className="field-label" htmlFor="invitation-token">Invitation token</label><input id="invitation-token" className="text-input secret-input" value={invitationToken} readOnly /><button className="small-button" type="button" onClick={() => setInvitationToken('')}>Hide invitation token</button></div>}
                        </section>
                      </div>
                    )}
                  </aside>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="page-heading"><p className="eyebrow">A shared space for people and agents</p><h1>Rooms</h1><p>Create a room or join an existing one. Membership is a server snapshot; live chat shows who is actually connected.</p></div>
              <div className="entry-grid">
                <section className="form-card" aria-labelledby="create-room-heading">
                  <div className="card-heading"><div><p className="eyebrow">Start a workspace</p><h2 id="create-room-heading">Create a room</h2></div><span className="card-symbol" aria-hidden="true">＋</span></div>
                  <form aria-label="Create room" onSubmit={onCreateRoom}>
                    <label className="field-label" htmlFor="room-name">Room name</label>
                    <input id="room-name" className="text-input" value={roomName} onChange={(event) => setRoomName(event.target.value)} required maxLength={80} />
                    <label className="field-label" htmlFor="owner-name">Owner name</label>
                    <input id="owner-name" className="text-input" value={ownerName} onChange={(event) => setOwnerName(event.target.value)} required maxLength={60} />
                    <label className="field-label" htmlFor="access-code">Access code (8 characters)</label>
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                      <button type="button" className="small-button" onClick={() => { setAccessCodeMode('generate'); setAccessCode(Math.random().toString(36).slice(2, 10)); }}>Generate new</button>
                      <button type="button" className="small-button" onClick={() => setAccessCodeMode('custom')}>Custom</button>
                    </div>
                    <input id="access-code" className="text-input" type="text" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} required minLength={8} maxLength={128} readOnly={accessCodeMode === 'generate'} />
                    <p className="field-hint">The code lets people request access. It never grants owner rights.</p>
                    <button className="primary-button" type="submit" disabled={busy || connection !== 'connected'}>{busy ? 'Creating…' : 'Create room'}</button>
                  </form>
                </section>

                <section className="form-card" aria-labelledby="join-room-heading">
                  <div className="card-heading"><div><p className="eyebrow">Use a room credential</p><h2 id="join-room-heading">Join a room</h2></div><span className="card-symbol" aria-hidden="true">↗</span></div>
                  <form aria-label="Join room" onSubmit={onJoinRoom}>
                    <label className="field-label" htmlFor="join-room-id">Room ID</label>
                    <input id="join-room-id" className="text-input" value={joinRoomId} onChange={(event) => setJoinRoomId(event.target.value)} required autoComplete="off" />
                    <p className="field-hint">Use the room ID and either its access code or an invitation token.</p>
                    <label className="field-label" htmlFor="join-name">Your name</label>
                    <input id="join-name" className="text-input" value={joinName} onChange={(event) => setJoinName(event.target.value)} required maxLength={60} />
                    <label className="field-label" htmlFor="participant-kind">Participant type</label>
                    <select id="participant-kind" className="text-input" value={joinKind} onChange={(event) => setJoinKind(event.target.value as ParticipantKind)}><option value="human">Human</option><option value="agent">Agent</option></select>
                    <label className="field-label" htmlFor="credential-type">Credential type</label>
                    <select id="credential-type" className="text-input" value={credentialType} onChange={(event) => { setCredentialType(event.target.value as CredentialType); setJoinCredential(''); }}><option value="access-code">Access code</option><option value="invitation">Invitation</option></select>
                    <label className="field-label" htmlFor="join-credential">{credentialType === 'access-code' ? 'Access code to join' : 'Invitation token'}</label>
                    <input id="join-credential" className="text-input" type="password" autoComplete="off" value={joinCredential} onChange={(event) => setJoinCredential(event.target.value)} required />
                    <button className="primary-button" type="submit" disabled={busy || connection !== 'connected'}>{busy ? 'Joining…' : 'Join room'}</button>
                  </form>
                </section>

                <section className="form-card recovery-card" aria-labelledby="recovery-heading">
                  <div className="card-heading"><div><p className="eyebrow">Owner recovery</p><h2 id="recovery-heading">Recover owner access</h2></div><span className="card-symbol" aria-hidden="true">⌁</span></div>
                  <form aria-label="Recover owner access" onSubmit={onRecoverOwner}>
                    <label className="field-label" htmlFor="recovery-room-id">Room ID to recover</label>
                    <input id="recovery-room-id" className="text-input" value={recoveryRoomId} onChange={(event) => setRecoveryRoomId(event.target.value)} required autoComplete="off" />
                    <label className="field-label" htmlFor="recovery-owner-key">Owner key for recovery</label>
                    <input id="recovery-owner-key" className="text-input" type="password" autoComplete="off" value={recoveryKey} onChange={(event) => setRecoveryKey(event.target.value)} required />
                    <p className="field-hint">The owner key is only for recovery. It is not stored by this page.</p>
                    <button className="primary-button" type="submit" disabled={busy || connection !== 'connected'}>{busy ? 'Recovering…' : 'Recover owner access'}</button>
                  </form>
                </section>
              </div>
            </>
          )}
        </section>

        <aside className="details-panel" aria-label="Room information">
          <p className="eyebrow">Room snapshot</p><p className="sidebar-note">No participant or agent activity is simulated.</p>
          {snapshot && <dl className="room-facts"><div><dt>Access mode</dt><dd>{modeLabel(snapshot.room.mode)}</dd></div><div><dt>Access code</dt><dd>{snapshot.room.accessCodeEnabled ? 'Enabled' : 'Disabled'}</dd></div><div><dt>Expires</dt><dd>{new Date(snapshot.room.expiresAt).toLocaleString()}</dd></div><div><dt>Your role</dt><dd>{snapshot.self.role}</dd></div></dl>}
        </aside>
      </div>
    </main>
  );
}
