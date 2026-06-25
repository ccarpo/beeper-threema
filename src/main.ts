/**
 * beeper-threema-bridge — Main entry point.
 * 
 * Connects to Threema as a linked device (multi-device protocol) and
 * bridges messages to/from Matrix via the appservice API, designed for
 * use with `bbctl proxy`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from './config.js';
import { MatrixAppservice, type MatrixEvent } from './matrix/appservice.js';
import { BridgeState, type RoomMapping } from './bridge-state.js';
import { MediatorClient, type IdentityData } from './threema/mediator-client.js';
import { resolveThreemaIdentityPath } from './threema/runtime-paths.js';
import {
  decodeDeliveryReceiptBody,
  decodeReactionMessageBody,
  legacyDeliveryStatusToEmoji,
} from './threema/emoji-reactions.js';

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const config = loadConfig();
const state = new BridgeState(config.stateDir);
const appservice = new MatrixAppservice(config.appservice);

// Load Threema identity
const identityPath = resolveThreemaIdentityPath(config.threema.dataDir);
if (!fs.existsSync(identityPath)) {
  console.error(`\n❌ No Threema identity found at ${identityPath}`);
  console.error('   Run "npm run link-device" first to link your Threema account.\n');
  process.exit(1);
}

const identity: IdentityData = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
console.log(`[bridge] Threema ID: ${identity.identity} (linked ${identity.linkedAt})`);

// Load contacts for display names
let contacts: Array<{ identity: string; publicKey: string; firstName?: string; lastName?: string; nickname?: string }> = [];
const contactsPath = path.join(config.threema.dataDir, 'contacts.json');
if (fs.existsSync(contactsPath)) {
  contacts = JSON.parse(fs.readFileSync(contactsPath, 'utf-8'));
  console.log(`[bridge] Loaded ${contacts.length} Threema contacts`);
}

function getContactDisplayName(threemaId: string): string {
  const contact = contacts.find(c => c.identity.toUpperCase() === threemaId.toUpperCase());
  if (!contact) return threemaId;
  if (contact.nickname) return contact.nickname;
  const parts = [contact.firstName, contact.lastName].filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  return threemaId;
}

// Load groups
interface GroupInfo {
  groupIdHex: string;
  groupIdBytes: Uint8Array;
  creatorIdentity: string;
  name: string;
  members: string[];
}

const groups: Map<string, GroupInfo> = new Map(); // "creator/groupIdHex" -> GroupInfo

function longToBytes(long: { low: number; high: number }): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setUint32(0, long.low >>> 0, true);
  view.setUint32(4, long.high >>> 0, true);
  return buf;
}

const groupsPath = path.join(config.threema.dataDir, 'groups.json');
if (fs.existsSync(groupsPath)) {
  const rawGroups = JSON.parse(fs.readFileSync(groupsPath, 'utf-8')) as Array<{
    groupId: { low: number; high: number; unsigned?: boolean } | string;
    creatorIdentity: string;
    name?: string;
    members?: string[];
  }>;
  for (const g of rawGroups) {
    const idBytes = typeof g.groupId === 'string'
      ? Buffer.from(g.groupId, 'hex')
      : longToBytes(g.groupId as { low: number; high: number });
    const idHex = Buffer.from(idBytes).toString('hex');
    const creator = g.creatorIdentity.toUpperCase();
    const key = `${creator}/${idHex}`;
    groups.set(key, {
      groupIdHex: idHex,
      groupIdBytes: new Uint8Array(idBytes),
      creatorIdentity: creator,
      name: g.name ?? `Group ${idHex.slice(0, 8)}`,
      members: g.members ?? [],
    });
  }
  console.log(`[bridge] Loaded ${groups.size} Threema groups`);
}

function getGroupKey(creator: string, groupIdBytes: Uint8Array): string {
  return `${creator.toUpperCase()}/${Buffer.from(groupIdBytes).toString('hex')}`;
}

function getGroupInfo(creator: string, groupIdBytes: Uint8Array): GroupInfo | undefined {
  return groups.get(getGroupKey(creator, groupIdBytes));
}

// ─── Threema → Matrix ────────────────────────────────────────────────────────

const mediator = new MediatorClient({
  identity,
  dataDir: config.threema.dataDir,
  onEnvelope: async (envelope) => {
    try {
      await handleThreemaEnvelope(envelope);
    } catch (err) {
      console.error('[bridge] Error handling Threema envelope:', err);
    }
  },
});

async function handleThreemaEnvelope(envelope: any): Promise<void> {
  if (envelope.incomingMessage) {
    await handleIncomingMessage(envelope.incomingMessage);
  } else if (envelope.outgoingMessage) {
    await handleOutgoingMessage(envelope.outgoingMessage);
  }
}

async function handleIncomingMessage(msg: any): Promise<void> {
  const senderIdentity: string = msg.senderIdentity;
  const type: number = msg.type;
  const body: Uint8Array | undefined = msg.body;

  if (!body || body.length === 0) return;

  // Text message (DM)
  if (type === 0x01) {
    const text = new TextDecoder().decode(body);
    await bridgeIncomingText(senderIdentity, text, msg.messageId);
    return;
  }

  // Group text message
  if (type === 0x41 && body.length > 16) {
    const creator = new TextDecoder().decode(body.subarray(0, 8)).replace(/\0+$/g, '');
    const groupIdBytes = body.subarray(8, 16);
    const text = new TextDecoder().decode(body.subarray(16));
    await bridgeIncomingGroupText(senderIdentity, creator, groupIdBytes, text, msg.messageId);
    return;
  }

  // File message (DM)
  if (type === 0x17) {
    await bridgeIncomingFile(senderIdentity, body, msg.messageId);
    return;
  }

  // Group file message
  if (type === 0x46 && body.length > 16) {
    await bridgeIncomingGroupFile(senderIdentity, body, msg.messageId);
    return;
  }

  // Group setup message — updates group membership
  if (type === 0x4a && body.length >= 16) {
    const creator = new TextDecoder().decode(body.subarray(0, 8)).replace(/\0+$/g, '');
    const groupIdBytes = body.subarray(8, 16);
    const memberData = body.subarray(16);
    await handleGroupSetup(senderIdentity, creator, groupIdBytes, memberData);
    return;
  }

  // Group name message
  if (type === 0x4b && body.length > 16) {
    const creator = new TextDecoder().decode(body.subarray(0, 8)).replace(/\0+$/g, '');
    const groupIdBytes = body.subarray(8, 16);
    const name = new TextDecoder().decode(body.subarray(16));
    await handleGroupName(creator, groupIdBytes, name);
    return;
  }

  // Delivery receipt (DM) — bridge read receipts to Matrix
  if (type === 0x80) {
    await bridgeIncomingDeliveryReceipt(senderIdentity, body);
    return;
  }

  // Reaction (DM)
  if (type === 0x82) {
    await bridgeIncomingReaction(senderIdentity, body);
    return;
  }

  // Typing indicator
  if (type === 0x90) {
    await bridgeIncomingTypingIndicator(senderIdentity, body);
    return;
  }
}

async function handleOutgoingMessage(msg: any): Promise<void> {
  // Outgoing messages reflected from our other devices — bridge them too
  // so the Matrix side sees messages sent from the phone
  const conv = msg.conversation;
  const type: number = msg.type;
  const body: Uint8Array | undefined = msg.body;

  if (!body || body.length === 0) return;

  if (type === 0x01 && conv?.contact) {
    const text = new TextDecoder().decode(body);
    await bridgeOutgoingText(conv.contact, text, msg.messageId);
  } else if (type === 0x41 && body.length > 16 && conv?.group) {
    const text = new TextDecoder().decode(body.subarray(16));
    const creator = conv.group.creatorIdentity ?? new TextDecoder().decode(body.subarray(0, 8)).replace(/\0+$/g, '');
    const groupIdBytes = body.subarray(8, 16);
    await bridgeOutgoingGroupText(creator, groupIdBytes, text, msg.messageId);
  }
}

// ─── Bridge incoming DM text ─────────────────────────────────────────────────

async function bridgeIncomingText(senderIdentity: string, text: string, messageId?: unknown): Promise<void> {
  const roomId = await ensureDmRoom(senderIdentity);
  if (!roomId) return;

  const ghostUserId = appservice.threemaIdToMatrixUser(senderIdentity);
  const eventId = await appservice.sendMessageAs(roomId, ghostUserId, {
    msgtype: 'm.text',
    body: text,
  });

  if (eventId && messageId !== undefined) {
    state.addMessageMapping({
      matrixEventId: eventId,
      threemaMessageId: String(messageId),
      roomId,
      timestamp: Date.now(),
    });
  }

  console.log(`[bridge] Threema→Matrix: ${senderIdentity} → ${roomId}: "${text.slice(0, 60)}"`);
}

async function bridgeIncomingFile(senderIdentity: string, body: Uint8Array, messageId?: unknown): Promise<void> {
  // Parse file message JSON
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return;
  }

  const roomId = await ensureDmRoom(senderIdentity);
  if (!roomId) return;

  const ghostUserId = appservice.threemaIdToMatrixUser(senderIdentity);
  const mediaType = (parsed.m as string) ?? 'application/octet-stream';
  const fileName = (parsed.n as string) ?? 'file';
  const caption = parsed.d as string | undefined;

  // For now, send a notice about the file (full media bridging requires
  // downloading the blob, decrypting, and re-uploading to Matrix)
  const text = caption
    ? `📎 Sent a file: ${fileName} (${mediaType}) — "${caption}"`
    : `📎 Sent a file: ${fileName} (${mediaType})`;

  const eventId = await appservice.sendMessageAs(roomId, ghostUserId, {
    msgtype: 'm.notice',
    body: text,
  });

  if (eventId && messageId !== undefined) {
    state.addMessageMapping({
      matrixEventId: eventId,
      threemaMessageId: String(messageId),
      roomId,
      timestamp: Date.now(),
    });
  }
}

async function bridgeIncomingGroupText(
  senderIdentity: string,
  groupCreator: string,
  groupIdBytes: Uint8Array,
  text: string,
  messageId?: unknown,
): Promise<void> {
  const roomId = await ensureGroupRoom(groupCreator, groupIdBytes, senderIdentity);
  if (!roomId) return;

  const ghostUserId = appservice.threemaIdToMatrixUser(senderIdentity);
  const eventId = await appservice.sendMessageAs(roomId, ghostUserId, {
    msgtype: 'm.text',
    body: text,
  });

  if (eventId && messageId !== undefined) {
    state.addMessageMapping({
      matrixEventId: eventId,
      threemaMessageId: String(messageId),
      roomId,
      timestamp: Date.now(),
    });
  }

  const groupKey = getGroupKey(groupCreator, groupIdBytes);
  console.log(`[bridge] Group→Matrix: ${senderIdentity} in ${groupKey}: "${text.slice(0, 60)}"`);
}

async function bridgeIncomingGroupFile(
  senderIdentity: string,
  body: Uint8Array,
  messageId?: unknown,
): Promise<void> {
  // TODO: Implement group file bridging
  console.log(`[bridge] Group file from ${senderIdentity}`);
}

// ─── Handle group control messages ───────────────────────────────────────────

async function handleGroupSetup(
  senderIdentity: string,
  creator: string,
  groupIdBytes: Uint8Array,
  memberData: Uint8Array,
): Promise<void> {
  // Member list is a sequence of 8-byte identity strings
  const memberList: string[] = [];
  for (let i = 0; i + 8 <= memberData.length; i += 8) {
    const id = new TextDecoder().decode(memberData.subarray(i, i + 8)).replace(/\0+$/g, '');
    if (id.length > 0) memberList.push(id.toUpperCase());
  }

  const key = getGroupKey(creator, groupIdBytes);
  const idHex = Buffer.from(groupIdBytes).toString('hex');

  // Update in-memory group info
  const existing = groups.get(key);
  if (existing) {
    existing.members = memberList;
  } else {
    groups.set(key, {
      groupIdHex: idHex,
      groupIdBytes: new Uint8Array(groupIdBytes),
      creatorIdentity: creator.toUpperCase(),
      name: `Group ${idHex.slice(0, 8)}`,
      members: memberList,
    });
  }

  // Update room mapping if it exists
  const roomId = state.getRoomForGroup(creator.toUpperCase(), idHex);
  if (roomId) {
    const mapping = state.getRoomMapping(roomId);
    if (mapping) {
      mapping.members = memberList;
      state.setRoomMapping(mapping);
      state.save();
    }
  }

  console.log(`[bridge] Group setup for ${key}: ${memberList.length} members [${memberList.join(', ')}]`);
}

async function handleGroupName(
  creator: string,
  groupIdBytes: Uint8Array,
  name: string,
): Promise<void> {
  const key = getGroupKey(creator, groupIdBytes);
  const idHex = Buffer.from(groupIdBytes).toString('hex');

  // Update in-memory group info
  const existing = groups.get(key);
  if (existing) {
    existing.name = name;
  } else {
    groups.set(key, {
      groupIdHex: idHex,
      groupIdBytes: new Uint8Array(groupIdBytes),
      creatorIdentity: creator.toUpperCase(),
      name,
      members: [],
    });
  }

  // Update Matrix room name if room exists
  const roomId = state.getRoomForGroup(creator.toUpperCase(), idHex);
  if (roomId) {
    await appservice.setRoomName(roomId, `${name} (Threema)`);
  }

  console.log(`[bridge] Group name for ${key}: "${name}"`);
}

// ─── Bridge outgoing (reflected from phone) ──────────────────────────────────

async function bridgeOutgoingText(contactIdentity: string, text: string, messageId?: unknown): Promise<void> {
  const roomId = await ensureDmRoom(contactIdentity);
  if (!roomId) return;

  // Outgoing messages from our own Threema show as the real user
  const eventId = await appservice.sendMessageAsRealUser(roomId, {
    msgtype: 'm.text',
    body: text,
  });

  if (eventId && messageId !== undefined) {
    state.addMessageMapping({
      matrixEventId: eventId,
      threemaMessageId: String(messageId),
      roomId,
      timestamp: Date.now(),
    });
  }

  console.log(`[bridge] Reflected→Matrix: → ${contactIdentity}: "${text.slice(0, 60)}"`);
}

async function bridgeOutgoingGroupText(
  groupCreator: string,
  groupIdBytes: Uint8Array,
  text: string,
  messageId?: unknown,
): Promise<void> {
  const roomId = await ensureGroupRoom(groupCreator, groupIdBytes);
  if (!roomId) return;

  const eventId = await appservice.sendMessageAsRealUser(roomId, {
    msgtype: 'm.text',
    body: text,
  });

  if (eventId && messageId !== undefined) {
    state.addMessageMapping({
      matrixEventId: eventId,
      threemaMessageId: String(messageId),
      roomId,
      timestamp: Date.now(),
    });
  }

  const groupKey = getGroupKey(groupCreator, groupIdBytes);
  console.log(`[bridge] Reflected group→Matrix in ${groupKey}: "${text.slice(0, 60)}"`);
}

// ─── Bridge incoming delivery receipts (Threema → Matrix) ────────────────────

async function bridgeIncomingDeliveryReceipt(senderIdentity: string, body: Uint8Array): Promise<void> {
  const receipt = decodeDeliveryReceiptBody(body);
  if (!receipt) return;

  const ghostUserId = appservice.threemaIdToMatrixUser(senderIdentity);

  // Status 0x02 = read → Matrix read receipt
  if (receipt.status === 0x02) {
    for (const threemaMessageId of receipt.messageIds) {
      const mapping = state.getMessageMapping(threemaMessageId.toString());
      if (mapping) {
        await appservice.sendReadReceiptAs(mapping.roomId, mapping.matrixEventId, ghostUserId);
        console.log(`[bridge] Read receipt from ${senderIdentity} for message ${mapping.matrixEventId}`);
      }
    }
    return;
  }

  // Status 0x03 (ack) / 0x04 (dec) → legacy emoji reactions (👍/👎)
  const emoji = legacyDeliveryStatusToEmoji(receipt.status);
  if (emoji) {
    for (const threemaMessageId of receipt.messageIds) {
      const mapping = state.getMessageMapping(threemaMessageId.toString());
      if (mapping) {
        const reactionEventId = await appservice.sendReactionAs(mapping.roomId, mapping.matrixEventId, emoji, ghostUserId);
        if (reactionEventId) {
          state.addReactionMapping({
            matrixReactionEventId: reactionEventId,
            threemaMessageId: threemaMessageId.toString(),
            roomId: mapping.roomId,
            emoji,
            senderGhostId: ghostUserId,
          });
          console.log(`[bridge] Legacy reaction ${emoji} from ${senderIdentity} on ${mapping.matrixEventId}`);
        }
      }
    }
    return;
  }

  console.log(`[bridge] Delivery receipt from ${senderIdentity}: status=0x${receipt.status.toString(16)} (ignored)`);
}

// ─── Bridge incoming reactions (Threema → Matrix) ────────────────────────────

async function bridgeIncomingReaction(senderIdentity: string, body: Uint8Array): Promise<void> {
  const reaction = decodeReactionMessageBody(body);
  if (!reaction) return;

  const ghostUserId = appservice.threemaIdToMatrixUser(senderIdentity);
  const threemaMessageId = reaction.messageId.toString();
  const mapping = state.getMessageMapping(threemaMessageId);
  if (!mapping) {
    console.log(`[bridge] Reaction from ${senderIdentity}: no mapping for Threema message ${threemaMessageId}`);
    return;
  }

  if (reaction.action === 'apply') {
    const reactionEventId = await appservice.sendReactionAs(mapping.roomId, mapping.matrixEventId, reaction.emoji, ghostUserId);
    if (reactionEventId) {
      state.addReactionMapping({
        matrixReactionEventId: reactionEventId,
        threemaMessageId,
        roomId: mapping.roomId,
        emoji: reaction.emoji,
        senderGhostId: ghostUserId,
      });
      state.save();
      console.log(`[bridge] Reaction ${reaction.emoji} from ${senderIdentity} on ${mapping.matrixEventId}`);
    }
  } else {
    // Withdraw: find and redact the existing reaction on Matrix
    const existing = state.findReaction(threemaMessageId, reaction.emoji, ghostUserId);
    if (existing) {
      await appservice.redactEventAs(existing.roomId, existing.matrixReactionEventId, ghostUserId, 'Reaction withdrawn');
      state.removeReaction(existing.matrixReactionEventId);
      state.save();
      console.log(`[bridge] Reaction ${reaction.emoji} withdrawn by ${senderIdentity} on ${mapping.matrixEventId}`);
    }
  }
}

// ─── Bridge incoming typing indicators (Threema → Matrix) ────────────────────

async function bridgeIncomingTypingIndicator(senderIdentity: string, body: Uint8Array): Promise<void> {
  const isTyping = body.length > 0 && body[0] === 1;
  const roomId = state.getRoomForThreemaId(senderIdentity.toUpperCase());
  if (!roomId) return;

  const ghostUserId = appservice.threemaIdToMatrixUser(senderIdentity);
  await appservice.sendTypingAs(roomId, ghostUserId, isTyping);
  console.log(`[bridge] Typing from ${senderIdentity}: ${isTyping ? 'started' : 'stopped'}`);
}

// ─── Matrix → Threema ────────────────────────────────────────────────────────

appservice.onMessage(async (event: MatrixEvent) => {
  const mapping = state.getRoomMapping(event.room_id);
  if (!mapping) {
    console.log(`[bridge] Ignoring message in unmapped room ${event.room_id}`);
    return;
  }

  if (mapping.isGroup) {
    await handleMatrixGroupMessage(event, mapping);
  } else {
    await handleMatrixDmMessage(event, mapping);
  }
});

async function handleMatrixDmMessage(event: MatrixEvent, mapping: { threemaId: string }): Promise<void> {
  const content = event.content;
  const msgtype = content.msgtype as string;

  // Skip reflected messages we sent ourselves
  if (content['com.beeper.threema.reflected']) return;

  if (msgtype === 'm.text' || msgtype === 'm.notice') {
    const text = content.body as string;
    if (!text) return;

    try {
      const messageId = await mediator.sendTextMessage(mapping.threemaId, text);
      state.addMessageMapping({
        matrixEventId: event.event_id,
        threemaMessageId: messageId.toString(),
        roomId: event.room_id,
        timestamp: Date.now(),
      });
      console.log(`[bridge] Matrix→Threema: ${event.sender} → ${mapping.threemaId}: "${text.slice(0, 60)}"`);
    } catch (err) {
      console.error(`[bridge] Failed to send to ${mapping.threemaId}:`, err);
    }
  }
}

async function handleMatrixGroupMessage(event: MatrixEvent, mapping: RoomMapping): Promise<void> {
  const content = event.content;
  const msgtype = content.msgtype as string;

  if (content['com.beeper.threema.reflected']) return;

  if (msgtype === 'm.text' || msgtype === 'm.notice') {
    const text = content.body as string;
    if (!text) return;

    if (!mapping.groupCreator || !mapping.groupId || !mapping.members) {
      console.error(`[bridge] Group mapping missing creator/id/members for ${event.room_id}`);
      return;
    }

    const groupIdBytes = Buffer.from(mapping.groupId, 'hex');

    try {
      const messageId = await mediator.sendGroupTextMessage(
        mapping.groupCreator,
        new Uint8Array(groupIdBytes),
        mapping.members,
        text,
      );
      state.addMessageMapping({
        matrixEventId: event.event_id,
        threemaMessageId: messageId.toString(),
        roomId: event.room_id,
        timestamp: Date.now(),
      });
      console.log(`[bridge] Matrix→Threema group: ${event.sender} → ${mapping.groupCreator}/${mapping.groupId}: "${text.slice(0, 60)}"`);
    } catch (err) {
      console.error(`[bridge] Failed to send group message:`, err);
    }
  }
}

// ─── Matrix → Threema: Read receipts ─────────────────────────────────────────

appservice.onReceipt(async (event: MatrixEvent) => {
  // m.receipt events have content like: { "$eventId": { "m.read": { "@user:server": { ts: 123 } } } }
  const content = event.content as Record<string, Record<string, Record<string, unknown>>>;
  for (const [eventId, receiptTypes] of Object.entries(content)) {
    const readReceipts = receiptTypes['m.read'];
    if (!readReceipts) continue;

    // Only care about the real user's read receipts
    if (!(config.appservice.userId in readReceipts)) continue;

    const mapping = state.getRoomMapping(event.room_id);
    if (!mapping || mapping.isGroup) continue;

    const msgMapping = state.getMessageMappingByMatrixId(eventId);
    if (!msgMapping) continue;

    try {
      await mediator.sendDeliveryReceipt(mapping.threemaId, BigInt(msgMapping.threemaMessageId), 0x02);
      console.log(`[bridge] Read receipt → Threema: ${mapping.threemaId} for ${eventId}`);
    } catch (err) {
      console.error(`[bridge] Failed to send read receipt to ${mapping.threemaId}:`, err);
    }
  }
});

// ─── Matrix → Threema: Typing indicators ─────────────────────────────────────

appservice.onTyping(async (roomId: string, _userId: string, isTyping: boolean) => {
  const mapping = state.getRoomMapping(roomId);
  if (!mapping || mapping.isGroup) return;

  try {
    await mediator.sendTypingIndicator(mapping.threemaId, isTyping);
    console.log(`[bridge] Typing → Threema: ${mapping.threemaId} ${isTyping ? 'started' : 'stopped'}`);
  } catch (err) {
    // Typing failures are non-critical (e.g. CSP not ready)
  }
});

// ─── Matrix → Threema: Reactions ──────────────────────────────────────────────

appservice.onReaction(async (event: MatrixEvent) => {
  const relatesTo = event.content['m.relates_to'] as { rel_type?: string; event_id?: string; key?: string } | undefined;
  if (!relatesTo || relatesTo.rel_type !== 'm.annotation' || !relatesTo.event_id || !relatesTo.key) return;

  const mapping = state.getRoomMapping(event.room_id);
  if (!mapping || mapping.isGroup) return;

  const msgMapping = state.getMessageMappingByMatrixId(relatesTo.event_id);
  if (!msgMapping) {
    console.log(`[bridge] Reaction on unmapped Matrix event ${relatesTo.event_id}`);
    return;
  }

  try {
    await mediator.sendDirectReaction(
      mapping.threemaId,
      BigInt(msgMapping.threemaMessageId),
      relatesTo.key,
      'apply',
    );
    console.log(`[bridge] Reaction → Threema: ${relatesTo.key} on ${mapping.threemaId} message ${msgMapping.threemaMessageId}`);
  } catch (err) {
    console.error(`[bridge] Failed to send reaction to ${mapping.threemaId}:`, err);
  }
});

// ─── Matrix → Threema: Redactions (reaction withdrawal) ──────────────────────

appservice.onRedaction(async (event: MatrixEvent) => {
  const redactedEventId = event.redacts;
  if (!redactedEventId) return;

  // Check if the redacted event was a reaction we sent from Matrix
  // (We only handle our own user's redactions to withdraw reactions)
  const mapping = state.getRoomMapping(event.room_id);
  if (!mapping || mapping.isGroup) return;

  // Try to find the original reaction's target message via the redacted event ID
  // The redacted event should be an m.reaction event — we need to know which Threema
  // message it was reacting to. We don't track user-sent reactions in state (only ghost reactions),
  // so we check if this is a reaction event by looking at the message mapping.
  // For now, log it — full withdrawal support requires tracking user-sent reactions.
  console.log(`[bridge] Redaction in ${event.room_id}: ${redactedEventId} (reaction withdrawal not yet fully tracked)`);
});

// ─── Room management ─────────────────────────────────────────────────────────

async function ensureDmRoom(threemaId: string): Promise<string | null> {
  const normalizedId = threemaId.toUpperCase();
  const existing = state.getRoomForThreemaId(normalizedId);
  if (existing) return existing;

  const displayName = getContactDisplayName(normalizedId);
  const ghostUserId = appservice.threemaIdToMatrixUser(normalizedId);

  // Set the ghost's display name
  await appservice.setDisplayName(ghostUserId, `${displayName} (Threema)`);

  // Create a DM room as the bot, invite the real user and the ghost
  const roomId = await appservice.createRoom({
    name: `${displayName} (Threema)`,
    invite: [config.appservice.userId, ghostUserId],
    is_direct: true,
    preset: 'trusted_private_chat',
    initial_state: [
      {
        type: 'm.room.power_levels',
        content: {
          users: {
            [ghostUserId]: 100,
            [config.appservice.userId]: 50,
            [config.appservice.botUserId]: 100,
          },
          events_default: 0,
          state_default: 50,
          ban: 100,
          kick: 100,
          invite: 50,
        },
      },
    ],
  });

  if (!roomId) {
    console.error(`[bridge] Failed to create DM room for ${normalizedId}`);
    return null;
  }

  // Auto-join the ghost user into the room
  await appservice.joinRoomAs(roomId, ghostUserId);

  // Accept the invite as the real user
  await appservice.joinRoomAsRealUser(roomId);

  // Save mapping
  state.setRoomMapping({
    roomId,
    threemaId: normalizedId,
    isGroup: false,
  });
  state.save();

  console.log(`[bridge] Created DM room ${roomId} for ${normalizedId} (${displayName})`);
  return roomId;
}

async function ensureGroupRoom(
  groupCreator: string,
  groupIdBytes: Uint8Array,
  triggerSenderIdentity?: string,
): Promise<string | null> {
  const creator = groupCreator.toUpperCase();
  const idHex = Buffer.from(groupIdBytes).toString('hex');
  const existing = state.getRoomForGroup(creator, idHex);
  if (existing) return existing;

  // Look up group info (name, members) from groups.json
  const info = getGroupInfo(creator, groupIdBytes);
  const groupName = info?.name ?? `Group ${idHex.slice(0, 8)}`;

  // Collect members: from groups.json, plus the trigger sender if not already included
  const memberIds = new Set<string>(info?.members?.map(m => m.toUpperCase()) ?? []);
  memberIds.add(creator);
  if (triggerSenderIdentity) {
    memberIds.add(triggerSenderIdentity.toUpperCase());
  }
  // Remove ourselves from ghosts (we're the real user)
  memberIds.delete(identity.identity.toUpperCase());

  // Set display names for all ghost members
  const ghostUserIds: string[] = [];
  for (const memberId of memberIds) {
    const ghostUserId = appservice.threemaIdToMatrixUser(memberId);
    ghostUserIds.push(ghostUserId);
    const displayName = getContactDisplayName(memberId);
    await appservice.setDisplayName(ghostUserId, `${displayName} (Threema)`);
  }

  // Build power levels: all ghosts at 50, bot at 100, real user at 50
  const powerUsers: Record<string, number> = {
    [config.appservice.botUserId]: 100,
    [config.appservice.userId]: 50,
  };
  for (const gid of ghostUserIds) {
    powerUsers[gid] = 50;
  }

  const roomId = await appservice.createRoom({
    name: `${groupName} (Threema)`,
    invite: [config.appservice.userId, ...ghostUserIds],
    is_direct: false,
    preset: 'trusted_private_chat',
    initial_state: [
      {
        type: 'm.room.power_levels',
        content: {
          users: powerUsers,
          events_default: 0,
          state_default: 50,
          ban: 100,
          kick: 100,
          invite: 50,
        },
      },
    ],
  });

  if (!roomId) {
    console.error(`[bridge] Failed to create group room for ${creator}/${idHex}`);
    return null;
  }

  // Join all ghosts
  for (const ghostUserId of ghostUserIds) {
    await appservice.joinRoomAs(roomId, ghostUserId);
  }

  // Accept invite as the real user
  await appservice.joinRoomAsRealUser(roomId);

  // Save mapping
  const members = Array.from(memberIds);
  state.setRoomMapping({
    roomId,
    threemaId: creator,
    isGroup: true,
    groupCreator: creator,
    groupId: idHex,
    members,
  });
  state.save();

  console.log(`[bridge] Created group room ${roomId} for ${groupName} (${creator}/${idHex}, ${members.length} members)`);
  return roomId;
}

// ─── Reconnection logic ──────────────────────────────────────────────────────

let reconnectAttempt = 0;
const MAX_RECONNECT_DELAY_MS = 60_000;

async function connectWithReconnect(): Promise<void> {
  while (true) {
    try {
      await mediator.connect();
      reconnectAttempt = 0;
      console.log('[bridge] Connected to Threema mediator');

      // Wait for disconnect
      await new Promise<void>((resolve) => {
        mediator.once('close', () => resolve());
      });
    } catch (err) {
      console.error('[bridge] Mediator connection error:', err);
    }

    reconnectAttempt++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), MAX_RECONNECT_DELAY_MS);
    console.log(`[bridge] Reconnecting in ${delay}ms (attempt ${reconnectAttempt})...`);
    await new Promise(r => setTimeout(r, delay));
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[bridge] Starting beeper-threema-bridge');
  console.log(`[bridge] Appservice port: ${config.appservice.port}`);
  console.log(`[bridge] Homeserver URL: ${config.appservice.homeserverUrl}`);

  await appservice.start();

  // Connect to Threema in background with auto-reconnect
  connectWithReconnect().catch(err => {
    console.error('[bridge] Fatal error:', err);
    process.exit(1);
  });
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[bridge] Shutting down...');
  state.save();
  mediator.disconnect();
  appservice.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  state.save();
  mediator.disconnect();
  appservice.stop();
  process.exit(0);
});

main().catch(err => {
  console.error('[bridge] Fatal startup error:', err);
  process.exit(1);
});
