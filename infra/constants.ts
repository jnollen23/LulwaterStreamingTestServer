/** SSM SecureString holding the CloudFront signing private key (written by scripts/setup-keys.ts). */
export const SIGNING_KEY_PARAM = '/streaming-website/cloudfront-private-key';

/**
 * How the browser is allowed to fetch /stream/* audio:
 *   'url'    — every audio-piece link in the playlist carries its own expiring signature. Nothing is stored
 *              in the browser (current policy: no cookies, no local storage).
 *   'cookie' — the play request sets short-lived CloudFront signed cookies for that one song.
 * Switch here and redeploy; the website doesn't need to change.
 */
export const STREAM_SIGNING_MODE: 'url' | 'cookie' = 'url';

/**
 * Spend switch for FREE listeners (subscribers are never throttled):
 *   'normal'   — full quality (64/128/256k)
 *   'degraded' — 64k only
 *   'off'      — free streaming paused until midnight US Eastern
 * The spend-guard Lambda checks the site's CloudFront traffic for today (US Eastern) every 5 minutes and writes
 * the result to STREAMING_MODE_PARAM; the API reads that. To force a mode by hand, set the override with
 *   npm run streaming-mode -- normal|degraded|off|auto      (auto = follow the traffic thresholds again)
 */
export const STREAMING_MODE_PARAM = '/streaming-website/streaming-mode';
export const STREAMING_MODE_OVERRIDE_PARAM = '/streaming-website/streaming-mode-override';

// TODO(client): placeholder thresholds — confirm with the client. Counted on ALL site traffic today (US Eastern),
// subscribers included. CloudFront is roughly $0.085/GB after the free 1 TB a month; 256k audio is ~115 MB per hour.
/** Today's traffic at which free listeners drop to 64k (~$2/day, ~220 listener-hours at 256k). */
export const DEGRADED_AT_GB_PER_DAY = 25;
/** Today's traffic at which free streaming pauses until midnight Eastern (~$6/day). */
export const OFF_AT_GB_PER_DAY = 75;

/** Where EVERY email the system sends goes: spend-switch mode changes, spend-guard failure alarms, and any alert
 *  added later (e.g. the AWS bill alert, issue #20). Use this list rather than adding new addresses elsewhere.
 *  AWS sends each address a one-time "Confirm subscription" email after the deploy that adds it; nothing arrives
 *  until that link is clicked.
 *  TODO(client): test address for now (2026-11-06) — switch to the real address(es) before going live. */
export const ALERT_EMAILS = ['jacob.nollen@hotmail.com'];
