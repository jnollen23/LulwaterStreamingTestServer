import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = process.env.TRACKS_TABLE!;

export type TrackStatus = 'PROCESSING' | 'READY' | 'ERROR';

export interface Track {
  trackId: string;
  title: string;
  artist?: string;
  album?: string;
  trackNumber?: number;
  year?: number;
  /** From the FLAC GENRE tag(s); drives the genre buttons on the site. */
  genres?: string[];
  durationMs?: number;
  artPath?: string;
  /** Small square JPEG of the art for song lists; missing on songs ingested before thumbnails existed. */
  thumbPath?: string;
  /**
   * Who royalties for this song go to. From the FLAC PRODUCER tag; songs without one show as "(not set)" in the
   * royalty report until it's filled in (re-upload with the tag, or edit the row in the TracksTable).
   */
  producer?: string;
  /** Running like count. No user is recorded, so the site allows one like per song per page visit. */
  likes?: number;
  status: TrackStatus;
  sourceKey: string;
  createdAt: string;
  error?: string;
}

/** Fields safe to send to the browser. */
export type PublicTrack = Omit<Track, 'status' | 'sourceKey' | 'error'>;

export function toPublic({ status, sourceKey, error, ...rest }: Track): PublicTrack {
  return rest;
}

export async function putTrack(track: Track): Promise<void> {
  // Re-uploading a song rewrites its row; carry the like count over so it isn't reset.
  const likes = track.likes ?? (await getTrack(track.trackId))?.likes;
  await db.send(new PutCommand({ TableName: TABLE, Item: { ...track, likes } }));
}

export async function getTrack(trackId: string): Promise<Track | undefined> {
  const res = await db.send(new GetCommand({ TableName: TABLE, Key: { trackId } }));
  return res.Item as Track | undefined;
}

/** Full-table scan — fine for a library of a few thousand tracks. Add a GSI if it grows well past that. */
export async function listReadyTracks(): Promise<Track[]> {
  const tracks: Track[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await db.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: '#s = :ready',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':ready': 'READY' },
      ExclusiveStartKey,
    }));
    tracks.push(...((res.Items ?? []) as Track[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return tracks;
}

/** Every entry made from one raw/ file, whatever its status — more than one means it was re-uploaded. */
export async function listTracksBySource(sourceKey: string): Promise<Track[]> {
  const tracks: Track[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await db.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'sourceKey = :k',
      ExpressionAttributeValues: { ':k': sourceKey },
      ExclusiveStartKey,
    }));
    tracks.push(...((res.Items ?? []) as Track[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return tracks;
}

export async function deleteTrack(trackId: string): Promise<void> {
  await db.send(new DeleteCommand({ TableName: TABLE, Key: { trackId } }));
}

/** Moves likes onto a track in one step, so a like landing at the same moment isn't lost. */
export async function addLikes(trackId: string, count: number): Promise<void> {
  await db.send(new UpdateCommand({
    TableName: TABLE,
    Key: { trackId },
    UpdateExpression: 'ADD likes :n',
    ExpressionAttributeValues: { ':n': count },
  }));
}

/** Adds one like to a READY track and returns the new count, or undefined if the track isn't playable. */
export async function addLike(trackId: string): Promise<number | undefined> {
  try {
    const res = await db.send(new UpdateCommand({
      TableName: TABLE,
      Key: { trackId },
      UpdateExpression: 'ADD likes :one',
      ConditionExpression: '#s = :ready',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':one': 1, ':ready': 'READY' },
      ReturnValues: 'UPDATED_NEW',
    }));
    return res.Attributes?.likes as number;
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return undefined;
    throw err;
  }
}

export async function markReady(trackId: string, durationMs: number | undefined): Promise<void> {
  await db.send(new UpdateCommand({
    TableName: TABLE,
    Key: { trackId },
    UpdateExpression: 'SET #s = :ready, durationMs = :d REMOVE #e',
    ExpressionAttributeNames: { '#s': 'status', '#e': 'error' },
    ExpressionAttributeValues: { ':ready': 'READY', ':d': durationMs ?? null },
  }));
}

export async function setThumbPath(trackId: string, thumbPath: string): Promise<void> {
  await db.send(new UpdateCommand({
    TableName: TABLE,
    Key: { trackId },
    UpdateExpression: 'SET thumbPath = :t',
    ExpressionAttributeValues: { ':t': thumbPath },
  }));
}

export async function markError(trackId: string, error: string): Promise<void> {
  await db.send(new UpdateCommand({
    TableName: TABLE,
    Key: { trackId },
    UpdateExpression: 'SET #s = :err, #e = :msg',
    ExpressionAttributeNames: { '#s': 'status', '#e': 'error' },
    ExpressionAttributeValues: { ':err': 'ERROR', ':msg': error },
  }));
}
