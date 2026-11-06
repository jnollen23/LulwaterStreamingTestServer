import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { User } from '../shared/auth.js';
import { addLike, getTrack, listReadyTracks, toPublic } from '../shared/catalog.js';
import { recordListen, startListen, type Tier } from '../shared/plays.js';
import { signedStreamCookies } from '../shared/signing.js';
import { getStreamingMode, type StreamingMode } from '../shared/streamingMode.js';
import { signedPlaylist } from './playlist.js';

export interface RouteContext {
  event: APIGatewayProxyEventV2;
  params: Record<string, string>;
  user: User | null;
}

export interface Route {
  method: string;
  path: string;
  /** LOGIN HOOK — flip to true to require a signed-in user once auth exists. */
  requireAuth: boolean;
  handler: (ctx: RouteContext) => Promise<APIGatewayProxyStructuredResultV2>;
}

/** How long a play request's stream access (signed links or cookies) stays valid. */
const STREAM_ACCESS_TTL_SECONDS = 4 * 60 * 60;

export const json = (statusCode: number, body: unknown, cookies?: string[]): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
  cookies,
});

/** The JSON body of a request, or {} if there isn't a valid one. */
function body(event: APIGatewayProxyEventV2): Record<string, unknown> {
  if (!event.body) return {};
  try {
    const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// TODO(accounts): read the listener's plan from their account once sign-in exists; everyone is Free until then.
const tierOf = (_user: User | null): Tier => 'free';

/** The spend switch as it applies to this listener: subscribers always get 'normal'. */
async function modeFor(user: User | null): Promise<StreamingMode> {
  return tierOf(user) === 'free' ? getStreamingMode() : 'normal';
}

/** Spend switch 'off': the website shows a friendly "paused for today" message for this code. */
const freePaused = () => json(503, {
  error: 'Free listening is paused for today. It will be back after midnight Eastern time.',
  code: 'FREE_PAUSED',
});

export const routes: Route[] = [
  {
    method: 'GET',
    path: '/api/me',
    requireAuth: false,
    handler: async ({ user }) => json(200, { user }),
  },
  {
    method: 'GET',
    path: '/api/tracks',
    requireAuth: false,
    handler: async () => {
      const tracks = (await listReadyTracks())
        .map(toPublic)
        .sort((a, b) =>
          (a.artist ?? '').localeCompare(b.artist ?? '') ||
          (a.album ?? '').localeCompare(b.album ?? '') ||
          (a.trackNumber ?? 0) - (b.trackNumber ?? 0) ||
          a.title.localeCompare(b.title));
      return json(200, { tracks });
    },
  },
  {
    method: 'GET',
    path: '/api/tracks/{id}',
    requireAuth: false,
    handler: async ({ params }) => {
      const track = await getTrack(params.id);
      if (!track || track.status !== 'READY') return json(404, { error: 'Track not found' });
      return json(200, { track: toPublic(track) });
    },
  },
  {
    method: 'POST',
    path: '/api/tracks/{id}/play',
    requireAuth: false,
    handler: async ({ params, user }) => {
      const track = await getTrack(params.id);
      if (!track || track.status !== 'READY') return json(404, { error: 'Track not found' });
      if ((await modeFor(user)) === 'off') return freePaused();
      // TODO(spend-switch): cookie mode serves the full-quality master straight from CloudFront, so 'degraded'
      // only works in 'url' mode (the current setting).
      if (process.env.STREAM_SIGNING_MODE === 'cookie') {
        const cookies = await signedStreamCookies(track.trackId, STREAM_ACCESS_TTL_SECONDS);
        return json(200, { streamUrl: `/stream/${track.trackId}/index.m3u8` }, cookies);
      }
      // 'url' mode: the playlist below hands out signed links, so nothing is stored in the browser.
      return json(200, { streamUrl: `/api/tracks/${track.trackId}/hls/index.m3u8` });
    },
  },
  {
    method: 'POST',
    path: '/api/tracks/{id}/like',
    requireAuth: false,
    handler: async ({ params }) => {
      const likes = await addLike(params.id);
      if (likes === undefined) return json(404, { error: 'Track not found' });
      return json(200, { likes });
    },
  },
  {
    // Royalty play log, step 1: a song has started playing (new song, or the same one from the top again).
    method: 'POST',
    path: '/api/plays',
    requireAuth: false,
    handler: async ({ event, user }) => {
      const trackId = body(event).trackId;
      if (typeof trackId !== 'string') return json(400, { error: 'trackId required' });
      const track = await getTrack(trackId);
      if (!track || track.status !== 'READY') return json(404, { error: 'Track not found' });
      return json(200, { playId: await startListen(track, tierOf(user)) });
    },
  },
  {
    // Step 2, repeated: running total of seconds actually heard. A play counts once it passes 30 seconds.
    method: 'POST',
    path: '/api/plays/{playId}',
    requireAuth: false,
    handler: async ({ event, params }) => {
      const seconds = body(event).seconds;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return json(400, { error: 'seconds required' });
      if (!(await recordListen(params.playId, seconds))) return json(404, { error: 'Play not found' });
      return json(200, { ok: true });
    },
  },
  {
    method: 'GET',
    path: '/api/tracks/{id}/hls/{file}',
    requireAuth: false,
    handler: async ({ params, user }) => {
      const track = await getTrack(params.id);
      if (!track || track.status !== 'READY') return json(404, { error: 'Track not found' });
      const mode = await modeFor(user);
      if (mode === 'off') return freePaused();
      const body = await signedPlaylist(track.trackId, params.file, STREAM_ACCESS_TTL_SECONDS, mode === 'degraded');
      if (body === undefined) return json(404, { error: 'Playlist not found' });
      return {
        statusCode: 200,
        // The signed links inside stay valid for hours, so let the phone reuse this playlist briefly
        // (replays and going back to a song skip the API round-trip). 'private': browser only, never CloudFront.
        headers: { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'private, max-age=600' },
        body,
      };
    },
  },
];

/** Converts "/api/tracks/{id}" into a regex and returns the captured params on match. */
export function matchRoute(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
  for (const route of routes) {
    if (route.method !== method) continue;
    const names: string[] = [];
    const pattern = route.path.replace(/\{(\w+)\}/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
    const m = new RegExp(`^${pattern}/?$`).exec(path);
    if (m) {
      return { route, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
    }
  }
  return undefined;
}
