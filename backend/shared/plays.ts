import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Track } from './catalog.js';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = process.env.PLAYS_TABLE!;

/**
 * Play log for royalties (and, later, listening-time limits). One table, two kinds of row:
 *   pk PLAY#<playId>   sk SESSION              one listen in progress; deleted by DynamoDB TTL after a day
 *   pk TRACK#<trackId> sk <yyyy-mm-dd>#<tier>  running totals per song, per day (US Eastern), per plan
 * Totals rows carry producer/title/artist as they were at the time, so the monthly report needs only this table.
 */

/** Listening plans; must match frontend/src/tiers.ts. */
export type Tier = 'free' | 'basic' | 'premium' | 'corporate';

/** A listen counts as a play once this much of the song has actually been heard (the usual industry rule). */
export const PLAY_COUNTS_AFTER_SECONDS = 30;
/** Reports may run this far ahead of the server's clock (network delay, timers) before being trimmed. */
const CLOCK_SLACK_SECONDS = 5;
const SESSION_TTL_SECONDS = 24 * 60 * 60;

interface Session {
  pk: string;
  sk: 'SESSION';
  trackId: string;
  tier: Tier;
  producer?: string;
  title: string;
  artist?: string;
  durationSeconds?: number;
  startedAt: number; // epoch ms
  day: string; // yyyy-mm-dd, US Eastern, fixed at the start so a listen over midnight stays on one day
  seconds: number; // listened time already added to the totals
  expiresAt: number; // epoch seconds, DynamoDB TTL
}

/** yyyy-mm-dd in US Eastern — the same clock the free hour resets on. */
export function easternDay(at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(at);
}

/** Opens a listen for a song that's starting to play and returns its id. */
export async function startListen(track: Track, tier: Tier): Promise<string> {
  const playId = randomUUID();
  const now = Date.now();
  const session: Session = {
    pk: `PLAY#${playId}`,
    sk: 'SESSION',
    trackId: track.trackId,
    tier,
    producer: track.producer,
    title: track.title,
    artist: track.artist,
    durationSeconds: track.durationMs ? track.durationMs / 1000 : undefined,
    startedAt: now,
    day: easternDay(new Date(now)),
    seconds: 0,
    expiresAt: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
  };
  await db.send(new PutCommand({ TableName: TABLE, Item: session }));
  return playId;
}

/**
 * Records how many seconds of a listen have been heard so far (a running total from the browser).
 * The total can't exceed the time since the listen started or the song's length, so a faked report can't
 * add more than real time allows; only the increase since the last report is added. Returns false if the
 * listen is unknown or expired.
 */
export async function recordListen(playId: string, reportedSeconds: number): Promise<boolean> {
  const res = await db.send(new GetCommand({ TableName: TABLE, Key: { pk: `PLAY#${playId}`, sk: 'SESSION' } }));
  const s = res.Item as Session | undefined;
  if (!s) return false;

  const elapsed = (Date.now() - s.startedAt) / 1000 + CLOCK_SLACK_SECONDS;
  const cap = Math.min(elapsed, s.durationSeconds ? s.durationSeconds + CLOCK_SLACK_SECONDS : Infinity);
  const heard = Math.floor(Math.min(Math.max(0, reportedSeconds), cap));
  const added = heard - s.seconds;
  if (added <= 0) return true;
  const counts = s.seconds < PLAY_COUNTS_AFTER_SECONDS && heard >= PLAY_COUNTS_AFTER_SECONDS;

  try {
    // Both rows in one step, and only if no other report moved the session first, so nothing is counted twice.
    await db.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE,
            Key: { pk: s.pk, sk: 'SESSION' },
            UpdateExpression: 'SET seconds = :heard',
            ConditionExpression: 'seconds = :before',
            ExpressionAttributeValues: { ':heard': heard, ':before': s.seconds },
          },
        },
        {
          Update: {
            TableName: TABLE,
            Key: { pk: `TRACK#${s.trackId}`, sk: `${s.day}#${s.tier}` },
            UpdateExpression: 'ADD plays :plays, seconds :added SET trackId = :id, #day = :day, tier = :tier, '
              + 'title = :title, producer = :producer' + (s.artist ? ', artist = :artist' : ''),
            ExpressionAttributeNames: { '#day': 'day' },
            ExpressionAttributeValues: {
              ':plays': counts ? 1 : 0,
              ':added': added,
              ':id': s.trackId,
              ':day': s.day,
              ':tier': s.tier,
              ':title': s.title,
              ':producer': s.producer ?? '(not set)',
              ...(s.artist ? { ':artist': s.artist } : {}),
            },
          },
        },
      ],
    }));
  } catch (err) {
    // Another report for the same listen got there first; the browser's next report carries the new total.
    if ((err as Error).name === 'TransactionCanceledException') return true;
    throw err;
  }
  return true;
}
