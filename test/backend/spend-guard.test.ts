import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { GetParameterCommand, ParameterNotFound, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { easternMidnight, handler } from '../../backend/spend-guard/handler.js';

const cloudwatch = mockClient(CloudWatchClient);
const ssm = mockClient(SSMClient);
const sns = mockClient(SNSClient);

const MODE = '/test/streaming-mode';
const OVERRIDE = '/test/streaming-mode-override';
const notFound = () => new ParameterNotFound({ message: 'not found', $metadata: {} });

/** Sets up one run: today's traffic in GB, the current mode and the manual override (undefined = never set). */
function run({ gb, current, override }: { gb: number | number[]; current?: string; override?: string }) {
  const pages = Array.isArray(gb) ? gb : [gb];
  const chain = cloudwatch.on(GetMetricDataCommand);
  pages.forEach((g, i) => chain.resolvesOnce({
    // Split each page across two 5-minute points to check they're summed.
    MetricDataResults: [{ Id: 'bytes', Values: [g * 1e9 / 2, g * 1e9 / 2] }],
    NextToken: i < pages.length - 1 ? `page${i + 1}` : undefined,
  }));
  for (const [name, value] of [[MODE, current], [OVERRIDE, override]] as const) {
    if (value === undefined) ssm.on(GetParameterCommand, { Name: name }).rejects(notFound());
    else ssm.on(GetParameterCommand, { Name: name }).resolves({ Parameter: { Value: value } });
  }
}

const written = () => ssm.commandCalls(PutParameterCommand).map((c) => c.args[0].input.Value);
const emails = () => sns.commandCalls(PublishCommand).map((c) => c.args[0].input);

beforeEach(() => {
  cloudwatch.reset();
  ssm.reset();
  sns.reset();
  vi.stubEnv('STREAMING_MODE_PARAM', MODE);
  vi.stubEnv('STREAMING_MODE_OVERRIDE_PARAM', OVERRIDE);
  vi.stubEnv('DEGRADED_AT_GB_PER_DAY', '25');
  vi.stubEnv('OFF_AT_GB_PER_DAY', '75');
  vi.stubEnv('SPEND_ALERT_TOPIC', 'arn:aws:sns:us-east-2:000000000000:SpendAlerts');
  vi.stubEnv('DISTRIBUTION_ID', 'E123');
});

describe('easternMidnight', () => {
  it.each([
    ['standard time', '2026-11-19T15:00:00Z', '2026-11-19T05:00:00.000Z'],
    ['daylight time', '2026-07-04T12:00:00Z', '2026-07-04T04:00:00.000Z'],
    ['just after midnight', '2026-11-19T05:30:00Z', '2026-11-19T05:00:00.000Z'],
    ['just before midnight (previous Eastern day)', '2026-11-19T04:59:00Z', '2026-11-18T05:00:00.000Z'],
    ['the day clocks spring forward', '2026-03-08T20:00:00Z', '2026-03-08T05:00:00.000Z'],
    ['the day clocks fall back', '2026-11-01T20:00:00Z', '2026-11-01T04:00:00.000Z'],
  ])('%s', (_label, now, midnight) => {
    expect(easternMidnight(new Date(now)).toISOString()).toBe(midnight);
  });
});

describe('spend guard', () => {
  it('stays normal under the degraded limit and sends nothing', async () => {
    run({ gb: 10, current: 'normal' });
    expect(await handler()).toMatchObject({ mode: 'normal', gbToday: 10, override: 'auto' });
    expect(written()).toEqual([]);
    expect(emails()).toEqual([]);
  });

  it('asks CloudWatch for today since Eastern midnight', async () => {
    run({ gb: 1, current: 'normal' });
    await handler();
    const input = cloudwatch.commandCalls(GetMetricDataCommand)[0].args[0].input;
    expect(input.StartTime).toEqual(easternMidnight(input.EndTime as Date));
    expect(input.MetricDataQueries![0].MetricStat!.Metric!.Dimensions).toContainEqual({ Name: 'DistributionId', Value: 'E123' });
  });

  it('switches to degraded at the limit (inclusive) and emails', async () => {
    run({ gb: 25, current: 'normal' });
    expect((await handler()).mode).toBe('degraded');
    expect(written()).toEqual(['degraded']);
    expect(emails()).toHaveLength(1);
    expect(emails()[0].Subject).toContain('DEGRADED');
    expect(emails()[0].Message).toContain('25.0 GB');
  });

  it('switches off at the off limit', async () => {
    run({ gb: 80, current: 'degraded' });
    expect((await handler()).mode).toBe('off');
    expect(written()).toEqual(['off']);
    expect(emails()[0].Subject).toContain('OFF');
  });

  it('adds up every page of metrics', async () => {
    run({ gb: [20, 10], current: 'normal' });
    expect(await handler()).toMatchObject({ mode: 'degraded', gbToday: 30 });
    expect(cloudwatch.commandCalls(GetMetricDataCommand)[1].args[0].input.NextToken).toBe('page1');
  });

  it('goes back to normal by itself when the day total resets', async () => {
    run({ gb: 0, current: 'off' });
    expect((await handler()).mode).toBe('normal');
    expect(written()).toEqual(['normal']);
    expect(emails()[0].Message).toContain('back to full quality');
  });

  it('does not email on the very first run after a deploy', async () => {
    run({ gb: 0 });
    expect((await handler()).mode).toBe('normal');
    expect(written()).toEqual(['normal']);
    expect(emails()).toEqual([]);
  });

  it('does email if the very first run is already over a limit', async () => {
    run({ gb: 30 });
    await handler();
    expect(emails()).toHaveLength(1);
  });

  it('lets a manual override win over the traffic', async () => {
    run({ gb: 0, current: 'normal', override: 'off' });
    expect(await handler()).toMatchObject({ mode: 'off', override: 'off' });
    expect(emails()[0].Message).toContain('set by hand');
  });

  it('follows the traffic again when the override is "auto"', async () => {
    run({ gb: 80, current: 'normal', override: 'auto' });
    expect((await handler()).mode).toBe('off');
  });

  it('still switches if the alert email fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    run({ gb: 30, current: 'normal' });
    sns.on(PublishCommand).rejects(new Error('SNS down'));
    expect((await handler()).mode).toBe('degraded');
    expect(written()).toEqual(['degraded']);
  });

  it('fails the run (so the error alarm sees it) when SSM fails', async () => {
    run({ gb: 30, current: 'normal' });
    ssm.on(GetParameterCommand, { Name: MODE }).rejects(new Error('throttled'));
    await expect(handler()).rejects.toThrow('throttled');
  });
});
