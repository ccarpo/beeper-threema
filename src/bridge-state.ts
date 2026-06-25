/**
 * Bridge state persistence.
 * 
 * Tracks room-to-contact mappings and message ID correlations.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RoomMapping {
  roomId: string;
  threemaId: string;       // Threema identity (8 chars) for DMs
  isGroup: boolean;
  groupCreator?: string;   // For group chats
  groupId?: string;        // hex-encoded 8-byte group ID
  members?: string[];      // For group chats
}

export interface MessageMapping {
  matrixEventId: string;
  threemaMessageId: string;  // bigint as string
  roomId: string;
  timestamp: number;
}

interface StateData {
  rooms: RoomMapping[];
  messages: MessageMapping[];
}

export class BridgeState {
  private stateDir: string;
  private stateFile: string;
  private rooms: Map<string, RoomMapping> = new Map();       // roomId -> mapping
  private roomsByThreemaId: Map<string, string> = new Map(); // threemaId -> roomId
  private messages: MessageMapping[] = [];
  private dirty = false;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.stateFile = path.join(stateDir, 'bridge-state.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data: StateData = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
        for (const room of data.rooms ?? []) {
          this.rooms.set(room.roomId, room);
          if (!room.isGroup) {
            this.roomsByThreemaId.set(room.threemaId, room.roomId);
          }
        }
        this.messages = data.messages ?? [];
        console.log(`[state] Loaded ${this.rooms.size} rooms, ${this.messages.length} message mappings`);
      }
    } catch (err) {
      console.warn(`[state] Failed to load state: ${err}`);
    }
  }

  save(): void {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      const data: StateData = {
        rooms: Array.from(this.rooms.values()),
        messages: this.messages.slice(-10000), // Keep last 10k mappings
      };
      fs.writeFileSync(this.stateFile, JSON.stringify(data, null, 2));
      this.dirty = false;
    } catch (err) {
      console.error(`[state] Failed to save state: ${err}`);
    }
  }

  getRoomForThreemaId(threemaId: string): string | undefined {
    return this.roomsByThreemaId.get(threemaId.toUpperCase());
  }

  getRoomMapping(roomId: string): RoomMapping | undefined {
    return this.rooms.get(roomId);
  }

  setRoomMapping(mapping: RoomMapping): void {
    this.rooms.set(mapping.roomId, mapping);
    if (!mapping.isGroup) {
      this.roomsByThreemaId.set(mapping.threemaId.toUpperCase(), mapping.roomId);
    }
    this.dirty = true;
  }

  addMessageMapping(mapping: MessageMapping): void {
    this.messages.push(mapping);
    this.dirty = true;
    // Auto-save every 50 messages
    if (this.messages.length % 50 === 0) {
      this.save();
    }
  }

  getThreemaMessageId(matrixEventId: string): string | undefined {
    return this.messages.find(m => m.matrixEventId === matrixEventId)?.threemaMessageId;
  }

  getMatrixEventId(threemaMessageId: string): string | undefined {
    return this.messages.find(m => m.threemaMessageId === threemaMessageId)?.matrixEventId;
  }
}
