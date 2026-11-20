import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { addLike, putTrack, toListItem, toPublic, type Track } from '../../backend/shared/catalog.js';

const ddb = mockClient(DynamoDBDocumentClient);

const full: Track = {
  trackId: 't1', title: 'Song', artist: 'Band', status: 'READY', sourceKey: 'raw/song.flac', createdAt: '2026-11-01',
  error: 'old error', lyrics: 'la', copyright: '(c)', aiInfo: 'none', likes: 3,
};

beforeEach(() => { ddb.reset(); });

describe('toPublic / toListItem', () => {
  it('toPublic drops internal fields only', () => {
    expect(toPublic(full)).toEqual({
      trackId: 't1', title: 'Song', artist: 'Band', createdAt: '2026-11-01', lyrics: 'la', copyright: '(c)', aiInfo: 'none', likes: 3,
    });
  });

  it('toListItem also drops the About-popup text', () => {
    expect(toListItem(full)).toEqual({ trackId: 't1', title: 'Song', artist: 'Band', createdAt: '2026-11-01', likes: 3 });
  });
});

describe('putTrack', () => {
  it('keeps the like count when a song row is rewritten', async () => {
    ddb.on(GetCommand).resolves({ Item: { trackId: 't1', likes: 9 } });
    await putTrack({ ...full, likes: undefined });
    expect(ddb.commandCalls(PutCommand)[0].args[0].input.Item!.likes).toBe(9);
  });

  it('does not look up the old row when likes are given', async () => {
    await putTrack(full);
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddb.commandCalls(PutCommand)[0].args[0].input.Item!.likes).toBe(3);
  });
});

describe('addLike', () => {
  it('returns the new count', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { likes: 4 } });
    expect(await addLike('t1')).toBe(4);
    expect(ddb.commandCalls(UpdateCommand)[0].args[0].input.ConditionExpression).toBe('#s = :ready');
  });

  it('returns undefined for a song that is not READY', async () => {
    ddb.on(UpdateCommand).rejects(Object.assign(new Error('no'), { name: 'ConditionalCheckFailedException' }));
    expect(await addLike('t1')).toBeUndefined();
  });

  it('passes other errors on', async () => {
    ddb.on(UpdateCommand).rejects(new Error('boom'));
    await expect(addLike('t1')).rejects.toThrow('boom');
  });
});
