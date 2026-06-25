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

export interface ReactionMapping {
  matrixReactionEventId: string;
  threemaMessageId: string;    // Threema message ID the reaction is on
  roomId: string;
  emoji: string;
  senderGhostId: string;       // ghost user who sent the reaction on Matrix
}

interface StateData {
  rooms: RoomMapping[];
  messages: MessageMapping[];
  reactions?: ReactionMapping[];
}

export class BridgeState {
  private stateDir: string;
  private stateFile: string;
  private rooms: Map<string, RoomMapping> = new Map();       // roomId -> mapping
  private roomsByThreemaId: Map<string, string> = new Map(); // threemaId -> roomId
  private roomsByGroupKey: Map<string, string> = new Map();  // "creator/groupIdHex" -> roomId
  private messages: MessageMapping[] = [];
  private reactions: ReactionMapping[] = [];
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
          } else if (room.groupCreator && room.groupId) {
            this.roomsByGroupKey.set(`${room.groupCreator}/${room.groupId}`, room.roomId);
          }
        }
        this.messages = data.messages ?? [];
        this.reactions = data.reactions ?? [];
        console.log(`[state] Loaded ${this.rooms.size} rooms, ${this.messages.length} message mappings, ${this.reactions.length} reaction mappings`);
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
        reactions: this.reactions.slice(-5000), // Keep last 5k reactions
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
    } else if (mapping.groupCreator && mapping.groupId) {
      this.roomsByGroupKey.set(`${mapping.groupCreator}/${mapping.groupId}`, mapping.roomId);
    }
    this.dirty = true;
  }

  getRoomForGroup(groupCreator: string, groupIdHex: string): string | undefined {
    return this.roomsByGroupKey.get(`${groupCreator}/${groupIdHex}`);
  }

  getGroupMapping(roomId: string): RoomMapping | undefined {
    const m = this.rooms.get(roomId);
    return m?.isGroup ? m : undefined;
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

  getMessageMapping(threemaMessageId: string): MessageMapping | undefined {
    return this.messages.find(m => m.threemaMessageId === threemaMessageId);
  }

  getMessageMappingByMatrixId(matrixEventId: string): MessageMapping | undefined {
    return this.messages.find(m => m.matrixEventId === matrixEventId);
  }

  addReactionMapping(mapping: ReactionMapping): void {
    this.reactions.push(mapping);
    this.dirty = true;
  }

  findReaction(threemaMessageId: string, emoji: string, senderGhostId: string): ReactionMapping | undefined {
    return this.reactions.find(
      r => r.threemaMessageId === threemaMessageId && r.emoji === emoji && r.senderGhostId === senderGhostId,
    );
  }

  removeReaction(matrixReactionEventId: string): void {
    this.reactions = this.reactions.filter(r => r.matrixReactionEventId !== matrixReactionEventId);
    this.dirty = true;
  }
}
