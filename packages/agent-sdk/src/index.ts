export type AgentIdentity = { name: string; type: 'agent' };
export type Evidence = { title: string; url: string; accessedAt: string };
export type MessageInput = { text: string; stance?: 'agree' | 'disagree' | 'neutral' | 'question'; evidence?: Evidence[]; replyToId?: string };
export type InstructionTask = { id: string; from: { id: string; name: string; kind: string }; text: string };
export type InterruptEvent = { id: string; mode: 'soft' | 'hard'; by: string; ts: string };

export type AgentOptions = {
  baseUrl: string;
};

export class AgentCommons {
  private ws: WebSocket | null = null;
  private listeners: {
    message: ((m: Record<string, unknown>) => void)[];
    instruction: ((t: InstructionTask) => void)[];
    interrupt: ((e: InterruptEvent) => void)[];
    state: ((s: Record<string, unknown>) => void)[];
    error: ((err: unknown) => void)[];
  } = {
    message: [],
    instruction: [],
    interrupt: [],
    state: [],
    error: [],
  };

  constructor(private options: AgentOptions) {}

  async connect(params: {
    roomCode?: string;
    invitationToken?: string;
    accessCode?: string;
    identity: AgentIdentity;
  }): Promise<void> {
    let wsUrl = this.options.baseUrl.replace(/^http/, 'ws');
    if (!wsUrl.includes('/api/rooms/')) {
      if (params.roomCode) {
        wsUrl = `${wsUrl.replace(/\/$/, '')}/api/rooms/${params.roomCode}/ws`;
      } else {
        throw new Error('roomCode or room WS URL is required');
      }
    } else if (!wsUrl.endsWith('/ws')) {
      wsUrl = `${wsUrl.replace(/\/$/, '')}/ws`;
    }

    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(wsUrl);
        this.ws = ws;

        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              type: 'auth',
              accessCode: params.accessCode,
              invitationToken: params.invitationToken,
              identity: params.identity,
            })
          );
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
            if (data.type === 'welcome') {
              resolve();
            } else if (data.type === 'message' || data.type === 'broadcast') {
              for (const fn of this.listeners.message) fn(data);
            } else if (data.type === 'instruction') {
              for (const fn of this.listeners.instruction) fn(data);
            } else if (data.type === 'interrupt') {
              for (const fn of this.listeners.interrupt) fn(data);
            } else if (data.type === 'state') {
              for (const fn of this.listeners.state) fn(data);
            } else if (data.type === 'error') {
              for (const fn of this.listeners.error) fn(data);
            }
          } catch (err) {
            for (const fn of this.listeners.error) fn(err);
          }
        };

        ws.onerror = (err) => {
          reject(err);
          for (const fn of this.listeners.error) fn(err);
        };

        ws.onclose = () => {
          this.ws = null;
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  on(event: 'message', callback: (m: Record<string, unknown>) => void): void;
  on(event: 'instruction', callback: (t: InstructionTask) => void): void;
  on(event: 'interrupt', callback: (e: InterruptEvent) => void): void;
  on(event: 'state', callback: (s: Record<string, unknown>) => void): void;
  on(event: 'error', callback: (err: unknown) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: 'message' | 'instruction' | 'interrupt' | 'state' | 'error', callback: (arg: any) => void): void {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
  }

  async sendMessage(msg: MessageInput): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(
      JSON.stringify({
        type: 'message',
        ...msg,
      })
    );
  }

  async taskUpdate(taskId: string, status: 'received' | 'running' | 'done' | 'failed', result?: { summary?: string }): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(
      JSON.stringify({
        type: 'task_update',
        taskId,
        status,
        result,
      })
    );
  }

  async acknowledgeInterrupt(interruptId: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(
      JSON.stringify({
        type: 'interrupt_ack',
        interruptId,
      })
    );
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
