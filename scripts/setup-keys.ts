/**
 * Creates the RSA key pair CloudFront uses to verify streaming cookies.
 *   keys/public_key.pem  -> read by CDK and registered with CloudFront
 *   keys/private_key.pem -> uploaded to SSM Parameter Store (SecureString) for the API Lambda to sign with
 *
 * Run once before the first deploy:  npm run setup-keys
 * Pass --local-only to generate the files without uploading (e.g. for `cdk synth` without AWS credentials).
 * Delete the keys/ folder and re-run to rotate.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { SIGNING_KEY_PARAM } from '../infra/constants.js';

const dir = new URL('../keys/', import.meta.url);
const privPath = new URL('private_key.pem', dir);
const pubPath = new URL('public_key.pem', dir);

if (!existsSync(privPath)) {
  mkdirSync(dir, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(privPath, privateKey);
  writeFileSync(pubPath, publicKey);
  console.log('Generated new key pair in keys/');
} else {
  console.log('Using existing key pair in keys/');
}

if (process.argv.includes('--local-only')) process.exit(0);

await new SSMClient({}).send(new PutParameterCommand({
  Name: SIGNING_KEY_PARAM,
  Type: 'SecureString',
  Value: readFileSync(privPath, 'utf8'),
  Overwrite: true,
  Description: 'StreamingWebsite: private key for CloudFront signed stream cookies',
}));
console.log(`Uploaded private key to SSM parameter ${SIGNING_KEY_PARAM}`);
