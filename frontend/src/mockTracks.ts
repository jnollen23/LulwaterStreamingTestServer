import type { Track } from './api';

/** Dev-only sample library (`npm run dev:mock`) so the layout can be checked without the deployed API. */
const GENRES = ['Worship', 'Hymns', 'Gospel', 'Country', 'Acoustic', 'Instrumental', 'Choir', 'Christmas', 'Bluegrass', 'Southern gospel'];
const ARTISTS = ['Lullwater Choir', 'Grace Hill', 'The Riverside Trio', 'Anna Marsh', 'Cedar Lane'];

export const MOCK_TRACKS: Track[] = Array.from({ length: 40 }, (_, i) => ({
  trackId: `mock-${i + 1}`,
  title: i % 7 === 3 ? `A much longer song title that will not fit on one line ${i + 1}` : `Song title ${i + 1}`,
  artist: ARTISTS[i % ARTISTS.length],
  genres: [GENRES[i % 4], GENRES[(i * 3 + 4) % GENRES.length]],
  durationMs: (150 + ((i * 37) % 140)) * 1000,
  likes: (i * 13) % 5 === 0 ? 0 : (i * 13) % 60,
}));
