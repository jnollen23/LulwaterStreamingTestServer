import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';

/** Spend switch for free listeners — see STREAMING_MODE_PARAM in infra/constants.ts. */
export type StreamingMode = 'normal' | 'degraded' | 'off';
export const STREAMING_MODES: readonly StreamingMode[] = ['normal', 'degraded', 'off'];

export const isStreamingMode = (v: unknown): v is StreamingMode => STREAMING_MODES.includes(v as StreamingMode);

const ssm = new SSMClient({});
/** Re-read at most once a minute per Lambda instance, so a switch takes effect within about a minute. */
const CACHE_MS = 60_000;
let cached: { mode: StreamingMode; at: number } | undefined;

export async function getStreamingMode(): Promise<StreamingMode> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.mode;
  let mode: StreamingMode = 'normal'; // nothing written yet (fresh deploy) = full quality
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: process.env.STREAMING_MODE_PARAM! }));
    if (isStreamingMode(res.Parameter?.Value)) mode = res.Parameter.Value;
  } catch (err) {
    if (!(err instanceof ParameterNotFound)) {
      console.error('streaming mode read failed; keeping last known mode', err);
      if (cached) return cached.mode; // don't flip back to 'normal' because of a hiccup
    }
  }
  cached = { mode, at: Date.now() };
  return mode;
}
