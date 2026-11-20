import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keepLowVariant, signedPlaylist } from '../../backend/api/playlist.js';

vi.mock('../../backend/shared/signing.js', () => ({ signedStreamQuery: async () => 'Policy=P&Signature=S&Key-Pair-Id=K' }));

const s3 = mockClient(S3Client);

const MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-STREAM-INF:BANDWIDTH=70400,CODECS="mp4a.40.2"',
  'index_64k.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=140800,CODECS="mp4a.40.2"',
  'index_128k.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=281600,CODECS="mp4a.40.2"',
  'index_256k.m3u8',
  '',
].join('\n');

const VARIANT = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:6.0,', 'index_128k_00000.ts', '#EXTINF:3.2,', 'index_128k_00001.ts', '#EXT-X-ENDLIST'].join('\n');

/** S3 returns `text` for the given key. */
function stored(key: string, text: string) {
  s3.on(GetObjectCommand, { Key: key }).resolves({ Body: { transformToString: async () => text } } as never);
}

beforeEach(() => {
  s3.reset();
  vi.stubEnv('MEDIA_BUCKET', 'media-bucket');
});

describe('keepLowVariant', () => {
  it('keeps only the 64k version and every non-variant line', () => {
    expect(keepLowVariant(MASTER)).toBe([
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-STREAM-INF:BANDWIDTH=70400,CODECS="mp4a.40.2"',
      'index_64k.m3u8',
      '',
    ].join('\n'));
  });

  it('handles Windows line endings', () => {
    expect(keepLowVariant(MASTER.replace(/\n/g, '\r\n'))).not.toContain('index_128k');
  });
});

describe('signedPlaylist', () => {
  it('refuses anything but a plain playlist file name (no path tricks)', async () => {
    for (const file of ['../secret.m3u8', 'a/b.m3u8', 'index.ts', 'index.m3u8.txt', '']) {
      expect(await signedPlaylist('t1', file, 3600)).toBeUndefined();
    }
    expect(s3.calls()).toHaveLength(0);
  });

  it('returns undefined for a playlist that does not exist', async () => {
    s3.on(GetObjectCommand).rejects(new NoSuchKey({ message: 'no', $metadata: {} }));
    expect(await signedPlaylist('t1', 'index.m3u8', 3600)).toBeUndefined();
  });

  it('passes other S3 errors on', async () => {
    s3.on(GetObjectCommand).rejects(new Error('S3 down'));
    await expect(signedPlaylist('t1', 'index.m3u8', 3600)).rejects.toThrow('S3 down');
  });

  it('points variant playlists back through the API', async () => {
    stored('stream/t1/index.m3u8', MASTER);
    const out = await signedPlaylist('t1', 'index.m3u8', 3600);
    expect(out).toContain('\n/api/tracks/t1/hls/index_64k.m3u8\n');
    expect(out).toContain('\n/api/tracks/t1/hls/index_256k.m3u8\n');
    expect(out).toContain('#EXT-X-STREAM-INF:BANDWIDTH=70400,CODECS="mp4a.40.2"'); // tags untouched
    expect(s3.commandCalls(GetObjectCommand)[0].args[0].input).toEqual({ Bucket: 'media-bucket', Key: 'stream/t1/index.m3u8' });
  });

  it('turns segments into signed CloudFront links', async () => {
    stored('stream/t1/index_128k.m3u8', VARIANT);
    const out = (await signedPlaylist('t1', 'index_128k.m3u8', 3600))!.split('\n');
    expect(out).toContain('/stream/t1/index_128k_00000.ts?Policy=P&Signature=S&Key-Pair-Id=K');
    expect(out).toContain('#EXTINF:6.0,');
    expect(out.at(-1)).toBe('#EXT-X-ENDLIST');
  });

  it('degraded: the master lists only 64k', async () => {
    stored('stream/t1/index.m3u8', MASTER);
    const out = await signedPlaylist('t1', 'index.m3u8', 3600, true);
    expect(out).toContain('/api/tracks/t1/hls/index_64k.m3u8');
    expect(out).not.toContain('128k');
    expect(out).not.toContain('256k');
  });

  it('degraded: asking for a higher version (from an old master) serves 64k instead', async () => {
    stored('stream/t1/index_64k.m3u8', VARIANT.replace(/128k/g, '64k'));
    const out = await signedPlaylist('t1', 'index_256k.m3u8', 3600, true);
    expect(s3.commandCalls(GetObjectCommand)[0].args[0].input.Key).toBe('stream/t1/index_64k.m3u8');
    expect(out).toContain('/stream/t1/index_64k_00000.ts?');
  });
});
