import { createVerify, generateKeyPairSync } from 'node:crypto';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ssm = mockClient(SSMClient);
// A throwaway key made for the test run; the real one lives only in SSM.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const FOUR_HOURS = 4 * 60 * 60;

/** Undoes CloudFront's URL-safe base64. */
const unCf = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64');
const queryParts = (q: string) => Object.fromEntries(q.split('&').map((p) => p.split('=', 2) as [string, string]));

async function load() {
  vi.resetModules(); // the module keeps the key after the first SSM read
  return import('../../backend/shared/signing.js');
}

beforeEach(() => {
  ssm.reset();
  ssm.on(GetParameterCommand).resolves({ Parameter: { Value: privateKey } });
  vi.stubEnv('SIGNING_KEY_PARAM', '/test/key');
  vi.stubEnv('SIGNING_KEY_PAIR_ID', 'KTEST');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-19T10:15:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe('signedStreamQuery', () => {
  it('signs a policy for every file of one track, valid CloudFront-style', async () => {
    const { signedStreamQuery } = await load();
    const { Policy, Signature, 'Key-Pair-Id': keyPairId } = queryParts(await signedStreamQuery('t1', FOUR_HOURS));
    expect(Policy).not.toMatch(/[+/=]/); // URL-safe alphabet only
    expect(Signature).not.toMatch(/[+/=]/);
    expect(keyPairId).toBe('KTEST');

    const policy = JSON.parse(unCf(Policy).toString('utf8'));
    expect(policy.Statement[0].Resource).toBe('https://*/stream/t1/*');
    expect(createVerify('RSA-SHA1').update(unCf(Policy)).verify(publicKey, unCf(Signature))).toBe(true);
  });

  it('rounds the expiry up to the next whole hour', async () => {
    const { signedStreamQuery } = await load();
    const { Policy } = queryParts(await signedStreamQuery('t1', FOUR_HOURS));
    const expires = JSON.parse(unCf(Policy).toString('utf8')).Statement[0].Condition.DateLessThan['AWS:EpochTime'];
    expect(new Date(expires * 1000).toISOString()).toBe('2026-11-19T15:00:00.000Z'); // 10:15 + 4 h -> 15:00
  });

  it('gives the same signature for every request in the same hour (so the browser can reuse segments)', async () => {
    const { signedStreamQuery } = await load();
    const first = await signedStreamQuery('t1', FOUR_HOURS);
    vi.setSystemTime(new Date('2026-11-19T10:59:00Z'));
    expect(await signedStreamQuery('t1', FOUR_HOURS)).toBe(first);
    vi.setSystemTime(new Date('2026-11-19T11:01:00Z'));
    expect(await signedStreamQuery('t1', FOUR_HOURS)).not.toBe(first);
  });

  it('reads the key from SSM only once per Lambda instance', async () => {
    const { signedStreamQuery } = await load();
    await signedStreamQuery('t1', FOUR_HOURS);
    await signedStreamQuery('t2', FOUR_HOURS);
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(1);
    expect(ssm.commandCalls(GetParameterCommand)[0].args[0].input).toEqual({ Name: '/test/key', WithDecryption: true });
  });
});

describe('signedStreamCookies', () => {
  it('sets the three CloudFront cookies, locked to one track', async () => {
    const { signedStreamCookies } = await load();
    const cookies = await signedStreamCookies('t1', FOUR_HOURS);
    expect(cookies.map((c) => c.split('=')[0])).toEqual(['CloudFront-Policy', 'CloudFront-Signature', 'CloudFront-Key-Pair-Id']);
    for (const c of cookies) {
      expect(c).toContain('Path=/stream/t1/;');
      expect(c).toContain(`Max-Age=${FOUR_HOURS};`);
      expect(c).toContain('Secure; HttpOnly; SameSite=Strict');
    }
  });
});
