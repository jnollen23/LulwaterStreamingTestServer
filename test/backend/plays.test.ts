import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../../backend/shared/catalog.js';
import { easternDay, recordListen, startListen } from '../../backend/shared/plays.js';

const ddb = mockClient(DynamoDBDocumentClient);
const NOW = new Date('2026-11-19T15:00:00Z');

beforeEach(() => {
  ddb.reset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); });

/** A listen that started `agoSeconds` ago and has `seconds` already counted. */
function session(agoSeconds: number, seconds = 0, extra: Record<string, unknown> = {}) {
  ddb.on(GetCommand).resolves({
    Item: {
      pk: 'PLAY#p1', sk: 'SESSION', trackId: 't1', tier: 'free', title: 'Song', artist: 'Band',
      producer: 'Prod', durationSeconds: 200, startedAt: NOW.getTime() - agoSeconds * 1000,
      day: '2026-11-19', seconds, expiresAt: 0, ...extra,
    },
  });
}

/** The two updates of the one transaction recordListen sends: [session, daily totals]. */
function written() {
  const calls = ddb.commandCalls(TransactWriteCommand);
  expect(calls).toHaveLength(1);
  const [s, totals] = calls[0].args[0].input.TransactItems!.map((i) => i.Update!);
  return { s, totals };
}

describe('easternDay', () => {
  it('uses the US Eastern date, not UTC', () => {
    expect(easternDay(new Date('2026-11-19T04:30:00Z'))).toBe('2026-11-18'); // 23:30 EST
    expect(easternDay(new Date('2026-11-19T05:00:00Z'))).toBe('2026-11-19'); // midnight EST
    expect(easternDay(new Date('2026-07-01T03:59:00Z'))).toBe('2026-06-30'); // 23:59 EDT
    expect(easternDay(new Date('2026-07-01T04:00:00Z'))).toBe('2026-07-01');
  });
});

describe('startListen', () => {
  it('opens a session on the Eastern day with a one-day expiry', async () => {
    const track = { trackId: 't1', title: 'Song', durationMs: 180_500, producer: 'Prod' } as Track;
    const id = await startListen(track, 'basic');
    const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item).toMatchObject({
      pk: `PLAY#${id}`, sk: 'SESSION', trackId: 't1', tier: 'basic', durationSeconds: 180.5,
      day: '2026-11-19', seconds: 0, startedAt: NOW.getTime(),
      expiresAt: NOW.getTime() / 1000 + 24 * 60 * 60,
    });
  });
});

describe('recordListen', () => {
  it('returns false for an unknown or expired listen', async () => {
    ddb.on(GetCommand).resolves({});
    expect(await recordListen('nope', 10)).toBe(false);
  });

  it('counts a play the first time 30 seconds is passed', async () => {
    session(40);
    expect(await recordListen('p1', 35)).toBe(true);
    const { s, totals } = written();
    expect(s.ExpressionAttributeValues).toMatchObject({ ':heard': 35, ':before': 0 });
    expect(totals.Key).toEqual({ pk: 'TRACK#t1', sk: '2026-11-19#free' });
    expect(totals.ExpressionAttributeValues).toMatchObject({ ':plays': 1, ':added': 35, ':producer': 'Prod', ':artist': 'Band' });
  });

  it('does not count a play under 30 seconds, but still adds the time', async () => {
    session(40);
    await recordListen('p1', 29);
    expect(written().totals.ExpressionAttributeValues).toMatchObject({ ':plays': 0, ':added': 29 });
  });

  it('adds only the increase, and never counts the same listen twice', async () => {
    session(200, 40);
    await recordListen('p1', 100);
    const { s, totals } = written();
    expect(s.ExpressionAttributeValues).toMatchObject({ ':heard': 100, ':before': 40 });
    expect(totals.ExpressionAttributeValues).toMatchObject({ ':plays': 0, ':added': 60 });
  });

  it('caps a report at the real time since the listen started (plus 5 s slack)', async () => {
    session(40);
    await recordListen('p1', 10_000);
    expect(written().s.ExpressionAttributeValues![':heard']).toBe(45);
  });

  it('caps a report at the song length (plus 5 s slack)', async () => {
    session(10_000);
    await recordListen('p1', 10_000);
    expect(written().s.ExpressionAttributeValues![':heard']).toBe(205);
  });

  it('has no length cap when the song length is unknown', async () => {
    session(1_000, 0, { durationSeconds: undefined });
    await recordListen('p1', 900);
    expect(written().s.ExpressionAttributeValues![':heard']).toBe(900);
  });

  it('writes nothing for a report that is not ahead of what is stored, or is negative', async () => {
    session(100, 50);
    expect(await recordListen('p1', 50)).toBe(true);
    expect(await recordListen('p1', 20)).toBe(true);
    expect(await recordListen('p1', -5)).toBe(true);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rounds fractional seconds down', async () => {
    session(100);
    await recordListen('p1', 31.9);
    expect(written().s.ExpressionAttributeValues![':heard']).toBe(31);
  });

  it('labels songs without a producer "(not set)" and leaves artist out when missing', async () => {
    session(40, 0, { producer: undefined, artist: undefined });
    await recordListen('p1', 35);
    const { totals } = written();
    expect(totals.ExpressionAttributeValues![':producer']).toBe('(not set)');
    expect(totals.ExpressionAttributeValues).not.toHaveProperty(':artist');
    expect(totals.UpdateExpression).not.toContain('artist');
  });

  it('treats losing a race to another report as fine', async () => {
    session(40);
    ddb.on(TransactWriteCommand).rejects(Object.assign(new Error('race'), { name: 'TransactionCanceledException' }));
    expect(await recordListen('p1', 35)).toBe(true);
  });

  it('passes other database errors on', async () => {
    session(40);
    ddb.on(TransactWriteCommand).rejects(new Error('boom'));
    await expect(recordListen('p1', 35)).rejects.toThrow('boom');
  });
});
