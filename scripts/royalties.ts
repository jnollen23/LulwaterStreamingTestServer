/** The royalty-report math, kept apart from the DynamoDB scan and file writing so it can be tested. */

/** One per-song, per-day, per-plan totals row from the PlaysTable (see backend/shared/plays.ts). */
export interface DayRow {
  trackId: string;
  day: string;
  tier: string;
  title: string;
  artist?: string;
  producer: string;
  plays?: number;
  seconds?: number;
}

export type ReportLine = DayRow & { plays: number; seconds: number };

/**
 * Days -> one line per song per plan, sorted by producer, artist, title, plan.
 * Rows come from a scan in no particular order, so the names on each line are the latest day's.
 */
export function summarize(rows: DayRow[]): ReportLine[] {
  const lines = new Map<string, ReportLine>();
  for (const r of rows) {
    const key = `${r.trackId}#${r.tier}`;
    const line = lines.get(key);
    if (!line) {
      lines.set(key, { ...r, plays: r.plays ?? 0, seconds: r.seconds ?? 0 });
      continue;
    }
    line.plays += r.plays ?? 0;
    line.seconds += r.seconds ?? 0;
    if (r.day > line.day) Object.assign(line, { day: r.day, title: r.title, artist: r.artist, producer: r.producer });
  }
  return [...lines.values()].sort((a, b) =>
    a.producer.localeCompare(b.producer) || (a.artist ?? '').localeCompare(b.artist ?? '')
    || a.title.localeCompare(b.title) || a.tier.localeCompare(b.tier));
}

export const minutes = (seconds: number) => (seconds / 60).toFixed(1);

/** One CSV cell, quoted when it holds a comma, quote or line break. */
export function cell(v: string | number | undefined): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The report as CSV text (CRLF line ends, for Excel). */
export function toCsv(month: string, lines: ReportLine[]): string {
  return [
    ['Month', 'Producer', 'Artist', 'Title', 'Plan', 'Plays', 'Minutes listened', 'Track id'].join(','),
    ...lines.map((l) => [month, l.producer, l.artist, l.title, l.tier, l.plays, minutes(l.seconds), l.trackId].map(cell).join(',')),
  ].join('\r\n') + '\r\n';
}

/** Plays and seconds per producer, across all their songs and plans. */
export function producerTotals(lines: ReportLine[]): Map<string, { plays: number; seconds: number }> {
  const totals = new Map<string, { plays: number; seconds: number }>();
  for (const l of lines) {
    const t = totals.get(l.producer) ?? { plays: 0, seconds: 0 };
    t.plays += l.plays;
    t.seconds += l.seconds;
    totals.set(l.producer, t);
  }
  return totals;
}
