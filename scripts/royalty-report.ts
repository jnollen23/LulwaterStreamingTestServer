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
import { type DayRow, minutes, producerTotals, summarize, toCsv } from './royalties.js';

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

const sorted = summarize(rows);

const outDir = path.join(root, 'reports');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `royalties-${month}.csv`);
writeFileSync(outFile, toCsv(month, sorted), 'utf8');

const totals = producerTotals(sorted);
console.log(`Royalties for ${month}: ${sorted.length} song/plan lines`);
for (const [producer, t] of totals) console.log(`  ${producer}: ${t.plays} plays, ${minutes(t.seconds)} minutes`);
console.log(`Saved ${outFile}`);
