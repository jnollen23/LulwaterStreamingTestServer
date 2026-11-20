import { describe, expect, it } from 'vitest';
import { cell, type DayRow, producerTotals, summarize, toCsv } from '../../scripts/royalties.js';

const row = (over: Partial<DayRow>): DayRow => ({
  trackId: 't1', day: '2026-10-01', tier: 'free', title: 'Song', artist: 'Band', producer: 'Prod', plays: 1, seconds: 60, ...over,
});

describe('summarize', () => {
  it('adds up the days of one song on one plan', () => {
    const lines = summarize([row({}), row({ day: '2026-10-02', plays: 2, seconds: 120 }), row({ day: '2026-10-03', plays: undefined, seconds: undefined })]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ plays: 3, seconds: 180 });
  });

  it('keeps each plan on its own line', () => {
    const lines = summarize([row({ tier: 'free' }), row({ tier: 'basic' })]);
    expect(lines.map((l) => l.tier)).toEqual(['basic', 'free']);
  });

  it("uses the latest day's names whatever order the rows come in", () => {
    const lines = summarize([
      row({ day: '2026-10-20', title: 'New title', producer: 'New prod' }),
      row({ day: '2026-10-01', title: 'Old title', producer: '(not set)' }),
      row({ day: '2026-10-10', title: 'Mid title', producer: 'Mid prod' }),
    ]);
    expect(lines[0]).toMatchObject({ title: 'New title', producer: 'New prod', plays: 3 });
  });

  it('sorts by producer, artist, title, plan', () => {
    const lines = summarize([
      row({ trackId: 'a', producer: 'Zed' }),
      row({ trackId: 'b', producer: 'Amy', artist: 'B' }),
      row({ trackId: 'c', producer: 'Amy', artist: 'A', title: 'Y' }),
      row({ trackId: 'd', producer: 'Amy', artist: 'A', title: 'X' }),
    ]);
    expect(lines.map((l) => l.trackId)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('is empty for a month with no plays', () => {
    expect(summarize([])).toEqual([]);
  });
});

describe('CSV', () => {
  it('quotes cells with commas, quotes or line breaks', () => {
    expect(cell('plain')).toBe('plain');
    expect(cell('Smith, John')).toBe('"Smith, John"');
    expect(cell('The "Best" Song')).toBe('"The ""Best"" Song"');
    expect(cell('two\nlines')).toBe('"two\nlines"');
    expect(cell(undefined)).toBe('');
    expect(cell(3)).toBe('3');
  });

  it('writes a header and one line per song per plan, minutes to one decimal, CRLF line ends', () => {
    const csv = toCsv('2026-10', summarize([row({ seconds: 95, artist: undefined, title: 'Hello, World' })]));
    expect(csv).toBe(
      'Month,Producer,Artist,Title,Plan,Plays,Minutes listened,Track id\r\n'
      + '2026-10,Prod,,"Hello, World",free,1,1.6,t1\r\n',
    );
  });
});

describe('producerTotals', () => {
  it('adds up each producer across songs and plans', () => {
    const totals = producerTotals(summarize([
      row({ trackId: 'a', producer: 'Amy', plays: 2, seconds: 100 }),
      row({ trackId: 'a', producer: 'Amy', tier: 'basic', plays: 1, seconds: 50 }),
      row({ trackId: 'b', producer: 'Bob', plays: 5, seconds: 10 }),
    ]));
    expect(Object.fromEntries(totals)).toEqual({ Amy: { plays: 3, seconds: 150 }, Bob: { plays: 5, seconds: 10 } });
  });
});
