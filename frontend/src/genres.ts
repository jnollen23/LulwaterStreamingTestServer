import type { Track } from './api';

export type GenreMode = 'any' | 'all';

export interface GenreFilter {
  genres: string[];
  mode: GenreMode;
  /** Set when the filter came from one of the quick genre buttons on the home screen. */
  quick?: boolean;
}

const norm = (g: string) => g.trim().toLowerCase();

export function matchesGenres(track: Track, filter: GenreFilter | null): boolean {
  if (!filter || filter.genres.length === 0) return true;
  const own = new Set((track.genres ?? []).map(norm));
  const wanted = filter.genres.map(norm);
  return filter.mode === 'all' ? wanted.every((g) => own.has(g)) : wanted.some((g) => own.has(g));
}

/**
 * Every genre in the library, most common first.
 * TODO(genres): genres come straight from the FLAC GENRE tags. If the list gets messy (spelling variants,
 * too many niche genres), replace this with a curated list or a mapping table.
 */
export function genresByPopularity(tracks: Track[]): string[] {
  const counts = new Map<string, { name: string; n: number }>();
  for (const t of tracks) {
    for (const g of t.genres ?? []) {
      const entry = counts.get(norm(g)) ?? { name: g.trim(), n: 0 };
      entry.n++;
      counts.set(norm(g), entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).map((e) => e.name);
}
