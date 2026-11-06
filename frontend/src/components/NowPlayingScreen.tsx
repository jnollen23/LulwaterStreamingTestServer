import { useEffect, useRef, useState } from 'react';
import { formatDuration, type Track } from '../api';
import { ChevronIcon, HeartIcon, MusicIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon, RepeatIcon, ShuffleIcon } from './Icons';
import { SongArt } from './SongArt';

export type LoopMode = 'off' | 'all' | 'one';
export const LOOP_LABEL: Record<LoopMode, string> = { off: 'Loop off', all: 'Loop', one: 'Repeat one' };

/** Query parameter on a forwarded link (?song=<trackId>); App opens that song when the page loads. */
export const SONG_PARAM = 'song';

function songLink(trackId: string): string {
  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set(SONG_PARAM, trackId);
  return url.toString();
}

/** Same media query as the phone layout in styles.css. */
const TOUCH_QUERY = '(hover: none), (pointer: coarse)';
/** How far a finger has to travel before a swipe flips between the player and the playlist. */
const SWIPE_PX = 60;
/** Movement below this still counts as a tap, so rows and buttons keep working. */
const TAP_SLOP_PX = 8;

function useTouchLayout(): boolean {
  const [touch, setTouch] = useState(() => window.matchMedia(TOUCH_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(TOUCH_QUERY);
    const update = () => setTouch(mq.matches);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return touch;
}

interface Props {
  track: Track;
  playing: boolean;
  position: number;
  duration: number;
  error: string | null;
  loop: LoopMode;
  shuffle: boolean;
  queue: Track[];
  queueIndex: number;
  likes: number;
  liked: boolean;
  onLike: () => void;
  onToggle: () => void;
  onSeekTo: (seconds: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onLoop: () => void;
  onShuffle: () => void;
  onPickQueue: (index: number) => void;
}

/**
 * Now playing.
 * Phone: two full-height pages stacked. The player never scrolls; tapping (or swiping up on) Next songs slides
 * the playlist into view, and tapping "Tap to go back" (or swiping down from the top of the playlist) slides back.
 * PC: one page that scrolls normally, with the playlist under the player.
 */
export function NowPlayingScreen(p: Props) {
  const touch = useTouchLayout();
  const nextArea = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const queueHead = useRef<HTMLDivElement>(null);
  const queueList = useRef<HTMLDivElement>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [drag, setDrag] = useState(0); // finger offset in px while a swipe is in progress

  // Swipes. Native listeners so touchmove can preventDefault (stops pull-to-refresh and the list rubber-banding).
  useEffect(() => {
    const el = stack.current;
    if (!touch || !el) return;
    let startY = 0;
    let dy = 0;
    let mode: 'open' | 'close' | null = null;

    const start = (e: TouchEvent) => {
      const target = e.target as Node;
      startY = e.touches[0].clientY;
      dy = 0;
      if (!queueOpen) mode = nextArea.current?.contains(target) ? 'open' : null;
      else mode = queueHead.current?.contains(target) || (queueList.current?.scrollTop ?? 0) <= 0 ? 'close' : null;
    };
    const move = (e: TouchEvent) => {
      if (!mode) return;
      dy = e.touches[0].clientY - startY;
      const towards = mode === 'open' ? dy < 0 : dy > 0;
      if (!towards) {
        // Pushing up from the top of the playlist is an ordinary scroll, not a swipe.
        if (mode === 'close' && dy < -TAP_SLOP_PX && !queueHead.current?.contains(e.target as Node)) mode = null;
        setDrag(0);
        return;
      }
      if (Math.abs(dy) < TAP_SLOP_PX) return;
      e.preventDefault();
      setDrag(dy);
    };
    const end = () => {
      if (!mode) return;
      if (mode === 'open' ? dy < -SWIPE_PX : dy > SWIPE_PX) setQueueOpen(mode === 'open');
      mode = null;
      setDrag(0);
    };

    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
  }, [touch, queueOpen]);

  // Opening the playlist starts at the song that's playing. Set scrollTop directly rather than scrollIntoView,
  // which would also try to scroll the page container.
  useEffect(() => {
    const list = queueList.current;
    if (!touch || !queueOpen || !list) return;
    const row = list.querySelector<HTMLElement>('.queue-row.current');
    list.scrollTop = row ? Math.max(0, row.offsetTop - list.clientHeight / 3) : 0;
  }, [touch, queueOpen]);

  // Brief confirmation shown in the mode line, e.g. after the link is copied.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(t);
  }, [notice]);

  /** Phones (and most desktop browsers) open the system share sheet with Messages etc.; otherwise copy the link. */
  const share = async () => {
    const url = songLink(p.track.trackId);
    const title = p.track.artist ? `${p.track.title} by ${p.track.artist}` : p.track.title;
    if (navigator.share) {
      try {
        await navigator.share({ title, text: `Listen to ${title}`, url });
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return; // they closed the share sheet
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setNotice('Link copied');
    } catch {
      window.prompt('Copy this link to share the song:', url);
    }
  };

  const pct = p.duration > 0 ? Math.min(100, (p.position / p.duration) * 100) : 0;
  const totalMs = p.duration ? p.duration * 1000 : p.track.durationMs;
  const stackStyle = touch
    ? { transform: `translateY(calc(${queueOpen ? -50 : 0}% + ${drag}px))`, transition: drag ? 'none' : undefined }
    : undefined;

  return (
    <div className="screen now">
      <div className="np-stack" ref={stack} style={stackStyle}>
        <section className="np-page np-player" inert={touch && queueOpen}>
          <div className="cover-band">
            <div className="cover" style={p.track.artPath ? { backgroundImage: `url(${p.track.artPath})` } : undefined}>
              {!p.track.artPath && <span className="cover-placeholder"><MusicIcon size={56} /></span>}
            </div>
          </div>

          <div className="np-head">
            <button
              className={`ctl like${p.liked ? ' on' : ''}`}
              onClick={p.onLike}
              disabled={p.liked}
              aria-label={p.liked ? `Liked, ${p.likes} likes` : `Like this song, ${p.likes} likes`}
            >
              <HeartIcon filled={p.liked} size={20} />
              <span>{p.likes}</span>
            </button>
            <div className="np-name">
              <div className="np-title">{p.track.title}</div>
              <div className="np-artist">{p.error ?? p.track.artist ?? ''}</div>
            </div>
            <button className="share-btn" onClick={share}>Share song</button>
          </div>

          <div className="progress">
            <span>{formatDuration(p.position * 1000)}</span>
            <input
              type="range"
              min={0}
              max={p.duration || 0}
              step={1}
              value={Math.min(p.position, p.duration || 0)}
              onChange={(e) => p.onSeekTo(Number(e.target.value))}
              aria-label="Song position"
              style={{ ['--pct' as string]: `${pct}%` }}
            />
            <span>{formatDuration(p.duration * 1000)}</span>
          </div>

          <div className="transport">
            <button className={`ctl labeled${p.loop !== 'off' ? ' on' : ''}`} onClick={p.onLoop} aria-label={LOOP_LABEL[p.loop]}>
              <RepeatIcon one={p.loop === 'one'} />
              <span aria-hidden="true">{LOOP_LABEL[p.loop]}</span>
            </button>
            <button className="ctl" onClick={p.onPrev} aria-label="Previous song"><PrevIcon /></button>
            <button className="ctl play" onClick={p.onToggle} aria-label={p.playing ? 'Pause' : 'Play'}>
              {p.playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button className="ctl" onClick={p.onNext} aria-label="Next song"><NextIcon /></button>
            <button className={`ctl labeled${p.shuffle ? ' on' : ''}`} onClick={p.onShuffle} aria-label={p.shuffle ? 'Shuffle on' : 'Shuffle off'}>
              <ShuffleIcon />
              <span aria-hidden="true">{p.shuffle ? 'Shuffle on' : 'Shuffle off'}</span>
            </button>
          </div>
          {/* Loop and shuffle say their own state under their icons; this line is only for brief notices. */}
          <div className="mode-line" aria-live="polite">{notice}</div>

          {/* Phone only: one button (no song names) that opens the playlist; also the place to swipe up from. */}
          <div className="next-area" ref={nextArea}>
            <button className="next-btn" onClick={() => setQueueOpen(true)}>
              <b>Next songs</b><span>— tap to see</span><ChevronIcon up />
            </button>
          </div>
        </section>

        <section className="np-page np-queue" inert={touch && !queueOpen} aria-label="Playlist">
          <div className="queue-head" ref={queueHead}>
            <span className="grabber" aria-hidden="true" />
            <button className="queue-close" onClick={() => setQueueOpen(false)} aria-label="Back to now playing">
              <b>Tap to go back <ChevronIcon /></b>
              <span>to the song that's playing</span>
            </button>
            <h2 className="queue-title">Playlist</h2>
          </div>
          <div className="queue-list" ref={queueList}>
            {p.queue.map((t, i) => {
              const name = <span className="ellipsis">{t.title}{t.artist ? ` - ${t.artist}` : ''}</span>;
              return i === p.queueIndex ? (
                <div key={`${t.trackId}-${i}`} className="queue-row current">
                  <SongArt track={t} />
                  {name}
                  <span className="dur">{formatDuration(p.position * 1000)} / {formatDuration(totalMs)}</span>
                  <button className="round-btn" onClick={p.onToggle} aria-label={p.playing ? 'Pause' : 'Play'}>
                    {p.playing ? <PauseIcon /> : <PlayIcon />}
                  </button>
                </div>
              ) : (
                <button key={`${t.trackId}-${i}`} className="queue-row" onClick={() => p.onPickQueue(i)}>
                  <SongArt track={t} />
                  {name}
                  <span className="dur">{formatDuration(t.durationMs)}</span>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
