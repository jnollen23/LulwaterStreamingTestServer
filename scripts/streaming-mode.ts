/**
 * Show or force the spend switch for free listeners (see STREAMING_MODE_PARAM in infra/constants.ts).
 *
 *   npm run streaming-mode                 shows the current mode and override
 *   npm run streaming-mode -- off          pause free streaming now (also: normal, degraded)
 *   npm run streaming-mode -- auto         go back to following today's traffic thresholds
 *
 * A forced mode stays until you set 'auto' again — it does NOT reset at midnight.
 * The spend guard applies it within 5 minutes, and the API notices within another minute.
 */
import { GetParameterCommand, ParameterNotFound, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { STREAMING_MODE_OVERRIDE_PARAM, STREAMING_MODE_PARAM } from '../infra/constants.js';

const ssm = new SSMClient({ region: 'us-east-2' });
const CHOICES = ['normal', 'degraded', 'off', 'auto'];

async function read(name: string): Promise<string> {
  try {
    return (await ssm.send(new GetParameterCommand({ Name: name }))).Parameter?.Value ?? '(unset)';
  } catch (err) {
    if (err instanceof ParameterNotFound) return '(unset)';
    throw err;
  }
}

const wanted = process.argv[2];
if (wanted !== undefined) {
  if (!CHOICES.includes(wanted)) {
    console.error(`Usage: npm run streaming-mode -- ${CHOICES.join('|')}`);
    process.exit(1);
  }
  await ssm.send(new PutParameterCommand({
    Name: STREAMING_MODE_OVERRIDE_PARAM,
    Value: wanted,
    Type: 'String',
    Overwrite: true,
  }));
  console.log(`Override set to '${wanted}'. Takes effect within about 6 minutes.`);
}
console.log(`Current mode: ${await read(STREAMING_MODE_PARAM)}   override: ${await read(STREAMING_MODE_OVERRIDE_PARAM)}`);
