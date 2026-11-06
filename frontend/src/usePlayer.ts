import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import Hls from 'hls.js';
import { isFreePaused, startPlayback, type Track } from './api';
import { useAuth } from './auth/AuthContext';
import { useListenLog } from './useListenLog';

/**
 * iPhones have no regular MediaSource, only Apple's ManagedMediaSource, which hls.js 1.x will use (iOS 17.1+).
 * That path is a poor fit for an audio app: iOS throttles or stops its downloads when it decides to
 * (screen locked, low power), and it rebuilds the buffer from scratch for every song, which shows up as stalls.
 * Apple's own HLS player handles caching, bitrate and lock-screen playback itself, so use it on iPhone.
 * Desktop browsers and Android (which have MediaSource) keep using hls.js.
 */
function preferNativeHls(audio: HTMLAudioElement): boolean {
  return !('MediaSource' in window) && audio.canPlayType('application/vnd.apple.mpegurl') !== '';
}

/** Start pre-downloading the next song this many seconds before the current one ends. */
const PREFETCH_LEAD_SECONDS = 25;
/** How many segments of the next song to pre-download (6 s each at 64 kbps, ~50 KB apiece). */
const PREFETCH_SEGMENTS = 3;

/**
 * Warms the browser's ordinary HTTP cache with the start of a song: master playlist, the lowest-bitrate
 * playlist, and its first few segments. Nothing is stored by us. It works because the API hands out the same
 * signed links for an hour and lets the browser keep playlists for 10 minutes, so the player later asks for
 * exactly these URLs and gets them from cache. Best effort: any failure just means a normal (uncached) start.
 */
async function warmStart(streamUrl: string): Promise<void> {
  const text = async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.text();
  };
  const links = (playlist: string) => playlist.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

  const master = await text(streamUrl);
  const variants = links(master);
  const lowest = variants.find((l) => l.includes('_64k')) ?? variants[0]; // the player starts on the lowest bitrate
  if (!lowest) return;
  const variantUrl = new URL(lowest, new URL(streamUrl, location.href)).href;
  const segments = links(await text(variantUrl)).slice(0, PREFETCH_SEGMENTS);
  await Promise.all(segments.map((seg) => fetch(new URL(seg, variantUrl).href).then((r) => r.blob())));
}

/** What to play. `nonce` changes on every request so picking the same song again restarts it. */
export interface LoadRequest {
  track: Track;
  nonce: number;
}

/**
 * Owns the single <audio> element for the whole app, so playback carries on across screens.
 * Render `audioProps` onto an <audio> that stays mounted.
 */
export function usePlayer(load: LoadRequest | null, onEnded: () => void, upcoming: Track | null = null) {
  const { getToken } = useAuth();
  const listenLog = useListenLog();
  const audioRef = useRef<HTMLAudioElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  /** Stream URLs already requested for upcoming songs (trackId -> /play result), so the song reuses the warmed links. */
  const prefetched = useRef(new Map<string, Promise<string>>());
  const prefetchKey = useRef('');
  /** True while one song is being swapped for the next, so the deliberate pause doesn't flash the Play button. */
  const switching = useRef(false);
  /** The song whose stream is attached to the <audio> element right now (null while loading or after a failure). */
  const attachedId = useRef<string | null>(null);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Every play request comes through here, and this is the one place that decides what it means:
  //   same song as the one loaded (Previous restarting it, repeat-one, picking it again) -> rewind to 0:00 on the
  //     source that's already attached: instant, uses the audio already downloaded, no API call.
  //   different song -> drop the old one and load the new one.
  useEffect(() => {
    const audio = audioRef.current;
    if (!load || !audio) return;
    let cancelled = false;
    setError(null);
    setPosition(0);

    const id = load.track.trackId;
    listenLog.begin(id); // every start (new song or the same one from 0:00) is a separate listen for royalties
    if (attachedId.current === id) {
      audio.currentTime = 0;
      audio.play().catch(() => setPlaying(false));
      return;
    }

    setDuration((load.track.durationMs ?? 0) / 1000);

    // iPhone (Apple's built-in player): stop and empty the old song right now, before waiting on the network.
    // Swapping the source on a still-playing element makes iOS pause, replay a scrap of the old song's leftover
    // audio when play() is called, then pause again while the new song loads. An emptied element has nothing
    // left to replay. hls.js (desktop/Android) doesn't do this, so it keeps swapping once the new link arrives.
    const native = preferNativeHls(audio) || !Hls.isSupported();
    attachedId.current = null;
    if (native) {
      switching.current = true;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }

    const early = prefetched.current.get(id);
    prefetched.current.delete(id); // use a pre-fetched URL once; later plays ask the API again
    (early ? early.catch(() => startPlayback(id, getToken)) : startPlayback(id, getToken))
      .then((url) => {
        if (cancelled) return;
        hlsRef.current?.destroy();
        hlsRef.current = null;
        if (preferNativeHls(audio)) {
          audio.src = url; // iPhone: Apple's built-in HLS player (see preferNativeHls)
        } else if (Hls.isSupported()) {
          const hls = new Hls({ startLevel: 0 }); // start on 64k (fast first sound, matches the pre-download), then step up
          hls.on(Hls.Events.ERROR, (_, data) => {
            if (!data.fatal) return;
            attachedId.current = null; // broken source: picking the song again should reload it, not rewind it
            setError('This song could not be played. Try again.');
          });
          hls.loadSource(url);
          hls.attachMedia(audio);
          hlsRef.current = hls;
        } else if (audio.canPlayType('application/vnd.apple.mpegurl')) {
          audio.src = url; // older Safari / iOS play HLS natively
        } else {
          switching.current = false;
          setPlaying(false);
          setError('This browser cannot play these songs.');
          return;
        }
        attachedId.current = id;
        audio.play()
          .catch(() => setPlaying(false))
          .finally(() => { if (!cancelled) switching.current = false; });
      })
      .catch((err) => {
        if (cancelled) return;
        switching.current = false;
        setPlaying(false);
        setError(isFreePaused(err) && err.userMessage ? err.userMessage : 'This song could not be started. Try again.');
      });

    return () => {
      cancelled = true;
    };
  }, [load, getToken, listenLog.begin]);

  useEffect(() => () => hlsRef.current?.destroy(), []);

  // Near the end of a song, pre-download the start of the next one so it begins without waiting.
  // Once per (current play, next song); if the queue changes, the new next song gets its own pre-download.
  useEffect(() => {
    if (!load || !upcoming || duration <= 0 || duration - position > PREFETCH_LEAD_SECONDS) return;
    const key = `${load.nonce}:${upcoming.trackId}`;
    if (prefetchKey.current === key) return;
    prefetchKey.current = key;
    const url = startPlayback(upcoming.trackId, getToken);
    prefetched.current.clear(); // only ever keep the one next song
    prefetched.current.set(upcoming.trackId, url);
    url.then(warmStart).catch(() => {}); // best effort
  }, [load, upcoming, position, duration, getToken]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !load) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }, [load]);

  const seekTo = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const end = Number.isFinite(audio.duration) ? audio.duration : duration;
    const t = Math.max(0, Math.min(end || 0, seconds));
    audio.currentTime = t;
    setPosition(t);
  }, [duration]);

  const seekBy = useCallback((delta: number) => seekTo((audioRef.current?.currentTime ?? 0) + delta), [seekTo]);

  const audioProps = {
    ref: audioRef,
    onPlay: () => setPlaying(true),
    onPause: () => {
      if (!switching.current) setPlaying(false);
      listenLog.flush();
    },
    onTimeUpdate: (e: SyntheticEvent<HTMLAudioElement>) => {
      setPosition(e.currentTarget.currentTime);
      listenLog.tick(e.currentTarget.currentTime, e.currentTarget.paused);
    },
    onDurationChange: (e: SyntheticEvent<HTMLAudioElement>) => {
      const d = e.currentTarget.duration;
      if (Number.isFinite(d)) setDuration(d);
    },
    onEnded: () => {
      listenLog.flush();
      onEndedRef.current();
    },
    // Apple's built-in HLS player reports failures here (hls.js reports through its ERROR event instead).
    onError: (e: SyntheticEvent<HTMLAudioElement>) => {
      if (hlsRef.current || !e.currentTarget.getAttribute('src')) return;
      attachedId.current = null; // broken source: picking the song again should reload it, not rewind it
      setError('This song could not be played. Try again.');
    },
  };

  return { audioProps, playing, position, duration, error, toggle, seekTo, seekBy };
}
