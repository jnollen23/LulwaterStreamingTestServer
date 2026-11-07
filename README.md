# StreamingWebsite

Audio streaming site for a self-hosted FLAC library, running entirely on AWS (serverless).

## How it works

```
ADDING MUSIC (manual, S3 console)
FLAC -> S3 raw/ -> Ingest Lambda ──> ffmpeg (in the same Lambda) -> S3 stream/<id>/ (HLS, AAC 64/128/256k)
                     |  reads tags + cover art
                     v
               DynamoDB catalog: PROCESSING -> READY (or ERROR)
                     cover art -> S3 art/<id>.jpg

LISTENING (no login)
Browser -> CloudFront ─┬─ /          website (React, S3)
                       ├─ /api/*     API Gateway -> API Lambda -> DynamoDB
                       ├─ /stream/*  HLS audio (signed links from /api/tracks/<id>/hls/*.m3u8; no cookies)
                       └─ /art/*     cover art
```

| Folder | What's in it |
|---|---|
| `infra/` | CDK: the blueprint for every AWS resource (`streaming-stack.ts`) |
| `backend/api/` | API Lambda: track list, track detail, play (issues stream cookies) |
| `backend/ingest/` | Runs when a FLAC lands in `raw/`: tags, cover art, ffmpeg HLS transcode, marks READY/ERROR |
| `backend/shared/` | Catalog (DynamoDB), stream cookie signing, **auth hook** |
| `frontend/` | React + hls.js website and player |
| `scripts/setup-keys.ts` | Creates the key pair CloudFront uses to verify stream cookies |
| `scripts/fetch-ffmpeg.ts` | Downloads the static ffmpeg build the ingest Lambda runs (`layers/ffmpeg/`) |

## One-time setup

1. **AWS CLI**: install it from https://aws.amazon.com/cli/, then run `aws configure` with an IAM user's access key and your region (e.g. `us-east-1`).
2. **Install dependencies**:
   ```bash
   npm install
   npm --prefix frontend install
   ```
3. **Create the signing keys** (also uploads the private key to SSM Parameter Store):
   ```bash
   npm run setup-keys
   ```
4. **Download ffmpeg** (static Linux ARM64 build, MD5-checked; saved to `layers/ffmpeg/bin/ffmpeg`):
   ```bash
   npm run fetch-ffmpeg
   ```
5. **Bootstrap CDK** (once per AWS account + region):
   ```bash
   npx cdk bootstrap
   ```

## Deploy

```bash
npm run deploy
```

At the end, CDK prints:
- `SiteUrl`: the website
- `MediaBucketName`: where the music goes

The first deploy takes about 5–10 minutes (CloudFront is slow to create). Later deploys are faster.

## Adding music

1. In the AWS console, open **S3**, then the `MediaBucketName` bucket.
2. Create a folder named `raw`, open it, and **Upload** your `.flac` files.
3. Each file takes roughly 10–30 seconds to transcode, then appears on the site. Lambda stops at 15 minutes, which is far beyond any normal album track (multi-hour recordings would need splitting).

Title, artist, album, track number, year and cover art come from the FLAC tags. If a file has no title tag, the filename is used.

**If a track never shows up:** open DynamoDB, then the `TracksTableName` table, and find the item. `status` will be `ERROR` with an `error` message. The Lambda logs are in CloudWatch (`/aws/lambda/StreamingWebsite-IngestFn…`); ffmpeg's last lines of output are included in the `error` message.

## Login hooks (not active)

Everything is open to the public. These are the places to change once login is added:

| File | What to change |
|---|---|
| `backend/shared/auth.ts` | `getUser()`: verify the bearer token and return the user |
| `backend/api/routes.ts` | Set `requireAuth: true` on routes that should need login |
| `frontend/src/auth/AuthContext.tsx` | Swap the anonymous provider for the real one (e.g. Cognito) |
| `frontend/src/config.ts` | `AUTH_ENABLED = true` shows Log in / Log out |
| `infra/streaming-stack.ts` | Add a Cognito user pool |

The frontend already sends `Authorization: Bearer <token>` once `getToken()` returns one.

## Website layout

One phone-shaped layout everywhere; on desktop it's a centered 480px column.

- **Home:** search, now-playing bar, 5 most common genres + "Show all" stay on screen; only the song list scrolls.
- **Now playing:** opened by tapping a song or the now-playing bar. Never scrolls. Left/right half of the cover = -10/+10 s. Loop cycles off -> loop -> repeat one; shuffle toggle.
- **Bottom bar:** Home, About, Donate (PayPal link), Shop (coming soon).
- **Genres** come from the FLAC `GENRE` tag (several values can be separated with `;`, `,` or `/`). Tracks added before genres were stored have none; re-upload them to pick up their genres.

### Updating a song

To change a song's tags, art or audio, upload the new FLAC to `raw/` with **exactly the same filename**. Once the new copy has finished transcoding it replaces the old one: likes carry over, and the old catalog entry, stream files and art are deleted. If the new upload fails, the old song stays up. A different filename counts as a new song, so the old one stays too.

Open reminders in the code are marked `TODO(<topic>)` (find them with `git grep -n TODO`). Each one has a GitHub issue: https://github.com/jnollen23/LulwaterStreamingTestServer/issues

To check the layout without the deployed backend (sample songs, playback won't work):

```bash
npm --prefix frontend run dev:mock
```

## Local frontend development

```powershell
$env:SITE_URL = "https://xxxx.cloudfront.net"; npm --prefix frontend run dev
```

This proxies `/api`, `/stream` and `/art` to the deployed site.

## Not done yet

- Upload page on the website (planned behind login)
- Deleting tracks: currently a manual job (delete the DynamoDB item, plus `stream/<id>/`, `art/<id>.*` and `art/thumb/<id>.jpg` in S3). Replacing one is automatic — see "Updating a song"
- Custom domain name (currently uses the `*.cloudfront.net` address)

## Costs (rough)

- Idle: about $0–1/month. Lambda, API Gateway and DynamoDB are pay-per-use, and SSM standard parameters are free.
- Per upload: Lambda time while ffmpeg runs, typically 10–30 seconds per song at 3 GB memory, roughly $0.001 per track.
- Per listener: CloudFront transfer, about $0.085/GB. One hour at the 256k rendition is about 115 MB.
- Storage: S3, about $0.023/GB-month. FLAC originals are kept in `raw/`.

`npm run destroy` removes everything **except** the media bucket and the catalog table. Those are kept on purpose so the library is never lost by accident.

## Spend switch (free listeners)

Every 5 minutes the spend-guard Lambda adds up today's CloudFront traffic (since midnight US Eastern) and sets
the mode for **free** listeners — subscribers are never throttled:

| Today's traffic | Mode | Free listeners get |
|---|---|---|
| under `DEGRADED_AT_GB_PER_DAY` | normal | 64/128/256k as usual |
| from `DEGRADED_AT_GB_PER_DAY` | degraded | 64k only |
| from `OFF_AT_GB_PER_DAY` | off | "Free listening is paused for today" |

It goes back to normal by itself after midnight Eastern. Thresholds live in `infra/constants.ts` (placeholders until
the client confirms). Mode changes are logged as `SPEND SWITCH` in the SpendGuardFn CloudWatch logs and emailed to `ALERT_EMAILS`
(`infra/constants.ts`). After the first deploy, click the "Confirm subscription" link AWS emails to each address.

The same addresses are emailed if the spend guard itself breaks: errors in 3 of its last 4 runs, or no run for
15 minutes. Either way the switch is stuck in its current mode until it's fixed; `npm run streaming-mode -- degraded`
is a safe stopgap. A second "OK" email arrives once it recovers. Expect one or two of these right after a deploy
while the alarms get their first data.

Force a mode by hand (stays until you set `auto` again; takes effect within about 6 minutes):

```
npm run streaming-mode -- off
npm run streaming-mode -- auto
npm run streaming-mode            # show current mode
```
