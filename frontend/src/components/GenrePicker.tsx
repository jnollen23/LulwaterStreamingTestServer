import { useMemo, useState } from 'react';
import type { Track } from '../api';
import { matchesGenres, type GenreFilter, type GenreMode } from '../genres';
import { CloseIcon } from './Icons';

interface Props {
  allGenres: string[];
  tracks: Track[];
  initial: GenreFilter | null;
  onSearch: (filter: GenreFilter) => void;
  onClose: () => void;
}

/** "Show all" pop-up: pick several genres, match any or all of them. Warns live when nothing matches. */
export function GenrePicker({ allGenres, tracks, initial, onSearch, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>(initial?.genres ?? []);
  const [mode, setMode] = useState<GenreMode>(initial?.mode ?? 'any');
  const [error, setError] = useState<string | null>(null);

  const shown = allGenres.filter((g) => g.toLowerCase().includes(query.trim().toLowerCase()));
  const matchCount = useMemo(
    () => tracks.filter((t) => matchesGenres(t, { genres: selected, mode })).length,
    [tracks, selected, mode],
  );

  const toggle = (g: string) => {
    setError(null);
    setSelected((s) => (s.includes(g) ? s.filter((x) => x !== g) : [...s, g]));
  };

  const search = () => {
    if (selected.length === 0) {
      setError('Pick at least one genre first.');
      return;
    }
    onSearch({ genres: selected, mode });
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="All genres" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <span>All genres</span>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><CloseIcon /></button>
        </div>

        <input
          className="search-input"
          type="search"
          placeholder="Find a genre"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="tag-box">
          {shown.map((g) => (
            <button key={g} className={`tag${selected.includes(g) ? ' on' : ''}`} aria-pressed={selected.includes(g)} onClick={() => toggle(g)}>
              {g}
            </button>
          ))}
          {shown.length === 0 && <p className="note">No genres match that.</p>}
        </div>

        <label className="radio">
          <input type="radio" name="genre-mode" checked={mode === 'any'} onChange={() => setMode('any')} />
          Include songs that match at least one genre
        </label>
        <label className="radio">
          <input type="radio" name="genre-mode" checked={mode === 'all'} onChange={() => setMode('all')} />
          Include songs that match all genres
        </label>

        <div className="dialog-msg" aria-live="polite">
          {error ?? (selected.length > 0 && matchCount === 0
            ? <span className="warn">No songs match. Try fewer genres.</span>
            : selected.length > 0 ? `${matchCount} song${matchCount === 1 ? '' : 's'} match` : '')}
        </div>

        <button className="primary-btn" onClick={search}>Search</button>
      </div>
    </div>
  );
}
