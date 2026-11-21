import { useCallback, useEffect, useRef, useState } from 'react';
import type { ParticipantKind } from './api';

export type ChatMessage = {
  id: string;
  from: { id: string; name: string; kind: ParticipantKind };
  ts: string;
  text: string;
  replyTo?: string;
  mentions?: string[];
};
export type ChatStatus = 'idle' | 'connecting' | 'live' | 'closed';
export type ChatErrorCode = 'FORBIDDEN' | 'RATE_LIMITED' | 'UNAUTHORIZED' | 'INVALID_MESSAGE' | 'SOCKET_ERROR';

const MAX_LIVE_MESSAGES = 200;
const TYPING_FRAME_MS = 2_000;
const TYPING_VISIBLE_MS = 3_000;

export type ChatOptions = { roomId: string; sessionToken: string; active: boolean };

/**
 * Live-only room chat over the room Durable Object. The session token stays in
 * component memory and is only sent inside the first join frame; there is no
 * retry queue, no replay, and nothing is written to browser storage.
 */
export function useRoomChat({ roomId, sessionToken, active }: ChatOptions) {
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [error, setError] = useState<ChatErrorCode | null>(null);
  const [closeReason, setCloseReason] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [online, setOnline] = useState<Record<string, boolean>>({});
  const [typing, setTyping] = useState<Record<string, number>>({});
  const socketRef = useRef<WebSocket | null>(null);
  const statusRef = useRef<ChatStatus>('idle');
  const lastTypingRef = useRef(0);
  const updateStatus = useCallback((next: ChatStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const connect = useCallback(() => {
    if (!active || !roomId || !sessionToken) return;
    socketRef.current?.close(1000, 'RECONNECT');
    setMessages([]);
    setOnline({});
    setTyping({});
    setError(null);
    setCloseReason('');
    updateStatus('connecting');

    const url = new URL(`/api/rooms/${encodeURIComponent(roomId)}/ws`, window.location.href);
    // The Vite dev server proxies HTTP but not the WebSocket upgrade, so loopback
    // development talks to the local Worker directly (its origin allowlist holds).
    if ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.port === '5173') url.port = '8787';
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    socketRef.current = socket;

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ v: 1, type: 'join', payload: { sessionToken } }));
    });
    socket.addEventListener('message', (messageEvent) => {
      if (socketRef.current !== socket) return;
      let event: Record<string, unknown>;
      try { event = JSON.parse(String(messageEvent.data)) as Record<string, unknown>; } catch { return; }
      if (event.type === 'welcome') {
        const payload = event.payload as { participants?: { id: string; online?: boolean }[] };
        const next: Record<string, boolean> = {};
        for (const participant of payload.participants ?? []) next[participant.id] = participant.online === true;
        setOnline(next);
        setError(null);
        updateStatus('live');
        return;
      }
      if (event.type === 'message') {
        const incoming: ChatMessage = {
          id: String(event.id),
          from: event.from as ChatMessage['from'],
          ts: String(event.ts),
          text: String((event.payload as { text?: unknown }).text ?? ''),
          replyTo: (event.payload as { replyTo?: string }).replyTo,
          mentions: (event.payload as { mentions?: string[] }).mentions,
        };
        setMessages((current) => [...current, incoming].slice(-MAX_LIVE_MESSAGES));
        return;
      }
      if (event.type === 'presence') {
        const payload = event.payload as { participantId: string; online: boolean };
        setOnline((current) => ({ ...current, [payload.participantId]: payload.online }));
        return;
      }
      if (event.type === 'typing') {
        const from = event.from as { id: string };
        setTyping((current) => ({ ...current, [from.id]: Date.now() + TYPING_VISIBLE_MS }));
        return;
      }
      if (event.type === 'error') {
        const code = (event.payload as { code?: string }).code;
        if (code === 'FORBIDDEN' || code === 'RATE_LIMITED') setError(code);
        return;
      }
    });
    socket.addEventListener('close', (event) => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      setTyping({});
      setOnline({});
      setCloseReason(event.reason || 'CLOSED');
      updateStatus('closed');
    });
    socket.addEventListener('error', () => {
      if (socketRef.current !== socket) return;
      setError('SOCKET_ERROR');
    });
  }, [active, roomId, sessionToken, updateStatus]);

  useEffect(() => {
    connect();
    return () => {
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close(1000, 'LEAVE');
    };
  }, [connect]);

  useEffect(() => {
    if (!messageCount(typing)) return;
    const timer = setInterval(() => {
      setTyping((current) => {
        const now = Date.now();
        const next: Record<string, number> = {};
        for (const [id, expiry] of Object.entries(current)) if (expiry > now) next[id] = expiry;
        return messageCount(next) === messageCount(current) ? current : next;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [typing]);

  const send = useCallback((text: string, options: { replyTo?: string; mentions?: string[] } = {}) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || statusRef.current !== 'live') return false;
    const payload = {
      text,
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      ...(options.mentions && options.mentions.length ? { mentions: options.mentions } : {}),
    };
    socket.send(JSON.stringify({ v: 1, type: 'message', payload }));
    return true;
  }, []);

  const notifyTyping = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || statusRef.current !== 'live') return;
    const now = Date.now();
    if (now - lastTypingRef.current < TYPING_FRAME_MS) return;
    lastTypingRef.current = now;
    socket.send(JSON.stringify({ v: 1, type: 'typing', payload: {} }));
  }, []);

  return { status, error, closeReason, messages, online, typing, send, notifyTyping, reconnect: connect };
}

function messageCount(record: Record<string, number>): number {
  return Object.keys(record).length;
}
