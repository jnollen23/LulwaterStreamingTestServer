import { useEffect, useMemo, useRef, useState } from 'react';
import { likeTrack, listTracks, type Track } from './api';
import { useAuth } from './auth/AuthContext';
import { QUICK_GENRE_COUNT } from './config';
import { genresByPopularity, matchesGenres, type GenreFilter } from './genres';
import { usePlayer, type LoadRequest } from './usePlayer';
import { GenrePicker } from './components/GenrePicker';
import { HomeScreen } from './components/HomeScreen';
import { AboutScreen, BuyScreen, SongInfoDialog, TermsDialog } from './components/InfoScreens';
import { AccountScreen } from './components/AccountScreen';
import type { Tier } from './tiers';
import { NowPlayingScreen, SONG_PARAM, type LoopMode } from './components/NowPlayingScreen';
import { BackIcon, BagIcon, HomeIcon, InfoIcon, MoonIcon, SearchIcon, SunIcon, UserIcon } from './components/Icons';

type Screen = 'home' | 'now' | 'about' | 'buy' | 'account';

const LOOP_CYCLE: Record<LoopMode, LoopMode> = { off: 'all', all: 'one', one: 'off' };

function shuffled<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function App() {
  const { getToken } = useAuth();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [screen, setScreen] = useState<Screen>('home');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<GenreFilter | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // About on the now-playing screen opens this song's lyrics / copyright / AI popup instead of the About page.
  const [songInfoOpen, setSongInfoOpen] = useState(false);
  // Why the listener was sent to the Account tab (e.g. Add to playlist needs an account); cleared on leaving it.
  const [accountNote, setAccountNote] = useState<string | null>(null);
  // TODO(accounts): the plan should come from the signed-in account (GET /api/me). Until accounts exist it's
  // memory only, like likes and the theme, so a reload goes back to Free.
  const [tier, setTier] = useState<Tier>('free');
  // Nothing is stored in the browser (no cookies or local storage), so the terms show on every page load.
  const [termsAccepted, setTermsAccepted] = useState(false);
  // Songs liked during this visit. Kept in memory only (client wants zero cookies), so a reload clears it.
  const [liked, setLiked] = useState<Set<string>>(new Set());
  // Dark on every device until the listener taps the sun/moon button. Memory only (no cookies), so a reload resets it.
  const [dark, setDark] = useState(true);

  // Play queue: `base` is the list the song was picked from, `order` is what actually plays (shuffled or not).
  const [base, setBase] = useState<string[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const [pos, setPos] = useState(0);
  const [load, setLoad] = useState<LoadRequest | null>(null);
  const [loop, setLoop] = useState<LoopMode>('off');
  const [shuffle, setShuffle] = useState(false);
  const nonce = useRef(0);

  useEffect(() => {
    listTracks(getToken)
      .then(setTracks)
      .catch((err) => setLoadError(String(err)))
      .finally(() => setLoading(false));
  }, [getToken]);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  const byId = useMemo(() => new Map(tracks.map((t) => [t.trackId, t])), [tracks]);
  const allGenres = useMemo(() => genresByPopularity(tracks), [tracks]);
  const quickGenres = allGenres.slice(0, QUICK_GENRE_COUNT);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tracks.filter((t) =>
      matchesGenres(t, filter) &&
      (!q || [t.title, t.artist, t.album].some((v) => v?.toLowerCase().includes(q))));
  }, [tracks, query, filter]);

  const current = load?.track ?? null;

  const setLikes = (id: string, likes: number) =>
    setTracks((ts) => ts.map((t) => (t.trackId === id ? { ...t, likes } : t)));

  const like = (id: string) => {
    if (liked.has(id)) return;
    const before = byId.get(id)?.likes ?? 0;
    setLiked((s) => new Set(s).add(id));
    setLikes(id, before + 1); // show it straight away; the server's total replaces it
    likeTrack(id, before, getToken)
      .then((total) => setLikes(id, total))
      .catch(() => {
        setLikes(id, before);
        setLiked((s) => { const n = new Set(s); n.delete(id); return n; });
      });
  };

  const playAt = (newOrder: string[], index: number) => {
    const track = byId.get(newOrder[index]);
    if (!track) return;
    setOrder(newOrder);
    setPos(index);
    setLoad({ track, nonce: ++nonce.current });
  };

  const next = (auto: boolean) => {
    // Repeat-one replays the same song; usePlayer sees it's the same track and just rewinds it.
    if (auto && loop === 'one') return playAt(order, pos);
    if (pos + 1 < order.length) return playAt(order, pos + 1);
    if (loop === 'all') return playAt(shuffle ? shuffled(order) : order, 0);
    if (!auto && order.length) return playAt(order, 0); // pressing Next on the last song goes back to the top
  };

  // The song that will load when this one ends, so the player can pre-download its start. Repeat-one just
  // rewinds (nothing new to load), and a shuffled loop-all reshuffles at the wrap, so neither is known ahead.
  const upcoming = loop === 'one' ? undefined
    : pos + 1 < order.length ? byId.get(order[pos + 1])
    : loop === 'all' && !shuffle ? byId.get(order[0])
    : undefined;

  const player = usePlayer(load, () => next(true), upcoming ?? null);

  const prev = () => {
    // Restart the current song (usePlayer rewinds it in place) unless we're right at its start.
    if (player.position > 3 || pos === 0 && loop !== 'all') return playAt(order, pos);
    playAt(order, (pos - 1 + order.length) % order.length);
  };

  const pick = (track: Track) => {
    const ids = visible.map((t) => t.trackId);
    setBase(ids);
    const newOrder = shuffle ? [track.trackId, ...shuffled(ids.filter((id) => id !== track.trackId))] : ids;
    playAt(newOrder, newOrder.indexOf(track.trackId));
    setScreen('now');
  };

  const toggleShuffle = () => {
    const on = !shuffle;
    setShuffle(on);
    if (!current) return;
    const id = current.trackId;
    if (on) {
      setOrder([id, ...shuffled(base.filter((x) => x !== id))]);
      setPos(0);
    } else {
      setOrder(base);
      setPos(Math.max(0, base.indexOf(id)));
    }
  };

  const go = (s: Screen) => {
    setScreen(s);
    setAccountNote(null);
  };

  // TODO(playlists): saved playlists need accounts; until then Add to playlist explains that on the Account tab.
  const addToPlaylist = () => {
    setScreen('account');
    setAccountNote('Playlists need an account. Accounts are coming soon.');
  };

  // A forwarded link (?song=<id>) opens that song once the terms are accepted; that tap lets the browser start audio.
  const sharedSong = useRef(new URLSearchParams(window.location.search).get(SONG_PARAM));
  useEffect(() => {
    if (!sharedSong.current || !termsAccepted || loading) return;
    const track = byId.get(sharedSong.current);
    sharedSong.current = null;
    if (track) pick(track);
  }, [termsAccepted, loading, byId]);

  // The whole play order, for the playlist page. Ids all come from `tracks`, so indexes line up with `order`.
  const queue = useMemo(() => order.map((id) => byId.get(id)).filter((t): t is Track => !!t), [order, byId]);

  const quickGenre = (g: string) =>
    setFilter((f) => (f?.quick && f.genres[0] === g ? null : { genres: [g], mode: 'any', quick: true }));

  return (
    <div className="app">
      <audio {...player.audioProps} />

      <header className="search-row">
        {screen === 'now' && current ? (
          <button className="back-btn" onClick={() => setScreen('home')} aria-label="Back to all songs"><BackIcon />Back</button>
        ) : (
          <label className="search-box">
            <SearchIcon />
            <input
              type="search"
              placeholder="Search songs or artists"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setScreen('home'); }}
              aria-label="Search songs or artists"
            />
          </label>
        )}
        <button
          className="theme-btn"
          onClick={() => setDark((d) => !d)}
          aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          title={dark ? 'Light mode' : 'Dark mode'}
        >
          {dark ? <SunIcon /> : <MoonIcon />}
        </button>
      </header>

      <main className="main">
        {screen === 'now' && current ? (
          <NowPlayingScreen
            track={current}
            playing={player.playing}
            position={player.position}
            duration={player.duration}
            error={player.error}
            loop={loop}
            shuffle={shuffle}
            queue={queue}
            queueIndex={pos}
            onPickQueue={(index) => playAt(order, index)}
            likes={byId.get(current.trackId)?.likes ?? 0}
            liked={liked.has(current.trackId)}
            onLike={() => like(current.trackId)}
            onToggle={player.toggle}
            onSeekTo={player.seekTo}
            onPrev={prev}
            onNext={() => next(false)}
            onLoop={() => setLoop((l) => LOOP_CYCLE[l])}
            onShuffle={toggleShuffle}
          />
        ) : screen === 'about' ? (
          <AboutScreen />
        ) : screen === 'buy' ? (
          <BuyScreen />
        ) : screen === 'account' ? (
          <AccountScreen note={accountNote} tier={tier} onTierChange={setTier} />
        ) : (
          <HomeScreen
            current={current}
            playing={player.playing}
            onToggle={player.toggle}
            onOpenNowPlaying={() => setScreen('now')}
            quickGenres={quickGenres}
            filter={filter}
            onQuickGenre={quickGenre}
            onShowAllGenres={() => setPickerOpen(true)}
            onClearFilter={() => setFilter(null)}
            songs={visible}
            onPick={pick}
            onAddToPlaylist={addToPlaylist}
            onBuy={() => go('buy')}
            loading={loading}
            loadError={loadError}
            libraryEmpty={tracks.length === 0}
          />
        )}
      </main>

      <nav className="bottom-bar">
        <button className={(screen === 'home' || screen === 'now') && !songInfoOpen ? 'on' : ''} onClick={() => go('home')}><HomeIcon />Home</button>
        <button
          className={screen === 'about' || songInfoOpen ? 'on' : ''}
          onClick={() => (screen === 'now' && current ? setSongInfoOpen(true) : go('about'))}
        >
          <InfoIcon />About
        </button>
        <button className={screen === 'buy' ? 'on' : ''} onClick={() => go('buy')}><BagIcon />Buy</button>
        <button className={screen === 'account' ? 'on' : ''} onClick={() => go('account')}><UserIcon />Account</button>
      </nav>

      {pickerOpen && (
        <GenrePicker
          allGenres={allGenres}
          tracks={tracks}
          initial={filter && !filter.quick ? filter : null}
          onSearch={(f) => { setFilter(f); setPickerOpen(false); setScreen('home'); }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {songInfoOpen && current && <SongInfoDialog track={current} onClose={() => setSongInfoOpen(false)} />}

      {!termsAccepted && <TermsDialog onAccept={() => setTermsAccepted(true)} />}
    </div>
  );
}
