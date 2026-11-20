import { describe, expect, it } from 'vitest';
import { fileTitle, splitGenres, text } from '../../backend/ingest/handler.js';
import { parseDurationMs, rank } from '../../backend/ingest/transcode.js';

describe('fileTitle', () => {
  it('uses the file name without folder or extension', () => {
    expect(fileTitle('raw/Some Artist - Some Song.flac')).toBe('Some Artist - Some Song');
    expect(fileTitle('raw/album/v1.2 mix.flac')).toBe('v1.2 mix');
    expect(fileTitle('song')).toBe('song');
  });
});

describe('splitGenres', () => {
  it('splits packed GENRE tags and removes repeats and blanks', () => {
    expect(splitGenres(['Worship; Gospel', 'Gospel', 'Rock/Pop,  Jazz ', ' '])).toEqual(['Worship', 'Gospel', 'Rock', 'Pop', 'Jazz']);
  });

  it('is undefined when there are no genres', () => {
    expect(splitGenres(undefined)).toBeUndefined();
    expect(splitGenres([])).toBeUndefined();
    expect(splitGenres([' ; '])).toBeUndefined();
  });
});

describe('text (lyrics, copyright, AI info)', () => {
  it('normalises line endings and trims', () => {
    expect(text('  line 1\r\nline 2\r\n ')).toBe('line 1\nline 2');
  });

  it('treats empty as missing', () => {
    expect(text(undefined)).toBeUndefined();
    expect(text('   \r\n')).toBeUndefined();
  });

  it('caps very long text so a mistake cannot overflow the DynamoDB row', () => {
    expect(text('x'.repeat(60_000))).toHaveLength(50_000);
  });
});

describe('parseDurationMs', () => {
  it("reads ffmpeg's Duration line", () => {
    expect(parseDurationMs('Input #0, flac\n  Duration: 00:03:21.45, start: 0.000000, bitrate: 900 kb/s')).toBe(201_450);
    expect(parseDurationMs('Duration: 01:00:00.00,')).toBe(3_600_000);
    expect(parseDurationMs('Duration: 00:00:07,')).toBe(7_000);
  });

  it('is undefined when there is no Duration line', () => {
    expect(parseDurationMs('Duration: N/A, bitrate: N/A')).toBeUndefined();
    expect(parseDurationMs('')).toBeUndefined();
  });
});

describe('rank (upload order)', () => {
  it('uploads segments, then variant playlists, then the master last', () => {
    const files = ['index.m3u8', 'index_64k.m3u8', 'index_64k_00000.ts', 'index_128k.m3u8', 'index_128k_00000.ts'];
    expect(files.sort((a, b) => rank(a) - rank(b)).at(-1)).toBe('index.m3u8');
    expect(files.slice(0, 2).every((f) => f.endsWith('.ts'))).toBe(true);
  });
});
