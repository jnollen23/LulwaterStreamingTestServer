/**
 * Spend guard — runs every 5 minutes (EventBridge schedule).
 *
 * Adds up today's CloudFront traffic (US Eastern day, the same clock as the free-hour reset) and sets the
 * spend switch for free listeners: normal -> degraded (64k only) -> off. It returns to normal by itself after
 * midnight Eastern, when the day's total starts again from zero. A manual override (npm run streaming-mode)
 * wins over the thresholds until it is set back to 'auto'.
 *
 * CloudFront publishes its metrics only in us-east-1, so this reads CloudWatch there; everything else is local.
 */
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { GetParameterCommand, ParameterNotFound, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { isStreamingMode, type StreamingMode } from '../shared/streamingMode.js';

const cloudwatch = new CloudWatchClient({ region: 'us-east-1' });
const ssm = new SSMClient({});
const sns = new SNSClient({});

const GB = 1e9;
const TIME_ZONE = 'America/New_York';

const dayIn = (at: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(at);
const hourIn = (at: Date) =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: '2-digit', hourCycle: 'h23' }).format(at));

/** The UTC instant of the most recent midnight in US Eastern (handles daylight saving: UTC-4 or UTC-5). */
export function easternMidnight(now = new Date()): Date {
  const day = dayIn(now);
  for (const offset of [4, 5]) {
    const candidate = new Date(`${day}T0${offset}:00:00Z`);
    if (dayIn(candidate) === day && hourIn(candidate) === 0) return candidate;
  }
  throw new Error(`could not find Eastern midnight for ${day}`);
}

async function bytesSince(start: Date, end: Date): Promise<number> {
  let total = 0;
  let nextToken: string | undefined;
  do {
    const res = await cloudwatch.send(new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      NextToken: nextToken,
      MetricDataQueries: [{
        Id: 'bytes',
        MetricStat: {
          Metric: {
            Namespace: 'AWS/CloudFront',
            MetricName: 'BytesDownloaded',
            Dimensions: [
              { Name: 'DistributionId', Value: process.env.DISTRIBUTION_ID! },
              { Name: 'Region', Value: 'Global' },
            ],
          },
          Period: 300,
          Stat: 'Sum',
        },
      }],
    }));
    for (const r of res.MetricDataResults ?? []) total += (r.Values ?? []).reduce((a, b) => a + b, 0);
    nextToken = res.NextToken;
  } while (nextToken);
  return total;
}

async function readParam(name: string): Promise<string | undefined> {
  try {
    return (await ssm.send(new GetParameterCommand({ Name: name }))).Parameter?.Value;
  } catch (err) {
    if (err instanceof ParameterNotFound) return undefined;
    throw err;
  }
}

const MEANING: Record<StreamingMode, string> = {
  normal: 'Free listeners are back to full quality.',
  degraded: 'Free listeners now get 64k audio only. Subscribers are not affected.',
  off: 'Free listening is paused until midnight Eastern. Subscribers are not affected.',
};

/** Email (SNS) about a mode change. A failed email is logged but never undoes or blocks the switch. */
async function sendAlert(from: string | undefined, to: StreamingMode, gbToday: number, override: string) {
  const reason = isStreamingMode(override)
    ? `It was set by hand (npm run streaming-mode -- ${override}). Run "npm run streaming-mode -- auto" to follow the traffic limits again.`
    : `Site traffic today (since midnight Eastern) is ${gbToday.toFixed(1)} GB. ` +
      `Limits: 64k only from ${process.env.DEGRADED_AT_GB_PER_DAY} GB, paused from ${process.env.OFF_AT_GB_PER_DAY} GB.`;
  try {
    await sns.send(new PublishCommand({
      TopicArn: process.env.SPEND_ALERT_TOPIC!,
      Subject: `Lullwater streaming: free listening is now ${to.toUpperCase()}`,
      Message: [
        `The spend switch changed from ${from ?? '(not set)'} to ${to}.`,
        '',
        MEANING[to],
        reason,
        '',
        `Time: ${new Date().toLocaleString('en-US', { timeZone: TIME_ZONE })} Eastern`,
      ].join('\n'),
    }));
  } catch (err) {
    console.error('spend alert email failed', err);
  }
}

export async function handler(): Promise<{ mode: StreamingMode; gbToday: number; override: string }> {
  const now = new Date();
  const gbToday = (await bytesSince(easternMidnight(now), now)) / GB;
  const degradedAt = Number(process.env.DEGRADED_AT_GB_PER_DAY);
  const offAt = Number(process.env.OFF_AT_GB_PER_DAY);
  const byTraffic: StreamingMode = gbToday >= offAt ? 'off' : gbToday >= degradedAt ? 'degraded' : 'normal';

  const override = (await readParam(process.env.STREAMING_MODE_OVERRIDE_PARAM!)) ?? 'auto';
  const mode = isStreamingMode(override) ? override : byTraffic;

  const current = await readParam(process.env.STREAMING_MODE_PARAM!);
  if (current !== mode) {
    await ssm.send(new PutParameterCommand({
      Name: process.env.STREAMING_MODE_PARAM!,
      Value: mode,
      Type: 'String',
      Overwrite: true,
    }));
    // Searchable in CloudWatch Logs: "SPEND SWITCH"
    console.log(`SPEND SWITCH ${current ?? '(unset)'} -> ${mode} (today ${gbToday.toFixed(2)} GB, override ${override})`);
    // The very first run after a deploy (nothing set -> normal) isn't news; every other change is.
    if (current !== undefined || mode !== 'normal') await sendAlert(current, mode, gbToday, override);
  }
  return { mode, gbToday: Number(gbToday.toFixed(3)), override };
}
