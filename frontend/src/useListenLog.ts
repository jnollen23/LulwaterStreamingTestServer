import { useCallback, useEffect, useRef } from 'react';
import { reportListen, startListen } from './api';
import { useAuth } from './auth/AuthContext';

/** Matches PLAY_COUNTS_AFTER_SECONDS in backend/shared/plays.ts: the first report goes out right as a play counts. */
const FIRST_REPORT_SECONDS = 30;
/** After that, report the running total this often (minutes listened feed royalties and, later, time limits). */
const REPORT_EVERY_SECONDS = 60;
/** A jump in position bigger than this between two time updates is a seek, not listening. */
const MAX_TICK_SECONDS = 2;

interface Listen {
  playId: Promise<string | null>;
  heard: number;
  reported: number;
  lastTime: number | null;
}

/**
 * Royalty play log on the browser side. Counts only time actually heard: seeking ahead, pausing and failed
 * loads add nothing. The server re-checks every total against its own clock.
 *   begin()  a song starts playing (a new song, or the same one from 0:00 again) — closes out the previous listen
 *   tick()   on every <audio> time update
 *   flush()  pause or song end: send what's been heard so far
 */
export function useListenLog() {
  const { getToken } = useAuth();
  const current = useRef<Listen | null>(null);

  const send = useCallback((listen: Listen) => {
    if (listen.heard <= listen.reported) return;
    const seconds = listen.heard;
    listen.reported = seconds;
    listen.playId
      .then((id) => (id ? reportListen(id, seconds, getToken) : undefined))
      .catch(() => {}); // best effort; the next report carries the full total anyway
  }, [getToken]);

  const begin = useCallback((trackId: string) => {
    if (current.current) send(current.current);
    current.current = {
      playId: startListen(trackId, getToken).catch(() => null),
      heard: 0,
      reported: 0,
      lastTime: null,
    };
  }, [getToken, send]);

  const tick = useCallback((time: number, paused: boolean) => {
    const listen = current.current;
    if (!listen) return;
    const step = listen.lastTime === null ? 0 : time - listen.lastTime;
    listen.lastTime = time;
    if (paused || step <= 0 || step > MAX_TICK_SECONDS) return;
    listen.heard += step;
    const due = listen.reported < FIRST_REPORT_SECONDS
      ? listen.heard >= FIRST_REPORT_SECONDS
      : listen.heard - listen.reported >= REPORT_EVERY_SECONDS;
    if (due) send(listen);
  }, [send]);

  // Switching apps or closing the tab sends what's been heard so far.
  useEffect(() => {
    const flush = () => { if (current.current) send(current.current); };
    const onHidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [send]);

  const flush = useCallback(() => { if (current.current) send(current.current); }, [send]);

  return { begin, tick, flush };
}
