export interface Track {
  trackId: string;
  title: string;
  artist?: string;
  album?: string;
  trackNumber?: number;
  year?: number;
  genres?: string[];
  durationMs?: number;
  artPath?: string;
  /** Small version of artPath for song lists; older songs may not have one until the backfill runs. */
  thumbPath?: string;
  likes?: number;
  // TODO(song-info): the catalog doesn't store these yet (FLAC tags don't carry them reliably), so the
  // About popup on the now-playing screen shows "Not added yet" until there's a way to enter them per song.
  lyrics?: string;
  copyright?: string;
  aiInfo?: string;
}

type TokenGetter = () => Promise<string | null>;

/** A failed API call. `code` + `userMessage` come from the API when it has something to tell the listener. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly userMessage?: string) {
    super(message);
  }
}

/** Spend switch 'off' (see backend/api/routes.ts): free listening is paused until midnight Eastern. */
export const isFreePaused = (err: unknown): err is ApiError => err instanceof ApiError && err.code === 'FREE_PAUSED';

async function request<T>(path: string, getToken: TokenGetter, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const res = await fetch(path, {
    ...init,
    headers: { ...init.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) {
    const info = await res.json().catch(() => ({})) as { error?: string; code?: string };
    throw new ApiError(`${init.method ?? 'GET'} ${path} failed: ${res.status}`, res.status, info.code, info.error);
  }
  if (!res.headers.get('content-type')?.includes('application/json')) {
    throw new Error('API not reachable (in local dev, set SITE_URL to the deployed site).');
  }
  return res.json() as Promise<T>;
}

export async function listTracks(getToken: TokenGetter): Promise<Track[]> {
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') return (await import('./mockTracks')).MOCK_TRACKS;
  return (await request<{ tracks: Track[] }>('/api/tracks', getToken)).tracks;
}

/** Returns the HLS playlist URL for a track (its links are pre-signed; in cookie mode the API also sets stream cookies). */
export async function startPlayback(trackId: string, getToken: TokenGetter): Promise<string> {
  return (await request<{ streamUrl: string }>(`/api/tracks/${trackId}/play`, getToken, { method: 'POST' })).streamUrl;
}

const MOCK = import.meta.env.DEV && import.meta.env.VITE_MOCK === '1';

/** Royalty play log: opens a listen for a song that's starting and returns its id. */
export async function startListen(trackId: string, getToken: TokenGetter): Promise<string> {
  if (MOCK) return `mock-${trackId}-${Date.now()}`;
  return (await request<{ playId: string }>('/api/plays', getToken, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ trackId }),
  })).playId;
}

/** Sends the running total of seconds heard. `keepalive` lets the last report finish while the page closes. */
export async function reportListen(playId: string, seconds: number, getToken: TokenGetter): Promise<void> {
  if (MOCK) return console.debug(`[play log] ${playId}: ${Math.floor(seconds)} s`);
  await request<{ ok: true }>(`/api/plays/${encodeURIComponent(playId)}`, getToken, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seconds: Math.floor(seconds) }),
    keepalive: true,
  });
}

/** Adds one like and returns the song's new total. */
export async function likeTrack(trackId: string, likesNow: number, getToken: TokenGetter): Promise<number> {
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') return likesNow + 1;
  return (await request<{ likes: number }>(`/api/tracks/${trackId}/like`, getToken, { method: 'POST' })).likes;
}

export function formatDuration(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return '–:––';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
