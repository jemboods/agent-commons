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

const SHORTENER_INVITE_URL = 'https://go.doloresblick1.workers.dev/api/shorten-invite';

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
            <div className="room-view">
              <div className="page-heading room-title-row">
                <div>
                  <p className="eyebrow">Room snapshot · {modeLabel(snapshot.room.mode)}</p>
                  <h1>{snapshot.room.name}</h1>
                  <p className="room-id">Room ID: {snapshot.room.id}</p>
                  {snapshot.room.description && <p>{snapshot.room.description}</p>}
                </div>
                <button className="secondary-button" type="button" onClick={refreshSnapshot} disabled={busy}>{busy ? 'Working…' : 'Refresh roster'}</button>
              </div>

              {ownerKey && !keySaved && (
                <section className="secret-card" aria-labelledby="owner-key-heading">
                  <p id="owner-key-heading" className="eyebrow">Owner key — shown once</p>
                  <p>Keep this key somewhere safe. It is needed to recover owner access.</p>
                  <label className="field-label" htmlFor="owner-key">Owner key</label>
                  <input id="owner-key" className="text-input secret-input" value={ownerKey} readOnly />
                  <button className="small-button" type="button" onClick={dismissOwnerKey}>I saved the owner key</button>
                </section>
              )}
              {isOwner && createdAccessCode && (
                <section className="secret-card" aria-labelledby="invite-link-heading">
                  <p id="invite-link-heading" className="eyebrow">Shareable invite link</p>
                  <p>Send this short link to participants so they can join automatically with the room ID and access code pre-filled.</p>
                  <label className="field-label" htmlFor="invite-link">Invite link</label>
                  <input id="invite-link" className="text-input secret-input" value={inviteDisplayUrl ?? ''} readOnly />
                  <button className="small-button" type="button" onClick={() => {
                    if (!inviteDisplayUrl) return;
                    navigator.clipboard.writeText(inviteDisplayUrl);
                    setNotice('Invite link copied to clipboard.');
                  }}>Copy invite link</button>
                </section>
              )}
              {keySaved && <p className="notice">Owner key hidden. It will not be shown again.</p>}
              {isOwner && <p className="notice subtle-notice">Your owner session is held only in this page&apos;s memory.</p>}

              <section className="panel-card chat-card" aria-labelledby="chat-heading">
                <div className="card-heading">
                  <div><p className="eyebrow">Live only · no history</p><h2 id="chat-heading">Room chat</h2></div>
                  <span className={`chat-status ${chat.status}`} data-chat-status={chat.status}>{chatStatusLabel(chat.status)}</span>
                </div>
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
                <p className="field-hint">Messages exist only while connections are live. Nothing is stored, replayed, or retried after a reconnect.</p>
                {chat.status === 'closed' && (
                  <div className="chat-reconnect">
                    <p className="field-hint">The live connection closed{chat.closeReason ? ` (${chat.closeReason})` : ''}.</p>
                    <button className="small-button" type="button" onClick={chat.reconnect}>Reconnect live chat</button>
                  </div>
                )}
                <ol className="timeline" aria-label="Live timeline">
                  {chat.messages.length === 0 && <li className="timeline-empty">No live messages yet.</li>}
                  {chat.messages.map((message) => {
                    const quoted = message.replyTo ? chat.messages.find((item) => item.id === message.replyTo) : undefined;
                    return (
                      <li className="timeline-item" key={message.id} data-testid="chat-message">
                        <div className="timeline-meta">
                          <strong>{message.from.name}</strong>
                          <span>{message.from.kind}</span>
                          {message.broadcast && <span className="broadcast-badge">Broadcast</span>}
                          <time dateTime={message.ts}>{new Date(message.ts).toLocaleTimeString()}</time>
                        </div>
                        {message.replyTo && <blockquote className="reply-quote">Replying to {quoted ? `${quoted.from.name}: ${quoted.text.slice(0, 80)}` : 'an earlier message'}</blockquote>}
                        <p className="timeline-text">{message.text}</p>
                        {message.mentions && message.mentions.length > 0 && (
                          <p className="mention-line">Mentions: {message.mentions.map((id) => snapshot.participants.find((participant) => participant.id === id)?.name ?? 'unknown participant').join(', ')}</p>
                        )}
                        <button className="small-button" type="button" aria-label={`Reply to message from ${message.from.name}`} onClick={() => setReplyTarget(message)}>Reply</button>
                        {canControl && <button className="small-button" type="button" aria-label={`Pin message from ${message.from.name}`} onClick={() => chat.sendControl({ action: 'pin', messageId: message.id, text: message.text })}>Pin</button>}
                      </li>
                    );
                  })}
                </ol>
                {typingNames.length > 0 && <p className="typing-line" aria-live="polite">{typingNames.join(', ')} {typingNames.length === 1 ? 'is' : 'are'} typing…</p>}
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
                    <label className="field-label" htmlFor="chat-message-text">Message</label>
                    <textarea id="chat-message-text" className="text-input textarea" rows={3} maxLength={32000} value={chatText} onChange={(event) => { setChatText(event.target.value); chat.notifyTyping(); }} placeholder="Plain text only. Markdown and links stay inert." />
                    {isOwner && <button className="small-button" type="button" aria-pressed={broadcastMode} onClick={() => setBroadcastMode((value) => !value)}>Broadcast</button>}
                    {broadcastMode && isOwner && <p className="field-hint">Broadcast mode: the next send is an owner announcement, delivered even while the room is paused.</p>}
                    <button className="primary-button" type="submit" disabled={!chatText.trim()}>Send message</button>
                  </form>
                ) : (
                  chat.status === 'live' && <p className="field-hint">You are an observer in this room: live messages are readable, sending is disabled.</p>
                )}
              </section>

              <section className="panel-card roster-card" aria-labelledby="roster-heading">
                <div className="card-heading"><div><p className="eyebrow">Membership only</p><h2 id="roster-heading">Participants <span className="count-pill">{snapshot.participants.length}/{snapshot.room.maxParticipants}</span></h2></div><span className="card-symbol" aria-hidden="true">◉</span></div>
                <p className="field-hint">Online status comes from each participant&apos;s live connection; the roster itself is a server snapshot of membership.</p>
                <ul className="participant-list">
                  {snapshot.participants.map((participant) => {
                    const draft = roleDrafts[participant.id] ?? { role: participant.role === 'owner' ? 'human' : participant.role, canInstruct: participant.canInstruct };
                    const online = onlineIds.has(participant.id);
                    return (
                      <li className="participant-row" key={participant.id}>
                        <div className="participant-identity">
                          <span className={`presence-dot ${online ? 'online' : 'offline'}`} role="img" aria-label={`${participant.name} ${online ? 'online' : 'offline'}`} />
                          <span className="avatar" aria-hidden="true">{participant.name.slice(0, 1).toUpperCase()}</span>
                          <div><strong>{participant.name} · {participant.role}</strong><span className="participant-meta">{participant.kind}{participant.id === snapshot.self.id ? ' · you' : ''}{chat.mutedIds.includes(participant.id) ? ' · muted' : ''}</span></div>
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
                            {draft.role === 'moderator' && <label className="saved-check compact-check"><input type="checkbox" checked={draft.canInstruct} onChange={(event) => updateRoleDraft(participant, { canInstruct: event.target.checked })} /><span>Can instruct</span></label>}
                            <button className="small-button" type="button" onClick={() => onSaveParticipant(participant)} disabled={busy} aria-label={`Save role for ${participant.name}`}>Save</button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>

              {isOwner && (
                <div className="management-grid">
                  <section className="panel-card" aria-labelledby="settings-heading">
                    <div className="card-heading"><div><p className="eyebrow">Owner controls</p><h2 id="settings-heading">Room settings</h2></div></div>
                    <form onSubmit={onSaveSettings}>
                      <label className="field-label" htmlFor="room-name-setting">Room name</label>
                      <input id="room-name-setting" className="text-input" aria-label="Room name setting" value={settingsName} onChange={(event) => setSettingsName(event.target.value)} required maxLength={80} />
                      <label className="field-label" htmlFor="room-description-setting">Description</label>
                      <textarea id="room-description-setting" className="text-input textarea" aria-label="Room description setting" value={settingsDescription} onChange={(event) => setSettingsDescription(event.target.value)} maxLength={500} rows={3} />
                      <label className="field-label" htmlFor="room-mode-setting">Access mode</label>
                      <select id="room-mode-setting" className="text-input" aria-label="Room access mode" value={settingsMode} onChange={(event) => setSettingsMode(event.target.value as RoomMode)}><option value="public">Public — access code or invite</option><option value="private">Private — invitation only</option><option value="hybrid">Hybrid — either credential</option></select>
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

                  <section className="panel-card" aria-labelledby="invitation-heading">
                    <div className="card-heading"><div><p className="eyebrow">One-time credential</p><h2 id="invitation-heading">Invite a participant</h2></div></div>
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

              <div className="room-footer-actions">
                {!isOwner && <button className="secondary-button" type="button" onClick={onLeaveRoom} disabled={busy}>Leave room</button>}
                {isOwner && <button className="danger-button" type="button" onClick={onDeleteRoom} disabled={busy}>Delete room</button>}
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
