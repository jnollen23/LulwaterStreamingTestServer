import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { S3Event } from 'aws-lambda';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { parseStream } from 'music-metadata';
import {
  addLikes, deleteTrack, listReadyTracks, listTracksBySource, markError, markReady, putTrack, setThumbPath,
} from '../shared/catalog.js';
import { makeThumbnail, transcodeToHls } from './transcode.js';

const s3 = new S3Client({});

/** Run by hand (Lambda console "Test" with this event) to give songs ingested before thumbnails existed one. */
interface BackfillEvent { action: 'backfill-thumbs' }

/**
 * Fires when a file lands in s3://<media bucket>/raw/.
 * Reads tags + cover art, adds a PROCESSING entry to the catalog, transcodes to HLS with ffmpeg,
 * then flips the entry to READY (or ERROR, with the reason).
 */
export async function handler(event: S3Event | BackfillEvent): Promise<unknown> {
  if ('action' in event) {
    if (event.action === 'backfill-thumbs') return backfillThumbs();
    throw new Error(`Unknown action: ${String(event.action)}`);
  }

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    if (key.endsWith('/')) continue; // "Create folder" placeholder from the S3 console

    const trackId = randomUUID();
    const tags = await readTags(bucket, key);

    let artPath: string | undefined;
    let thumbPath: string | undefined;
    if (tags.picture) {
      const ext = tags.picture.format.includes('png') ? 'png' : 'jpg';
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: `art/${trackId}.${ext}`,
        Body: tags.picture.data,
        ContentType: tags.picture.format,
        CacheControl: 'public, max-age=31536000, immutable',
      }));
      artPath = `/art/${trackId}.${ext}`;
      thumbPath = await putThumbnail(bucket, trackId, tags.picture.data);
    }

    await putTrack({
      trackId,
      title: tags.title ?? fileTitle(key),
      artist: tags.artist,
      album: tags.album,
      trackNumber: tags.trackNumber,
      year: tags.year,
      genres: tags.genres,
      producer: tags.producer,
      artPath,
      thumbPath,
      status: 'PROCESSING',
      sourceKey: key,
      createdAt: new Date().toISOString(),
    });
    console.log(`Transcoding ${key} as track ${trackId}`);

    try {
      const durationMs = await transcodeToHls(bucket, key, trackId);
      await markReady(trackId, durationMs);
      console.log(`Track ${trackId} ready`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markError(trackId, message.slice(0, 1000));
      console.error(`Track ${trackId} failed`, err);
      continue;
    }

    try {
      await replaceOlderCopies(bucket, key, trackId);
    } catch (err) {
      // The new copy is fine; an older one may still be listed and need deleting by hand.
      console.error(`Could not clear older copies of ${key}`, err);
    }
  }
}

/**
 * Re-uploading a file with the same name replaces the song: once the new copy is READY, older entries from the
 * same raw/ key hand over their likes and are deleted along with their stream and art files. Runs only after a
 * successful transcode, so a failed re-upload leaves the old song playing.
 */
async function replaceOlderCopies(bucket: string, sourceKey: string, trackId: string): Promise<void> {
  const older = (await listTracksBySource(sourceKey)).filter((t) => t.trackId !== trackId);
  if (!older.length) return;
  const likes = older.reduce((sum, t) => sum + (t.likes ?? 0), 0);
  if (likes) await addLikes(trackId, likes);
  for (const t of older) {
    await deleteTrack(t.trackId); // off the site first, then its files
    await deletePrefix(bucket, `stream/${t.trackId}/`);
    const art = [t.artPath, t.thumbPath].filter((p): p is string => !!p).map((p) => ({ Key: p.replace(/^\//, '') }));
    if (art.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: art } }));
    console.log(`Replaced older copy ${t.trackId} of ${sourceKey}`);
  }
}

async function deletePrefix(bucket: string, prefix: string): Promise<void> {
  let ContinuationToken: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
    const objects = (res.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
    ContinuationToken = res.NextContinuationToken;
  } while (ContinuationToken);
}

/**
 * Writes s3://<bucket>/art/thumb/<trackId>.jpg and returns its site path. A thumbnail is a nice-to-have, so a
 * failure is logged and the song lists fall back to the full-size art rather than failing the whole upload.
 */
async function putThumbnail(bucket: string, trackId: string, image: Uint8Array): Promise<string | undefined> {
  try {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `art/thumb/${trackId}.jpg`,
      Body: await makeThumbnail(image, trackId),
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    return `/art/thumb/${trackId}.jpg`;
  } catch (err) {
    console.warn(`Could not make a thumbnail for track ${trackId}`, err);
    return undefined;
  }
}

/** Thumbnails for READY songs that have art but no thumbnail yet. Safe to run more than once. */
async function backfillThumbs(): Promise<{ made: number; failed: string[] }> {
  const bucket = process.env.MEDIA_BUCKET!;
  const todo = (await listReadyTracks()).filter((t) => t.artPath && !t.thumbPath);
  console.log(`Backfilling thumbnails for ${todo.length} tracks`);
  let made = 0;
  const failed: string[] = [];
  for (const t of todo) {
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: t.artPath!.replace(/^\//, '') }));
      const thumbPath = await putThumbnail(bucket, t.trackId, await obj.Body!.transformToByteArray());
      if (!thumbPath) throw new Error('thumbnail failed');
      await setThumbPath(t.trackId, thumbPath);
      made++;
    } catch (err) {
      console.warn(`Backfill skipped track ${t.trackId}`, err);
      failed.push(t.trackId);
    }
  }
  return { made, failed };
}

interface Tags {
  title?: string;
  artist?: string;
  album?: string;
  trackNumber?: number;
  year?: number;
  genres?: string[];
  producer?: string;
  picture?: { format: string; data: Uint8Array };
}

async function readTags(bucket: string, key: string): Promise<Tags> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = obj.Body as Readable;
  try {
    const { common } = await parseStream(body, { mimeType: obj.ContentType, size: obj.ContentLength });
    return {
      title: common.title,
      artist: common.artist,
      album: common.album,
      trackNumber: common.track.no ?? undefined,
      year: common.year,
      genres: splitGenres(common.genre),
      producer: common.producer?.[0]?.trim() || undefined,
      picture: common.picture?.[0],
    };
  } catch (err) {
    console.warn(`Could not read tags from ${key}, falling back to filename`, err);
    return {};
  } finally {
    body.destroy(); // tags sit at the front of FLAC files; don't download the rest
  }
}

/** "raw/Some Artist - Some Song.flac" -> "Some Artist - Some Song" */
function fileTitle(key: string): string {
  return key.split('/').pop()!.replace(/\.[^.]+$/, '');
}

/** GENRE tags often pack several values into one ("Worship; Gospel"), so split and de-duplicate them. */
function splitGenres(raw: string[] | undefined): string[] | undefined {
  const genres = [...new Set((raw ?? []).flatMap((g) => g.split(/[;,/]/)).map((g) => g.trim()).filter(Boolean))];
  return genres.length ? genres : undefined;
}
