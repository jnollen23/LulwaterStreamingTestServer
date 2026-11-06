/**
 * Monthly royalty report from the play log.
 *
 *   npm run royalty-report -- 2026-10 --table <PlaysTableName>
 *
 * The table name is the PlaysTableName output printed by `npm run deploy` (or set PLAYS_TABLE instead of --table).
 * Writes reports/royalties-<month>.csv — one row per song per plan — and prints each producer's totals.
 * Months follow US Eastern dates, the same clock as the free-hour reset.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const REGION = 'us-east-2';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const month = args.find((a) => /^\d{4}-\d{2}$/.test(a));
const tableArg = args.indexOf('--table');
const table = tableArg >= 0 ? args[tableArg + 1] : process.env.PLAYS_TABLE;
if (!month || !table) {
  console.error('Usage: npm run royalty-report -- <yyyy-mm> --table <PlaysTableName>');
  process.exit(1);
}

interface DayRow {
  trackId: string;
  day: string;
  tier: string;
  title: string;
  artist?: string;
  producer: string;
  plays?: number;
  seconds?: number;
}

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const rows: DayRow[] = [];
let ExclusiveStartKey: Record<string, unknown> | undefined;
do {
  const res = await db.send(new ScanCommand({
    TableName: table,
    FilterExpression: 'begins_with(pk, :track) AND begins_with(sk, :month)',
    ExpressionAttributeValues: { ':track': 'TRACK#', ':month': `${month}-` },
    ExclusiveStartKey,
  }));
  rows.push(...((res.Items ?? []) as DayRow[]));
  ExclusiveStartKey = res.LastEvaluatedKey;
} while (ExclusiveStartKey);

// Days -> one line per song per plan. Rows are scanned in no particular order, so keep the latest day's names.
const lines = new Map<string, DayRow & { plays: number; seconds: number }>();
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

const sorted = [...lines.values()].sort((a, b) =>
  a.producer.localeCompare(b.producer) || (a.artist ?? '').localeCompare(b.artist ?? '')
  || a.title.localeCompare(b.title) || a.tier.localeCompare(b.tier));

const cell = (v: string | number | undefined) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const minutes = (seconds: number) => (seconds / 60).toFixed(1);
const csv = [
  ['Month', 'Producer', 'Artist', 'Title', 'Plan', 'Plays', 'Minutes listened', 'Track id'].join(','),
  ...sorted.map((l) => [month, l.producer, l.artist, l.title, l.tier, l.plays, minutes(l.seconds), l.trackId].map(cell).join(',')),
].join('\r\n');

const outDir = path.join(root, 'reports');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `royalties-${month}.csv`);
writeFileSync(outFile, csv + '\r\n', 'utf8');

const totals = new Map<string, { plays: number; seconds: number }>();
for (const l of sorted) {
  const t = totals.get(l.producer) ?? { plays: 0, seconds: 0 };
  t.plays += l.plays;
  t.seconds += l.seconds;
  totals.set(l.producer, t);
}
console.log(`Royalties for ${month}: ${sorted.length} song/plan lines`);
for (const [producer, t] of totals) console.log(`  ${producer}: ${t.plays} plays, ${minutes(t.seconds)} minutes`);
console.log(`Saved ${outFile}`);
