import { useState } from 'react';
import { formatDuration, type Track } from '../api';
import type { GenreFilter } from '../genres';
import { BagIcon, CloseIcon, DotsIcon, FilterIcon, HeartIcon, ListPlusIcon, MusicIcon, PauseIcon, PlayIcon } from './Icons';
import { SongArt } from './SongArt';

interface Props {
  current: Track | null;
  playing: boolean;
  onToggle: () => void;
  onOpenNowPlaying: () => void;
  quickGenres: string[];
  filter: GenreFilter | null;
  onQuickGenre: (genre: string) => void;
  onShowAllGenres: () => void;
  onClearFilter: () => void;
  songs: Track[];
  onPick: (track: Track) => void;
  onAddToPlaylist: (track: Track) => void;
  onBuy: (track: Track) => void;
  loading: boolean;
  loadError: string | null;
  libraryEmpty: boolean;
}

/**
 * Home: the now-playing bar, genre buttons and list header stay put; only the song list scrolls.
 * Long names end in "..." — tapping a song opens the now-playing screen, which shows the full name.
 */
export function HomeScreen(p: Props) {
  // The song whose ⋯ menu is open. A popup rather than a drop-down so it's never cut off at the bottom of the list.
  const [menuFor, setMenuFor] = useState<Track | null>(null);
  const choose = (action: (t: Track) => void) => () => {
    if (menuFor) action(menuFor);
    setMenuFor(null);
  };

  const filterLabel = p.filter
    ? `${p.filter.genres.join(', ')}${p.filter.genres.length > 1 ? (p.filter.mode === 'all' ? ' (all)' : ' (any)') : ''}`
    : null;

  return (
    <div className="screen home">
      <div className="fixed-part">
        <div
          className={`np-bar${p.current ? '' : ' empty'}`}
          role="button"
          tabIndex={p.current ? 0 : -1}
          onClick={() => p.current && p.onOpenNowPlaying()}
          onKeyDown={(e) => p.current && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), p.onOpenNowPlaying())}
        >
          <MusicIcon />
          <span className="np-text">
            {p.current ? `${p.current.title}${p.current.artist ? ` - ${p.current.artist}` : ''}` : 'Pick a song to start'}
          </span>
          <button
            className="round-btn"
            aria-label={p.playing ? 'Pause' : 'Play'}
            disabled={!p.current}
            onClick={(e) => { e.stopPropagation(); p.onToggle(); }}
          >
            {p.playing ? <PauseIcon /> : <PlayIcon />}
          </button>
        </div>

        <div className="genre-grid">
          {p.quickGenres.map((g) => (
            <button
              key={g}
              className={`genre-btn${p.filter?.quick && p.filter.genres[0] === g ? ' on' : ''}`}
              onClick={() => p.onQuickGenre(g)}
            >
              <span className="ellipsis">{g}</span>
            </button>
          ))}
          <button className={`genre-btn${p.filter && !p.filter.quick ? ' on' : ''}`} onClick={p.onShowAllGenres}>
            <FilterIcon /> Show all
          </button>
        </div>

        <div className="list-head">
          <span className="ellipsis">{filterLabel ? `Genre: ${filterLabel}` : 'All songs'} · {p.songs.length}</span>
          {p.filter && <button className="small-btn" onClick={p.onClearFilter}>Clear</button>}
        </div>
      </div>

      <div className="song-list">
        {p.loading && <p className="note">Loading songs…</p>}
        {p.loadError && <p className="note error">The songs couldn't be loaded. {p.loadError}</p>}
        {!p.loading && !p.loadError && p.libraryEmpty && <p className="note">No songs yet.</p>}
        {!p.loading && !p.libraryEmpty && p.songs.length === 0 && (
          <p className="note">No songs match. Try fewer genres or a different search.</p>
        )}
        {p.songs.map((t) => (
          <div key={t.trackId} className={`song-row${t.trackId === p.current?.trackId ? ' active' : ''}`}>
            <button className="song-pick" onClick={() => p.onPick(t)}>
              <SongArt track={t} />
              <span className="song-meta">
                <span className="ellipsis title">{t.title}</span>
                <span className="ellipsis sub">{t.artist ?? ''}</span>
              </span>
              {!!t.likes && <span className="row-likes" aria-label={`${t.likes} likes`}><HeartIcon size={14} />{t.likes}</span>}
              <span className="dur">{formatDuration(t.durationMs)}</span>
            </button>
            <button className="dots-btn" onClick={() => setMenuFor(t)} aria-label={`More for ${t.title}`}><DotsIcon /></button>
          </div>
        ))}
      </div>

      {menuFor && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label={menuFor.title} onClick={() => setMenuFor(null)}>
          <div className="dialog song-menu" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-head">
              <span className="ellipsis">{menuFor.title}</span>
              <button className="icon-btn" onClick={() => setMenuFor(null)} aria-label="Close"><CloseIcon /></button>
            </div>
            <button className="menu-item" onClick={choose(p.onPick)}><PlayIcon />Play</button>
            <button className="menu-item" onClick={choose(p.onAddToPlaylist)}><ListPlusIcon />Add to playlist</button>
            <button className="menu-item" onClick={choose(p.onBuy)}><BagIcon />Buy</button>
          </div>
        </div>
      )}
    </div>
  );
}
