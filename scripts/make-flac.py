# /// script
# requires-python = ">=3.10"
# dependencies = ["mutagen>=1.47", "soundfile>=0.12", "numpy"]
# ///
"""
Turns a WAV + lyrics + cover art + song details into one tagged FLAC, ready to upload to raw/.

Each song lives in its own folder:

    My Song/
        anything.wav      the audio (exactly one .wav)
        info.txt          song details, one "Key: value" per line (make a blank one with --new)
        lyrics.txt        optional, copied in as-is (line breaks kept)
        cover.jpg         optional, any .jpg/.jpeg/.png; embedded as the front cover

Usage (from the project folder; uv downloads the Python libraries on first run):

    npm run make-flac -- --new "C:\\Music\\My Song"      write a blank info.txt to fill in
    npm run make-flac -- "C:\\Music\\My Song"            make the FLAC
    npm run make-flac -- "C:\\Music"                     every song folder inside C:\\Music
    npm run make-flac -- "C:\\Music" --out "%USERPROFILE%\\Downloads\\lullwater-flac"

The FLAC is lossless: the audio is bit-for-bit the WAV's (32-bit float WAVs become 24-bit, FLAC's maximum).
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from mutagen.flac import FLAC, Picture

# info.txt key -> FLAC (Vorbis comment) tag name. The site reads TITLE, ARTIST, ALBUM, TRACKNUMBER, DATE,
# GENRE and PRODUCER today; LYRICS, COPYRIGHT and AI_INFO are what the song's About popup shows.
# Any other key in info.txt is written as its own tag (upper-cased, spaces -> underscores).
KNOWN_KEYS = {
    "title": "TITLE",
    "artist": "ARTIST",
    "album": "ALBUM",
    "album artist": "ALBUMARTIST",
    "track": "TRACKNUMBER",
    "year": "DATE",
    "genre": "GENRE",
    "producer": "PRODUCER",
    "composer": "COMPOSER",
    "lyricist": "LYRICIST",
    "copyright": "COPYRIGHT",
    "ai info": "AI_INFO",
    "isrc": "ISRC",
    "comment": "COMMENT",
}
MULTI_VALUE = {"GENRE", "ARTIST", "COMPOSER", "LYRICIST", "PRODUCER"}  # split on ";" into separate tags
REQUIRED = ("TITLE", "ARTIST", "GENRE")  # the site needs these for the song list and genre buttons

TEMPLATE = """\
# Song details for make-flac. One "Key: value" per line; lines starting with # are ignored.
# Leave a value blank to skip it. Separate several genres/artists with ";".
# Lyrics go in lyrics.txt next to this file (not here).

Title:
Artist:
Album:
Album Artist:
Track:
Year:
Genre:
Producer:
Composer:
Lyricist:
Copyright:
AI Info:
ISRC:
Comment:
"""

IMAGE_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}


def parse_info(path: Path) -> dict[str, list[str]]:
    tags: dict[str, list[str]] = {}
    for n, raw in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            raise SystemExit(f"{path}, line {n}: expected 'Key: value', got {raw!r}")
        key, value = (s.strip() for s in line.split(":", 1))
        if not value:
            continue
        tag = KNOWN_KEYS.get(key.lower()) or re.sub(r"\W+", "_", key).strip("_").upper()
        values = [v.strip() for v in value.split(";")] if tag in MULTI_VALUE else [value]
        tags.setdefault(tag, []).extend(v for v in values if v)
    return tags


def one_file(folder: Path, patterns: tuple[str, ...], what: str, required: bool) -> Path | None:
    found = sorted({p for pat in patterns for p in folder.glob(pat)})
    if len(found) > 1:
        raise SystemExit(f"{folder}: more than one {what} ({', '.join(p.name for p in found)}); keep just one")
    if not found and required:
        raise SystemExit(f"{folder}: no {what} found")
    return found[0] if found else None


def safe_name(s: str) -> str:
    return re.sub(r'[<>:"/\\|?*]', "", s).strip() or "song"


def make_flac(folder: Path, out_dir: Path | None) -> Path:
    wav = one_file(folder, ("*.wav", "*.WAV"), ".wav file", required=True)
    info = folder / "info.txt"
    if not info.exists():
        raise SystemExit(f"{folder}: no info.txt (make one with: npm run make-flac -- --new \"{folder}\")")
    tags = parse_info(info)
    missing = [t for t in REQUIRED if t not in tags]
    if missing:
        raise SystemExit(f"{info}: please fill in {', '.join(missing)}")

    lyrics_file = folder / "lyrics.txt"
    if lyrics_file.exists():
        lyrics = lyrics_file.read_text(encoding="utf-8-sig").replace("\r\n", "\n").strip()
        if lyrics:
            tags["LYRICS"] = [lyrics]
    cover = one_file(folder, tuple(f"*{ext}" for ext in IMAGE_TYPES), "cover image", required=False)

    # Audio: keep the WAV's bit depth. FLAC can't hold floating point, so float WAVs go to 24-bit.
    wav_info = sf.info(str(wav))
    subtype = {"PCM_U8": "PCM_U8", "PCM_16": "PCM_16", "PCM_24": "PCM_24"}.get(wav_info.subtype, "PCM_24")
    if wav_info.samplerate > 655350:
        raise SystemExit(f"{wav}: sample rate {wav_info.samplerate} is too high for FLAC")
    if subtype == wav_info.subtype:
        data, rate = sf.read(str(wav), dtype="int32")  # exact copy of the samples
    else:  # float / 32-bit source -> 24-bit, clipped rather than wrapped
        data, rate = sf.read(str(wav), dtype="float64")
        data = np.clip(np.round(data * 8388608.0), -8388608, 8388607).astype(np.int32) << 8

    out_dir = out_dir or folder
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{safe_name(tags['ARTIST'][0])} - {safe_name(tags['TITLE'][0])}.flac"
    sf.write(str(out), data, rate, format="FLAC", subtype=subtype)

    flac = FLAC(str(out))
    flac.delete()  # start clean (libsndfile adds nothing useful)
    for tag, values in tags.items():
        flac[tag] = values
    if cover:
        pic = Picture()
        pic.type = 3  # front cover
        pic.mime = IMAGE_TYPES[cover.suffix.lower()]
        pic.desc = "Cover"
        pic.data = cover.read_bytes()
        if len(pic.data) > 16 * 1024 * 1024 - 1024:
            raise SystemExit(f"{cover}: image is over 16 MB, too big to embed in a FLAC; shrink it first")
        flac.add_picture(pic)
    flac.save()

    # Read it back so what we report is what's actually in the file.
    check = FLAC(str(out))
    secs = check.info.length
    print(f"\n[OK] {out}")
    print(f"   audio  {check.info.bits_per_sample}-bit / {check.info.sample_rate} Hz / "
          f"{check.info.channels} ch / {int(secs // 60)}:{int(secs % 60):02d}  (from {wav.name}, {wav_info.subtype})")
    for tag in sorted(check.keys()):
        value = " ; ".join(check[tag])
        if tag.upper() == "LYRICS":
            value = f"{len(value.splitlines())} lines"
        print(f"   {tag.upper():<12} {value[:70]}")
    print(f"   {'COVER':<12} {cover.name + f' ({len(check.pictures[0].data) // 1024} KB)' if cover else '(none)'}")
    return out


def is_song_folder(p: Path) -> bool:
    return p.is_dir() and (p / "info.txt").exists()


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")  # so ©, accents etc. print right in the Windows console
    ap =argparse.ArgumentParser(description="WAV + lyrics + cover + info.txt -> tagged FLAC")
    ap.add_argument("folder", type=Path, help="a song folder, or a folder of song folders")
    ap.add_argument("--out", type=Path, help="where to write the FLAC(s) (default: next to each WAV)")
    ap.add_argument("--new", action="store_true", help="write a blank info.txt into the folder and stop")
    args = ap.parse_args()
    folder: Path = args.folder.expanduser().resolve()
    if not folder.is_dir():
        raise SystemExit(f"Not a folder: {folder}")

    if args.new:
        info = folder / "info.txt"
        if info.exists():
            raise SystemExit(f"{info} already exists; not overwriting it")
        info.write_text(TEMPLATE, encoding="utf-8")
        print(f"Wrote {info}; fill it in, add lyrics.txt and a cover image, then run without --new.")
        return

    songs = [folder] if is_song_folder(folder) else sorted(p for p in folder.iterdir() if is_song_folder(p))
    if not songs:
        raise SystemExit(f"No info.txt in {folder} or in any folder inside it")
    failed = []
    for song in songs:
        try:
            make_flac(song, args.out.expanduser().resolve() if args.out else None)
        except SystemExit as e:  # keep going through a batch; report at the end
            if len(songs) == 1:
                raise
            print(f"\n[FAILED] {e}")
            failed.append(song.name)
    if failed:
        sys.exit(f"\n{len(failed)} of {len(songs)} failed: {', '.join(failed)}")


if __name__ == "__main__":
    main()
