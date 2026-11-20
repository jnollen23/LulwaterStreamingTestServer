import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../../backend/api/handler.js';
import { signedPlaylist } from '../../backend/api/playlist.js';
import { matchRoute } from '../../backend/api/routes.js';
import { addLike, getTrack, listReadyTracks, type Track } from '../../backend/shared/catalog.js';
import { recordListen, startListen } from '../../backend/shared/plays.js';
import { signedStreamCookies } from '../../backend/shared/signing.js';
import { getStreamingMode } from '../../backend/shared/streamingMode.js';

// Everything that talks to AWS is replaced; the routing, validation and spend-switch rules are the real code.
vi.mock('../../backend/shared/catalog.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../backend/shared/catalog.js')>()),
  getTrack: vi.fn(),
  listReadyTracks: vi.fn(),
  addLike: vi.fn(),
}));
vi.mock('../../backend/shared/plays.js', () => ({ startListen: vi.fn(), recordListen: vi.fn() }));
vi.mock('../../backend/shared/signing.js', () => ({ signedStreamCookies: vi.fn() }));
vi.mock('../../backend/shared/streamingMode.js', () => ({ getStreamingMode: vi.fn() }));
vi.mock('../../backend/api/playlist.js', () => ({ signedPlaylist: vi.fn() }));

const track = (over: Partial<Track> = {}): Track => ({
  trackId: 't1', title: 'Song', status: 'READY', sourceKey: 'raw/song.flac', createdAt: '2026-11-01',
  lyrics: 'la la', ...over,
});

function request(method: string, path: string, body?: unknown, base64 = false): APIGatewayProxyEventV2 {
  let text = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  if (text && base64) text = Buffer.from(text).toString('base64');
  return {
    rawPath: path, body: text, isBase64Encoded: base64,
    requestContext: { http: { method } }, headers: {},
  } as unknown as APIGatewayProxyEventV2;
}

async function call(method: string, path: string, body?: unknown, base64 = false) {
  const res = await handler(request(method, path, body, base64));
  return { ...res, json: typeof res.body === 'string' && res.headers?.['content-type'] === 'application/json' ? JSON.parse(res.body) : undefined };
}

beforeEach(() => {
  vi.mocked(getTrack).mockResolvedValue(track());
  vi.mocked(getStreamingMode).mockResolvedValue('normal');
});

describe('matchRoute', () => {
  it('captures and decodes path parameters, with or without a trailing slash', () => {
    expect(matchRoute('GET', '/api/tracks/a%20b')?.params).toEqual({ id: 'a b' });
    expect(matchRoute('GET', '/api/tracks/t1/')?.params).toEqual({ id: 't1' });
    expect(matchRoute('GET', '/api/tracks/t1/hls/index.m3u8')?.params).toEqual({ id: 't1', file: 'index.m3u8' });
  });

  it('matches on method and the whole path', () => {
    expect(matchRoute('DELETE', '/api/tracks')).toBeUndefined();
    expect(matchRoute('GET', '/api/tracks/t1/extra')).toBeUndefined();
    expect(matchRoute('GET', '/x/api/tracks')).toBeUndefined();
  });
});

describe('API handler', () => {
  it('404s unknown routes', async () => {
    expect((await call('GET', '/api/nope')).statusCode).toBe(404);
  });

  it('turns an unexpected error into a 500 without details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getTrack).mockRejectedValue(new Error('secret table name'));
    const res = await call('GET', '/api/tracks/t1');
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret');
  });

  it('never lets responses be cached', async () => {
    expect((await call('GET', '/api/me')).headers?.['cache-control']).toBe('no-store');
  });
});

describe('GET /api/tracks', () => {
  it('sorts by artist, album, track number, title and leaves out About text and internals', async () => {
    vi.mocked(listReadyTracks).mockResolvedValue([
      track({ trackId: 'c', artist: 'B', title: 'Z' }),
      track({ trackId: 'b', artist: 'A', album: 'X', trackNumber: 2, title: 'A' }),
      track({ trackId: 'a', artist: 'A', album: 'X', trackNumber: 1, title: 'Z' }),
      track({ trackId: 'd', title: 'No artist' }),
    ]);
    const { json } = await call('GET', '/api/tracks');
    expect(json.tracks.map((t: Track) => t.trackId)).toEqual(['d', 'a', 'b', 'c']);
    for (const t of json.tracks) {
      expect(t).not.toHaveProperty('lyrics');
      expect(t).not.toHaveProperty('sourceKey');
      expect(t).not.toHaveProperty('status');
    }
  });
});

describe('GET /api/tracks/{id}', () => {
  it('includes the About text but not internals', async () => {
    const { statusCode, json } = await call('GET', '/api/tracks/t1');
    expect(statusCode).toBe(200);
    expect(json.track.lyrics).toBe('la la');
    expect(json.track).not.toHaveProperty('sourceKey');
  });

  it.each(['PROCESSING', 'ERROR'] as const)('hides a %s track', async (status) => {
    vi.mocked(getTrack).mockResolvedValue(track({ status }));
    expect((await call('GET', '/api/tracks/t1')).statusCode).toBe(404);
  });
});

describe('POST /api/tracks/{id}/play', () => {
  it('url mode: returns the API playlist link and sets no cookies', async () => {
    const res = await call('POST', '/api/tracks/t1/play');
    expect(res.json).toEqual({ streamUrl: '/api/tracks/t1/hls/index.m3u8' });
    expect(res.cookies).toBeUndefined();
  });

  it('cookie mode: sets signed cookies and returns the direct link', async () => {
    vi.stubEnv('STREAM_SIGNING_MODE', 'cookie');
    vi.mocked(signedStreamCookies).mockResolvedValue(['CloudFront-Policy=x']);
    const res = await call('POST', '/api/tracks/t1/play');
    expect(res.json).toEqual({ streamUrl: '/stream/t1/index.m3u8' });
    expect(res.cookies).toEqual(['CloudFront-Policy=x']);
    expect(vi.mocked(signedStreamCookies)).toHaveBeenCalledWith('t1', 4 * 60 * 60);
  });

  it('spend switch off: free listeners get the "paused for today" message', async () => {
    vi.mocked(getStreamingMode).mockResolvedValue('off');
    const res = await call('POST', '/api/tracks/t1/play');
    expect(res.statusCode).toBe(503);
    expect(res.json.code).toBe('FREE_PAUSED');
  });

  it('404s a track that is not ready', async () => {
    vi.mocked(getTrack).mockResolvedValue(undefined);
    expect((await call('POST', '/api/tracks/t1/play')).statusCode).toBe(404);
  });
});

describe('GET /api/tracks/{id}/hls/{file}', () => {
  it('serves the signed playlist, cacheable in the browser only', async () => {
    vi.mocked(signedPlaylist).mockResolvedValue('#EXTM3U');
    const res = await call('GET', '/api/tracks/t1/hls/index.m3u8');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('#EXTM3U');
    expect(res.headers).toMatchObject({ 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'private, max-age=600' });
    expect(vi.mocked(signedPlaylist)).toHaveBeenCalledWith('t1', 'index.m3u8', 4 * 60 * 60, false);
  });

  it('spend switch degraded: asks for 64k only', async () => {
    vi.mocked(getStreamingMode).mockResolvedValue('degraded');
    vi.mocked(signedPlaylist).mockResolvedValue('#EXTM3U');
    await call('GET', '/api/tracks/t1/hls/index.m3u8');
    expect(vi.mocked(signedPlaylist)).toHaveBeenCalledWith('t1', 'index.m3u8', 4 * 60 * 60, true);
  });

  it('spend switch off: refuses playlists too (a phone may hold an old play link)', async () => {
    vi.mocked(getStreamingMode).mockResolvedValue('off');
    expect((await call('GET', '/api/tracks/t1/hls/index.m3u8')).statusCode).toBe(503);
    expect(vi.mocked(signedPlaylist)).not.toHaveBeenCalled();
  });

  it('404s a missing playlist', async () => {
    vi.mocked(signedPlaylist).mockResolvedValue(undefined);
    expect((await call('GET', '/api/tracks/t1/hls/index_999k.m3u8')).statusCode).toBe(404);
  });
});

describe('POST /api/tracks/{id}/like', () => {
  it('returns the new count, or 404 for a track that cannot be liked', async () => {
    vi.mocked(addLike).mockResolvedValueOnce(7).mockResolvedValueOnce(undefined);
    expect((await call('POST', '/api/tracks/t1/like')).json).toEqual({ likes: 7 });
    expect((await call('POST', '/api/tracks/t1/like')).statusCode).toBe(404);
  });
});

describe('POST /api/plays', () => {
  it('opens a listen on the Free plan', async () => {
    vi.mocked(startListen).mockResolvedValue('p1');
    const res = await call('POST', '/api/plays', { trackId: 't1' });
    expect(res.json).toEqual({ playId: 'p1' });
    expect(vi.mocked(startListen)).toHaveBeenCalledWith(expect.objectContaining({ trackId: 't1' }), 'free');
  });

  it('reads a base64-encoded body', async () => {
    vi.mocked(startListen).mockResolvedValue('p1');
    expect((await call('POST', '/api/plays', { trackId: 't1' }, true)).statusCode).toBe(200);
  });

  it.each([
    ['no body', undefined],
    ['broken JSON', '{"trackId":'],
    ['JSON that is not an object', '"t1"'],
    ['a non-string trackId', { trackId: 5 }],
  ])('400s %s', async (_label, body) => {
    expect((await call('POST', '/api/plays', body)).statusCode).toBe(400);
    expect(vi.mocked(startListen)).not.toHaveBeenCalled();
  });

  it('404s a track that is not ready', async () => {
    vi.mocked(getTrack).mockResolvedValue(track({ status: 'PROCESSING' }));
    expect((await call('POST', '/api/plays', { trackId: 't1' })).statusCode).toBe(404);
  });
});

describe('POST /api/plays/{playId}', () => {
  it('records the running total', async () => {
    vi.mocked(recordListen).mockResolvedValue(true);
    expect((await call('POST', '/api/plays/p1', { seconds: 42 })).json).toEqual({ ok: true });
    expect(vi.mocked(recordListen)).toHaveBeenCalledWith('p1', 42);
  });

  it('400s a missing or non-number seconds value', async () => {
    expect((await call('POST', '/api/plays/p1', {})).statusCode).toBe(400);
    expect((await call('POST', '/api/plays/p1', { seconds: '42' })).statusCode).toBe(400);
    expect(vi.mocked(recordListen)).not.toHaveBeenCalled();
  });

  it('404s an unknown or expired listen', async () => {
    vi.mocked(recordListen).mockResolvedValue(false);
    expect((await call('POST', '/api/plays/p1', { seconds: 42 })).statusCode).toBe(404);
  });
});
