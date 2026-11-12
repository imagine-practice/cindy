// Value: the settled-identity memory (plan B) reads the durable send journal to know that a
// clientId was already accepted, across a process restart. A wrong path/key rule would silently
// re-post messages, and a throwing reader would block legitimate sends.
// Minimal failure: change the journal key or the endpoint hash and this reader stops finding the
// receipt the send path wrote.
// Tier: main-process unit with real files in a temp directory; no network, no DB, no process.
// Standalone measurement: 4 cases, ~0.4s on Windows (2026-11-09).
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = { dir: '' };
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(root.dir, ...parts),
}));

import { chatSendJournal, chatSendJournalKey, readChatSendReceipt } from '../chatSendJournal';

const ENDPOINT = 'https://chat.example.com';
const ROOM = '8cbb95f0-eec5-451d-8449-85091499c8ab';
const CLIENT = 'project-progress-intent-1';
const KEY = chatSendJournalKey(ROOM, CLIENT);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

beforeEach(() => { root.dir = mkdtempSync(path.join(tmpdir(), 'cindy-journal-')); });
afterEach(() => { rmSync(root.dir, { recursive: true, force: true }); });

function journal() {
  return chatSendJournal<{ snapshot: { room: { id: string } } }>(ENDPOINT, () => true);
}

describe('settled send receipts', () => {
  it('reads back the receipt the send path confirmed, with the same key and endpoint rules', () => {
    const store = journal();
    store.save(KEY, 'sig', { snapshot: { room: { id: ROOM } } }, ROOM);
    store.confirm(KEY, 'sig', 'message-1');
    expect(readChatSendReceipt(ENDPOINT, ROOM, CLIENT)).toBe('message-1');
    // Another endpoint, room or clientId is a different journal entry.
    expect(readChatSendReceipt('https://other.example.com', ROOM, CLIENT)).toBeNull();
    expect(readChatSendReceipt(ENDPOINT, ROOM, 'other-client')).toBeNull();
  });

  it('returns null for an intent without a receipt (the message was never confirmed here)', () => {
    journal().save(KEY, 'sig', { snapshot: { room: { id: ROOM } } }, ROOM);
    expect(readChatSendReceipt(ENDPOINT, ROOM, CLIENT)).toBeNull();
  });

  it('returns null instead of throwing for corrupt or missing journal files', () => {
    expect(readChatSendReceipt(ENDPOINT, ROOM, CLIENT)).toBeNull();
    const dir = path.join(root.dir, 'chat-send-journal', hash(ENDPOINT));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${hash(KEY)}.json`), '{ not json');
    expect(readChatSendReceipt(ENDPOINT, ROOM, CLIENT)).toBeNull();
  });

  it('keeps a confirmed receipt after the room is forgotten (only intents carry a roomId)', () => {
    const store = journal();
    store.save(KEY, 'sig', { snapshot: { room: { id: ROOM } } }, ROOM);
    store.confirm(KEY, 'sig', 'message-1');
    store.forgetRoom(ROOM);
    expect(readChatSendReceipt(ENDPOINT, ROOM, CLIENT)).toBe('message-1');
  });
});
