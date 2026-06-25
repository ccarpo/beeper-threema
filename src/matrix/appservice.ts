/**
 * Matrix Appservice HTTP server.
 * 
 * This implements the Matrix Application Service API that bbctl proxy
 * will forward events to via HTTP on localhost. The appservice receives
 * Matrix events (messages from Beeper) and translates them to Threema,
 * and vice versa.
 */

import express, { type Request, type Response } from 'express';

export interface AppserviceConfig {
  port: number;
  hsToken: string;  // from registration.yaml
  asToken: string;  // from registration.yaml
  homeserverUrl: string;
  botUserId: string;  // e.g. @sh-threemabot:beeper.local
  userId: string;     // e.g. @ccarpo:beeper.com
  userAccessToken: string; // real user's access token for joining rooms
  userPrefix: string; // e.g. @sh-threema_
  userSuffix: string; // e.g. :beeper.local
}

export interface MatrixEvent {
  type: string;
  room_id: string;
  sender: string;
  event_id: string;
  content: Record<string, unknown>;
  origin_server_ts: number;
  state_key?: string;
  redacts?: string;
}

export type MessageHandler = (event: MatrixEvent) => Promise<void>;

export class MatrixAppservice {
  private app: express.Express;
  private config: AppserviceConfig;
  private messageHandler: MessageHandler | null = null;
  private receiptHandler: ((event: MatrixEvent) => Promise<void>) | null = null;
  private reactionHandler: ((event: MatrixEvent) => Promise<void>) | null = null;
  private redactionHandler: ((event: MatrixEvent) => Promise<void>) | null = null;
  private typingHandler: ((roomId: string, userId: string, isTyping: boolean) => Promise<void>) | null = null;
  private server: ReturnType<typeof this.app.listen> | null = null;

  constructor(config: AppserviceConfig) {
    this.config = config;
    this.app = express();
    this.app.use(express.json({ limit: '50mb' }));
    this.setupRoutes();
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onReceipt(handler: (event: MatrixEvent) => Promise<void>): void {
    this.receiptHandler = handler;
  }

  onTyping(handler: (roomId: string, userId: string, isTyping: boolean) => Promise<void>): void {
    this.typingHandler = handler;
  }

  onReaction(handler: (event: MatrixEvent) => Promise<void>): void {
    this.reactionHandler = handler;
  }

  onRedaction(handler: (event: MatrixEvent) => Promise<void>): void {
    this.redactionHandler = handler;
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/_matrix/app/v1/ping', (_req: Request, res: Response) => {
      res.json({});
    });

    // Transactions from homeserver (via bbctl proxy)
    this.app.put('/_matrix/app/v1/transactions/:txnId', async (req: Request, res: Response) => {
      const authHeader = req.headers.authorization;
      const token = authHeader?.replace('Bearer ', '') ?? req.query.access_token;
      
      if (token !== this.config.hsToken) {
        console.warn('[appservice] Unauthorized transaction request');
        res.status(403).json({ errcode: 'M_FORBIDDEN' });
        return;
      }

      const events: MatrixEvent[] = req.body?.events ?? [];
      
      for (const event of events) {
        try {
          await this.handleEvent(event);
        } catch (err) {
          console.error('[appservice] Error handling event:', err);
        }
      }

      res.json({});
    });

    // User query (do we know this user?)
    this.app.get('/_matrix/app/v1/users/:userId', (req: Request, res: Response) => {
      const userId = req.params.userId;
      if (userId.startsWith(this.config.userPrefix)) {
        res.json({});
      } else {
        res.status(404).json({ errcode: 'M_NOT_FOUND' });
      }
    });

    // Room alias query
    this.app.get('/_matrix/app/v1/rooms/:roomAlias', (_req: Request, res: Response) => {
      res.status(404).json({ errcode: 'M_NOT_FOUND' });
    });
  }

  private async handleEvent(event: MatrixEvent): Promise<void> {
    // Skip events from our own ghosts
    if (event.sender.startsWith(this.config.userPrefix)) {
      return;
    }
    // Skip events from the bridge bot itself
    if (event.sender === this.config.botUserId) {
      return;
    }

    if (event.type === 'm.room.message') {
      console.log(`[appservice] Message from ${event.sender} in ${event.room_id}: ${JSON.stringify(event.content).slice(0, 100)}`);
      if (this.messageHandler) {
        await this.messageHandler(event);
      }
    } else if (event.type === 'm.reaction') {
      if (this.reactionHandler) {
        await this.reactionHandler(event);
      }
    } else if (event.type === 'm.room.redaction') {
      if (this.redactionHandler) {
        await this.redactionHandler(event);
      }
    } else if (event.type === 'm.receipt') {
      if (this.receiptHandler) {
        await this.receiptHandler(event);
      }
    } else if (event.type === 'm.typing') {
      // Typing events come as EDUs with content.user_ids
      const userIds = (event.content.user_ids ?? []) as string[];
      const isUserTyping = userIds.includes(this.config.userId);
      if (this.typingHandler) {
        await this.typingHandler(event.room_id, this.config.userId, isUserTyping);
      }
    } else if (event.type === 'm.room.member') {
      // Handle invites to the bridge bot
      if (event.state_key === this.config.botUserId && event.content.membership === 'invite') {
        console.log(`[appservice] Bot invited to ${event.room_id} by ${event.sender}`);
        await this.joinRoom(event.room_id);
      }
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.config.port, () => {
        console.log(`[appservice] Listening on port ${this.config.port}`);
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.close();
  }

  // ─── Matrix Client-Server API helpers (used to send events) ──────────────────

  async sendMessage(roomId: string, content: Record<string, unknown>): Promise<string | null> {
    const txnId = `m${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const url = `${this.config.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`;
    
    try {
      const resp = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.config.asToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(content),
      });

      if (!resp.ok) {
        const body = await resp.text();
        console.error(`[appservice] Failed to send message: ${resp.status} ${body}`);
        return null;
      }

      const result = await resp.json() as { event_id: string };
      return result.event_id;
    } catch (err) {
      console.error('[appservice] Error sending message:', err);
      return null;
    }
  }

  async sendMessageAs(roomId: string, userId: string, content: Record<string, unknown>): Promise<string | null> {
    const txnId = `m${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const url = `${this.config.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}?user_id=${encodeURIComponent(userId)}`;

    try {
      const resp = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.config.asToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(content),
      });

      if (!resp.ok) {
        const body = await resp.text();
        console.error(`[appservice] Failed to send message as ${userId}: ${resp.status} ${body}`);
        return null;
      }

      const result = await resp.json() as { event_id: string };
      return result.event_id;
    } catch (err) {
      console.error(`[appservice] Error sending message as ${userId}:`, err);
      return null;
    }
  }

  async joinRoom(roomId: string): Promise<void> {
    const url = `${this.config.homeserverUrl}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.asToken}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      if (!resp.ok) {
        const body = await resp.text();
        console.error(`[appservice] Failed to join room: ${resp.status} ${body}`);
      }
    } catch (err) {
      console.error('[appservice] Error joining room:', err);
    }
  }

  async joinRoomAs(roomId: string, userId: string): Promise<void> {
    const url = `${this.config.homeserverUrl}/_matrix/client/v3/join/${encodeURIComponent(roomId)}?user_id=${encodeURIComponent(userId)}`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.asToken}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      if (!resp.ok) {
        const body = await resp.text();
        console.error(`[appservice] Failed to join room as ${userId}: ${resp.status} ${body}`);
      } else {
        console.log(`[appservice] Ghost ${userId} joined room ${roomId}`);
      }
    } catch (err) {
      console.error(`[appservice] Error joining room as ${userId}:`, err);
    }
  }

  async createRoom(options: {
    name?: string;
    invite?: string[];
    is_direct?: boolean;
    preset?: string;
    initial_state?: Array<{ type: string; content: Record<string, unknown> }>;
  }): Promise<string | null> {
    const url = `${this.config.homeserverUrl}/_matrix/client/v3/createRoom`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.asToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(options),
      });
      if (!resp.ok) {
        const body = await resp.text();
        console.error(`[appservice] Failed to create room: ${resp.status} ${body}`);
        return null;
      }
      const result = await resp.json() as { room_id: string };
      console.log(`[appservice] Created room ${result.room_id} (invite: ${options.invite?.join(', ')}, is_direct: ${options.is_direct})`);
      return result.room_id;
    } catch (err) {
      console.error('[appservice] Error creating room:', err);
      return null;
    }
  }

  async createRoomAs(userId: string, options: {
    name?: string;
    invite?: string[];
    is_direct?: boolean;
    preset?: string;
    initial_state?: Array<{ type: string; content: Record<string, unknown> }>;
  }): Promise<string | null> {
    const url = `${this.config.homeserverUrl}/_matrix/client/v3/createRoom?user_id=${encodeURIComponent(userId)}`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.asToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(options),
      });
      if (!resp.ok) {
        const body = await resp.text();
        console.error(`[appservice] Failed to create room as ${userId}: ${resp.status} ${body}`);
        return null;
      }
      const result = await resp.json() as { room_id: string };
      return result.room_id;
    } catch (err) {
      console.error(`[appservice] Error creating room as ${userId}:`, err);
      return null;
    }
  }

  async sendMessageAsRealUser(roomId: string, content: Record<string, unknown>): Promise<string | null> {
    const txnId = `m${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const url = `${this.config.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`;
    try {
      const resp = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.config.userAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(content),
      });
      if (!resp.ok) {
        const body = await resp.text();
        console.error(`[appservice] Failed to send as real user: ${resp.status} ${body}`);
        return null;
      }
      const result = await resp.json() as { event_id: string };
      return result.event_id;
    } catch (err) {
      console.error('[appservice] Error sending as real user:', err);
      return null;
    }
  }

  async joinRoomAsRealUser(roomId: string): Promise<void> {
    // Use the real user's access token to accept the room invite
    const url = `${this.config.homeserverUrl}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.userAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      if (!resp.ok) {
        const body = await resp.text();
        console.error(`[appservice] Failed to join room as real user: ${resp.status} ${body}`);
      } else {
        console.log(`[appservice] Real user joined room ${roomId}`);
      }
    } catch (err) {
      console.error(`[appservice] Error joining room as real user:`, err);
    }
  }

  async setDisplayName(userId: string, displayName: string): Promise<void> {
    const url = `${this.config.homeserverUrl}/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname?user_id=${encodeURIComponent(userId)}`;
    try {
      await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.config.asToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ displayname: displayName }),
      });
    } catch (err) {
      console.error(`[appservice] Error setting display name for ${userId}:`, err);
    }
  }

  /** Convert a Threema ID to a Matrix user ID ghost */
  threemaIdToMatrixUser(threemaId: string): string {
    return `${this.config.userPrefix}${threemaId.toLowerCase()}${this.config.userSuffix}`;
  }

  /** Extract Threema ID from a ghost Matrix user ID */
  matrixUserToThreemaId(userId: string): string | null {
    if (!userId.startsWith(this.config.userPrefix) || !userId.endsWith(this.config.userSuffix)) {
      return null;
    }
    const id = userId.slice(this.config.userPrefix.length, userId.length - this.config.userSuffix.length);
    if (/^[a-z0-9*]{8}$/.test(id)) {
      return id.toUpperCase();
    }
    return null;
  }

  async sendReadReceiptAs(roomId: string, eventId: string, userId: string): Promise<void> {
    const url = `${this.config.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}?user_id=${encodeURIComponent(userId)}`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.asToken}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      if (!resp.ok) {
        const body = await resp.text();
        console.error(`[appservice] Failed to send read receipt as ${userId}: ${resp.status} ${body}`);
      }
    } catch (err) {
      console.error(`[appservice] Error sending read receipt as ${userId}:`, err);
    }
  }

  async sendTypingAs(roomId: string, userId: string, isTyping: boolean, timeoutMs = 15000): Promise<void> {
    const url = `${this.config.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}?user_id=${encodeURIComponent(userId)}`;
    try {
      const resp = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.config.asToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ typing: isTyping, timeout: isTyping ? timeoutMs : undefined }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        console.error(`[appservice] Failed to send typing as ${userId}: ${resp.status} ${body}`);
      }
    } catch (err) {
      console.error(`[appservice] Error sending typing as ${userId}:`, err);
    }
  }

  async setRoomName(roomId: string, name: string): Promise<void> {
    const url = `${this.config.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`;
    try {
      const resp = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.config.asToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        console.error(`[appservice] Failed to set room name: ${resp.status} ${body}`);
      }
    } catch (err) {
      console.error(`[appservice] Error setting room name:`, err);
    }
  }

  async sendReactionAs(roomId: string, eventId: string, emoji: string, userId: string): Promise<string | null> {
    const txnId = `r${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const url = `${this.config.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${txnId}?user_id=${encodeURIComponent(userId)}`;
    try {
      const resp = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.config.asToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          'm.relates_to': {
            rel_type: 'm.annotation',
            event_id: eventId,
            key: emoji,
          },
        }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        console.error(`[appservice] Failed to send reaction as ${userId}: ${resp.status} ${body}`);
        return null;
      }
      const result = await resp.json() as { event_id: string };
      return result.event_id;
    } catch (err) {
      console.error(`[appservice] Error sending reaction as ${userId}:`, err);
      return null;
    }
  }

  async redactEventAs(roomId: string, eventId: string, userId: string, reason?: string): Promise<void> {
    const txnId = `x${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const url = `${this.config.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${txnId}?user_id=${encodeURIComponent(userId)}`;
    try {
      const resp = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.config.asToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        console.error(`[appservice] Failed to redact as ${userId}: ${resp.status} ${body}`);
      }
    } catch (err) {
      console.error(`[appservice] Error redacting as ${userId}:`, err);
    }
  }
}
