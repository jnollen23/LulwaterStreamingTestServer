import { useEffect, useRef, useState } from 'react';
import type { Track } from '../api';
import { DONATE_URL } from '../config';
import { BagIcon, CloseIcon, HeartIcon, LayersIcon, MusicIcon } from './Icons';

export const FREE_ITEMS = [
  'No ads', 'No apps', 'No account required', 'No credit card required', 'No pop-ups',
  'High resolution music', 'Easy user menu', 'Clean content', 'Cool merchandise', 'Multitracks available',
];

export const NOT_FREE_ITEMS = [
  'Licenses for non-personal use (church use is considered commercial use)',
  'Downloading the content for personal or commercial use',
  'Commercial use of the content without a contractual agreement',
  'Recording the content in any form',
  'Multitracks, which are available for sale',
  'Reproduction or rebroadcast of any content, including written or electronic translations of the Holy Scriptures, without a contractual agreement',
  'Providing content you purchase to others without them obtaining their own contractual agreement',
];

export function TermsLists() {
  return (
    <div className="terms-lists">
      <div>
        <div className="terms-head free">Free</div>
        <ul>{FREE_ITEMS.map((t) => <li key={t}>{t}</li>)}</ul>
      </div>
      <div>
        <div className="terms-head not-free">Not free</div>
        <ul>{NOT_FREE_ITEMS.map((t) => <li key={t}>{t}</li>)}</ul>
      </div>
    </div>
  );
}

// First-visit terms popup. Banner and Accept button stay fixed; only the lists scroll, with a fade and
// "scroll for more" cue until the bottom is reached so phone users know there is more to read.
export function TermsDialog({ onAccept }: { onAccept: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);

  const check = () => {
    const el = scrollRef.current;
    if (el) setMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
  };

  useEffect(() => {
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Terms and conditions">
      <div className="dialog terms">
        <div className="brand-banner">LULLWATER STUDIOS</div>
        <div className={`terms-scroll${moreBelow ? ' more' : ''}`} ref={scrollRef} onScroll={check}>
          <TermsLists />
        </div>
        {moreBelow && <div className="scroll-cue" aria-hidden="true">Scroll for more ↓</div>}
        <button className="primary-btn" onClick={onAccept}>Accept terms and conditions</button>
      </div>
    </div>
  );
}

export function AboutScreen() {
  return (
    <div className="screen page">
      <h2>About Lullwater Studios</h2>
      {/* TODO(about): replace with the real About Us copy. */}
      <p>Free, high-resolution music with no ads, no apps, no account and no credit card.</p>
      <TermsLists />
    </div>
  );
}

/** About while a song is playing: that song's lyrics, copyright and AI information in one scrolling popup. */
export function SongInfoDialog({ track, onClose }: { track: Track; onClose: () => void }) {
  const missing = <span className="faint">Not added yet.</span>;
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="About this song" onClick={onClose}>
      <div className="dialog song-info" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          About this song
          <button className="icon-btn" onClick={onClose} aria-label="Close"><CloseIcon /></button>
        </div>
        <div>
          <div className="np-title">{track.title}</div>
          {track.artist && <div className="np-artist">{track.artist}</div>}
        </div>
        <div className="song-info-scroll">
          <section><h3>Lyrics</h3>{track.lyrics ? <p className="lyrics">{track.lyrics}</p> : missing}</section>
          <section><h3>Copyright</h3>{track.copyright ? <p>{track.copyright}</p> : missing}</section>
          <section><h3>AI information</h3>{track.aiInfo ? <p>{track.aiInfo}</p> : missing}</section>
        </div>
        <button className="primary-btn" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

/** Buy: the store (Donate + Shop merged), with Donate at the bottom. */
export function BuyScreen() {
  // TODO(buy): song downloads, multitracks and merchandise, once the payment provider is chosen (not PayPal).
  return (
    <div className="screen page buy">
      <h2>Buy</h2>
      <div className="card">
        <span className="card-icon"><MusicIcon size={20} /></span>
        <span className="card-text"><b>Song downloads</b><span>Coming soon</span></span>
      </div>
      <div className="card">
        <span className="card-icon"><LayersIcon /></span>
        <span className="card-text"><b>Multitracks</b><span>Coming soon</span></span>
      </div>
      <div className="card">
        <span className="card-icon"><BagIcon /></span>
        <span className="card-text"><b>Merchandise</b><span>Coming soon</span></span>
      </div>
      <div className="card donate">
        <b className="donate-head"><HeartIcon size={20} /> Support Lullwater Studios</b>
        <span className="card-sub">Donations keep the music free for everyone.</span>
        <a className="primary-btn" href={DONATE_URL} target="_blank" rel="noopener noreferrer">Donate</a>
      </div>
    </div>
  );
}
