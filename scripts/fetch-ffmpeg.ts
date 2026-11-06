/**
 * Downloads a static Linux ARM64 ffmpeg build into layers/ffmpeg/bin/ffmpeg.
 * CDK packages that folder as a Lambda layer, so the ingest Lambda sees it at /opt/bin/ffmpeg.
 *
 * Run once before the first deploy:  npm run fetch-ffmpeg
 * Delete layers/ffmpeg/ and re-run to update ffmpeg.
 *
 * Source: John Van Sickle's static builds (https://johnvansickle.com/ffmpeg/), checked against the published MD5.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_BASE = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binDir = path.join(root, 'layers', 'ffmpeg', 'bin');
const target = path.join(binDir, 'ffmpeg');

if (existsSync(target)) {
  console.log(`ffmpeg already present at ${path.relative(root, target)} (delete layers/ffmpeg/ to re-download)`);
  process.exit(0);
}

console.log(`Downloading ${URL_BASE} ...`);
const [archive, md5File] = await Promise.all([
  fetch(URL_BASE).then(expectOk).then((r) => r.arrayBuffer()),
  fetch(`${URL_BASE}.md5`).then(expectOk).then((r) => r.text()),
]);

const expected = md5File.trim().split(/\s+/)[0].toLowerCase();
const actual = createHash('md5').update(Buffer.from(archive)).digest('hex');
if (actual !== expected) throw new Error(`MD5 mismatch: expected ${expected}, got ${actual}`);

const work = mkdtempSync(path.join(tmpdir(), 'ffmpeg-'));
try {
  const tarball = path.join(work, 'ffmpeg.tar.xz');
  writeFileSync(tarball, Buffer.from(archive));
  // tar ships with Windows 10+ (bsdtar) and Git Bash; both handle .xz
  execFileSync('tar', ['-xJf', 'ffmpeg.tar.xz'], { cwd: work, stdio: 'inherit' });

  const extracted = readdirSync(work, { withFileTypes: true }).find((d) => d.isDirectory());
  if (!extracted) throw new Error('Archive did not contain a folder');
  mkdirSync(binDir, { recursive: true });
  copyFileSync(path.join(work, extracted.name, 'ffmpeg'), target);
  console.log(`Saved ${extracted.name}/ffmpeg to ${path.relative(root, target)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

function expectOk(res: Response): Response {
  if (!res.ok) throw new Error(`${res.url}: HTTP ${res.status}`);
  return res;
}
