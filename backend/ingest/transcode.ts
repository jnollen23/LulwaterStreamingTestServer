import { spawn } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import { access, chmod, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

/** Adaptive bitrate ladder — the player picks the best one the connection can sustain. */
const BITRATES_KBPS = [64, 128, 256];
const SEGMENT_SECONDS = 6;

/** Shipped in the ffmpeg Lambda layer (layers/ffmpeg/bin/ffmpeg -> /opt/bin/ffmpeg). */
const LAYER_FFMPEG = '/opt/bin/ffmpeg';
let ffmpegPath: Promise<string> | undefined;

/**
 * FLAC in -> audio-only HLS out (AAC in MPEG-TS segments), uploaded to s3://<bucket>/stream/<trackId>/.
 * Produces index.m3u8 (master playlist) plus index_<kbps>k.m3u8 + segments per bitrate.
 * Returns the source duration in ms (from ffmpeg's input probe), if it could be read.
 */
export async function transcodeToHls(bucket: string, sourceKey: string, trackId: string): Promise<number | undefined> {
  const work = path.join('/tmp', trackId);
  const input = path.join(work, 'source' + path.extname(sourceKey));
  const out = path.join(work, 'hls');
  await mkdir(out, { recursive: true });

  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: sourceKey }));
    await pipeline(obj.Body as Readable, createWriteStream(input));

    const stderr = await runFfmpeg([
      '-hide_banner', '-nostdin', '-y',
      '-i', input,
      ...BITRATES_KBPS.flatMap(() => ['-map', '0:a:0']), // one copy of the audio per rendition; drops cover-art "video"
      '-map_metadata', '-1',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      ...BITRATES_KBPS.flatMap((kbps, i) => [`-b:a:${i}`, `${kbps}k`]),
      '-f', 'hls',
      '-hls_time', String(SEGMENT_SECONDS),
      '-hls_playlist_type', 'vod',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(out, 'index_%v_%05d.ts'),
      '-master_pl_name', 'index.m3u8',
      '-var_stream_map', BITRATES_KBPS.map((kbps, i) => `a:${i},name:${kbps}k`).join(' '),
      path.join(out, 'index_%v.m3u8'),
    ]);

    // Upload segments first and the master playlist last, so the track is never half-visible.
    const files = (await readdir(out)).sort((a, b) => rank(a) - rank(b));
    for (const name of files) {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: `stream/${trackId}/${name}`,
        Body: await readFile(path.join(out, name)),
        ContentType: name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
        CacheControl: 'public, max-age=31536000, immutable',
      }));
    }

    return parseDurationMs(stderr);
  } finally {
    await rm(work, { recursive: true, force: true }); // /tmp survives between warm invocations
  }
}

/** Song-list thumbnails show at 40 CSS px; 120 covers 3x phone screens. */
const THUMB_PX = 120;

/** Cover art (any format ffmpeg reads) -> small square JPEG, centre-cropped, for the song lists. */
export async function makeThumbnail(image: Uint8Array, trackId: string): Promise<Buffer> {
  const work = path.join('/tmp', `thumb-${trackId}`);
  await mkdir(work, { recursive: true });
  try {
    const input = path.join(work, 'cover');
    const output = path.join(work, 'thumb.jpg');
    await writeFile(input, image);
    await runFfmpeg([
      '-hide_banner', '-nostdin', '-y',
      '-i', input,
      '-vf', `scale=${THUMB_PX}:${THUMB_PX}:force_original_aspect_ratio=increase,crop=${THUMB_PX}:${THUMB_PX}`,
      '-frames:v', '1',
      '-q:v', '3', // JPEG quality, 2 (best) to 31
      output,
    ]);
    return await readFile(output);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function rank(name: string): number {
  if (name === 'index.m3u8') return 2;
  return name.endsWith('.m3u8') ? 1 : 0;
}

/** "Duration: 00:03:21.45," from ffmpeg's input summary -> 201450 */
function parseDurationMs(stderr: string): number | undefined {
  const m = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!m) return undefined;
  return Math.round(((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000);
}

function runFfmpeg(args: string[]): Promise<string> {
  return getFfmpeg().then((bin) => new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().split('\n').slice(-5).join(' | ')}`));
    });
  }));
}

/**
 * Layers zipped on Windows lose the Unix execute bit, so if /opt/bin/ffmpeg isn't executable
 * copy it to /tmp (writable) and chmod it there. Done once per Lambda container.
 */
function getFfmpeg(): Promise<string> {
  ffmpegPath ??= (async () => {
    try {
      await access(LAYER_FFMPEG, constants.X_OK);
      return LAYER_FFMPEG;
    } catch {
      const local = '/tmp/ffmpeg';
      await copyFile(LAYER_FFMPEG, local);
      await chmod(local, 0o755);
      return local;
    }
  })();
  return ffmpegPath;
}
