import { createSign } from 'node:crypto';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});
let privateKey: string | undefined;

async function getPrivateKey(): Promise<string> {
  if (!privateKey) {
    const res = await ssm.send(new GetParameterCommand({
      Name: process.env.SIGNING_KEY_PARAM!,
      WithDecryption: true,
    }));
    privateKey = res.Parameter!.Value!;
  }
  return privateKey;
}

// CloudFront's URL-safe base64 variant
const cfBase64 = (data: string | Buffer) =>
  Buffer.from(data).toString('base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');

const SIGNATURE_STEP_SECONDS = 60 * 60;

/** One signature that unlocks every file under /stream/{trackId}/ until it expires. */
async function streamPolicy(trackId: string, ttlSeconds: number) {
  const path = `/stream/${trackId}/`;
  // Round the expiry up to the next whole hour so every request in that hour gets the *same* signature.
  // Same signature -> same segment URLs -> the browser can reuse segments it already downloaded
  // (replays, Previous, going back to a song). A fresh signature each time looks like a brand-new file.
  const expires = Math.ceil((Date.now() / 1000 + ttlSeconds) / SIGNATURE_STEP_SECONDS) * SIGNATURE_STEP_SECONDS;
  // Host is wildcarded so the Lambda doesn't need to know the CloudFront domain (avoids a circular dependency).
  const policy = JSON.stringify({
    Statement: [{
      Resource: `https://*${path}*`,
      Condition: { DateLessThan: { 'AWS:EpochTime': expires } },
    }],
  });
  const signature = createSign('RSA-SHA1').update(policy).sign(await getPrivateKey());
  return { path, policy: cfBase64(policy), signature: cfBase64(signature), keyPairId: process.env.SIGNING_KEY_PAIR_ID! };
}

/**
 * Query string ("Policy=...&Signature=...&Key-Pair-Id=...") to append to /stream/{trackId}/* URLs.
 * Used by the default 'url' signing mode — nothing is stored in the browser.
 */
export async function signedStreamQuery(trackId: string, ttlSeconds: number): Promise<string> {
  const p = await streamPolicy(trackId, ttlSeconds);
  return `Policy=${p.policy}&Signature=${p.signature}&Key-Pair-Id=${p.keyPairId}`;
}

/**
 * Set-Cookie values that let the browser fetch /stream/{trackId}/* from CloudFront until they expire.
 * Each track gets its own cookie path, so a cookie only unlocks one track. Used by the 'cookie' signing mode.
 */
export async function signedStreamCookies(trackId: string, ttlSeconds: number): Promise<string[]> {
  const p = await streamPolicy(trackId, ttlSeconds);
  const attrs = `Path=${p.path}; Max-Age=${ttlSeconds}; Secure; HttpOnly; SameSite=Strict`;
  return [
    `CloudFront-Policy=${p.policy}; ${attrs}`,
    `CloudFront-Signature=${p.signature}; ${attrs}`,
    `CloudFront-Key-Pair-Id=${p.keyPairId}; ${attrs}`,
  ];
}
