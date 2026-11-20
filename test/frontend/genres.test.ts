import { describe, expect, it } from 'vitest';
import type { Track } from '../../frontend/src/api';
import { genresByPopularity, matchesGenres } from '../../frontend/src/genres';

const song = (...genres: string[]): Track => ({ trackId: genres.join('+') || 'none', title: 'Song', genres });

describe('matchesGenres', () => {
  const both = song('Worship', 'Gospel');

  it('matches everything when no genres are picked', () => {
    expect(matchesGenres(both, null)).toBe(true);
    expect(matchesGenres(both, { genres: [], mode: 'all' })).toBe(true);
    expect(matchesGenres(song(), { genres: [], mode: 'any' })).toBe(true);
  });

  it('"any" needs one of the picked genres', () => {
    expect(matchesGenres(both, { genres: ['Gospel', 'Rock'], mode: 'any' })).toBe(true);
    expect(matchesGenres(both, { genres: ['Rock'], mode: 'any' })).toBe(false);
  });

  it('"all" needs every picked genre', () => {
    expect(matchesGenres(both, { genres: ['Gospel', 'Worship'], mode: 'all' })).toBe(true);
    expect(matchesGenres(both, { genres: ['Gospel', 'Rock'], mode: 'all' })).toBe(false);
  });

  it('ignores case and stray spaces', () => {
    expect(matchesGenres(song(' worship '), { genres: ['WORSHIP'], mode: 'all' })).toBe(true);
  });

  it('a song with no genres matches no genre filter', () => {
    expect(matchesGenres({ trackId: 'x', title: 'x' }, { genres: ['Rock'], mode: 'any' })).toBe(false);
  });
});

describe('genresByPopularity', () => {
  it('lists genres most common first, ties alphabetical', () => {
    const tracks = [song('Rock', 'Jazz'), song('Jazz'), song('Blues'), song('Jazz', 'Blues'), song('Acoustic')];
    expect(genresByPopularity(tracks)).toEqual(['Jazz', 'Blues', 'Acoustic', 'Rock']);
  });

  it('counts spelling variants of one genre together, showing the first spelling seen', () => {
    expect(genresByPopularity([song('Gospel '), song('gospel'), song('Rock')])).toEqual(['Gospel', 'Rock']);
  });

  it('is empty for an empty library', () => {
    expect(genresByPopularity([])).toEqual([]);
    expect(genresByPopularity([{ trackId: 'x', title: 'x' }])).toEqual([]);
  });
});
