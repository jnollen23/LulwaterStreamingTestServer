import type { Track } from '../api';
import { MusicIcon } from './Icons';

/** Small square album art at the start of a song row; a music note when the song has no art. */
export function SongArt({ track }: { track: Track }) {
  const src = track.thumbPath ?? track.artPath;
  return (
    <span className="song-art" aria-hidden="true">
      {src
        ? <img src={src} alt="" loading="lazy" decoding="async" />
        : <MusicIcon size={20} />}
    </span>
  );
}
