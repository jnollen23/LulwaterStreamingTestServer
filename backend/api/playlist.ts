import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import { signedStreamQuery } from '../shared/signing.js';

const s3 = new S3Client({});

/** Only playlist files the transcoder writes ("index.m3u8", "index_128k.m3u8") — no paths, no traversal. */
const PLAYLIST_NAME = /^[\w-]+\.m3u8$/;
const MASTER = 'index.m3u8';
/** The lowest rung of the transcoder's ladder (see BITRATES_KBPS in backend/ingest/transcode.ts). */
const LOW_VARIANT = 'index_64k.m3u8';

/** Drops every #EXT-X-STREAM-INF entry (tag line + its URI line) except the 64k one. */
export function keepLowVariant(master: string): string {
  const lines = master.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) {
      out.push(lines[i]);
      continue;
    }
    const uri = lines[i + 1]?.trim();
    if (uri === LOW_VARIANT) out.push(lines[i], lines[i + 1]);
    i++; // skip the URI line either way
  }
  return out.join('\n');
}

/**
 * Serves a track's HLS playlist with every link rewritten so no cookies are needed:
 *   - variant playlists ("index_128k.m3u8") -> back through this API, so they get rewritten too
 *   - audio segments ("index_128k_00001.ts") -> /stream/{id}/<segment>?Policy=...&Signature=...&Key-Pair-Id=...
 * One signature covers the whole track; CloudFront ignores the query string when caching, so caching still works.
 * lowOnly (spend switch 'degraded'): the master lists only the 64k version, and a request for any other
 * version (e.g. from a master the browser kept from before the switch) gets the 64k one instead.
 * Returns undefined if the playlist doesn't exist.
 */
export async function signedPlaylist(
  trackId: string,
  file: string,
  ttlSeconds: number,
  lowOnly = false,
): Promise<string | undefined> {
  if (!PLAYLIST_NAME.test(file)) return undefined;
  const isMaster = file === MASTER;
  const key = lowOnly && !isMaster ? LOW_VARIANT : file;

  let text: string;
  try {
    const obj = await s3.send(new GetObjectCommand({
      Bucket: process.env.MEDIA_BUCKET!,
      Key: `stream/${trackId}/${key}`,
    }));
    text = await obj.Body!.transformToString();
  } catch (err) {
    if (err instanceof NoSuchKey) return undefined;
    throw err;
  }

  if (lowOnly && isMaster) text = keepLowVariant(text);

  const query = await signedStreamQuery(trackId, ttlSeconds);
  return text
    .split(/\r?\n/)
    .map((line) => {
      const ref = line.trim();
      if (!ref || ref.startsWith('#')) return line;
      return ref.endsWith('.m3u8')
        ? `/api/tracks/${trackId}/hls/${ref}`
        : `/stream/${trackId}/${ref}?${query}`;
    })
    .join('\n');
}
