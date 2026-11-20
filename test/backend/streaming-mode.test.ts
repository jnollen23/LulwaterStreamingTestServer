import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ssm = mockClient(SSMClient);

/** A fresh copy of the module each test, so its one-minute cache starts empty. */
async function load() {
  vi.resetModules();
  return import('../../backend/shared/streamingMode.js');
}

beforeEach(() => {
  ssm.reset();
  vi.stubEnv('STREAMING_MODE_PARAM', '/test/mode');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-19T15:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe('isStreamingMode', () => {
  it('accepts only the three modes', async () => {
    const { isStreamingMode } = await load();
    expect(['normal', 'degraded', 'off'].every(isStreamingMode)).toBe(true);
    expect(isStreamingMode('auto')).toBe(false);
    expect(isStreamingMode(undefined)).toBe(false);
  });
});

describe('getStreamingMode', () => {
  it('reads the mode from SSM', async () => {
    const { getStreamingMode } = await load();
    ssm.on(GetParameterCommand, { Name: '/test/mode' }).resolves({ Parameter: { Value: 'degraded' } });
    expect(await getStreamingMode()).toBe('degraded');
  });

  it('is normal when nothing has been written yet', async () => {
    const { getStreamingMode } = await load();
    ssm.on(GetParameterCommand).rejects(new ParameterNotFound({ message: 'nf', $metadata: {} }));
    expect(await getStreamingMode()).toBe('normal');
  });

  it('is normal when the stored value is not a mode', async () => {
    const { getStreamingMode } = await load();
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: 'banana' } });
    expect(await getStreamingMode()).toBe('normal');
  });

  it('re-reads at most once a minute', async () => {
    const { getStreamingMode } = await load();
    ssm.on(GetParameterCommand).resolvesOnce({ Parameter: { Value: 'off' } }).resolves({ Parameter: { Value: 'normal' } });
    expect(await getStreamingMode()).toBe('off');
    vi.advanceTimersByTime(59_000);
    expect(await getStreamingMode()).toBe('off');
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    expect(await getStreamingMode()).toBe('normal');
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(2);
  });

  it('keeps the last known mode through an SSM hiccup instead of flipping to normal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getStreamingMode } = await load();
    ssm.on(GetParameterCommand).resolvesOnce({ Parameter: { Value: 'off' } }).rejects(new Error('throttled'));
    expect(await getStreamingMode()).toBe('off');
    vi.advanceTimersByTime(61_000);
    expect(await getStreamingMode()).toBe('off');
  });

  it('falls back to normal on an SSM error when nothing is cached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getStreamingMode } = await load();
    ssm.on(GetParameterCommand).rejects(new Error('throttled'));
    expect(await getStreamingMode()).toBe('normal');
  });
});
