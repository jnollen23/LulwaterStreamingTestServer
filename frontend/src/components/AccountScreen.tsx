import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { AUTH_ENABLED } from '../config';
import { startCheckout } from '../payments';
import { PAID_TIERS, TIERS, type Tier } from '../tiers';

type Checkout = { tier: Tier; state: 'checking' } | { tier: Tier; state: 'done' } | { tier: Tier; state: 'failed'; error: string };

interface Props {
  /** Why the listener was sent here (e.g. from Add to playlist); null when they tapped the tab. */
  note: string | null;
  tier: Tier;
  onTierChange: (tier: Tier) => void;
}

/** Account: the listener's current plan and the three subscriptions, each with its own Subscribe button. */
export function AccountScreen({ note, tier, onTierChange }: Props) {
  const { user, login, logout } = useAuth();
  const [checkout, setCheckout] = useState<Checkout | null>(null);

  const subscribe = async (to: Tier) => {
    setCheckout({ tier: to, state: 'checking' });
    const result = await startCheckout(to);
    if (result.ok) {
      onTierChange(result.tier);
      setCheckout({ tier: result.tier, state: 'done' });
    } else {
      setCheckout({ tier: to, state: 'failed', error: result.error });
    }
  };

  return (
    <div className="screen page account">
      <h2>Account</h2>
      {note && <p className="warn">{note}</p>}
      <p className="card-sub">Your plan: <b className="plan-name">{TIERS[tier].name}</b></p>

      {PAID_TIERS.map((t) => {
        const info = TIERS[t];
        const current = t === tier;
        return (
          <div key={t} className={`card plan${current ? ' current' : ''}`}>
            <div className="plan-head"><b>{info.name}</b><span className="plan-price">${info.price}/month</span></div>
            <ul className="checks">{info.perks.map((perk) => <li key={perk}>{perk}</li>)}</ul>
            {current
              ? <div className="plan-badge">Your plan</div>
              : <button className="primary-btn" onClick={() => subscribe(t)}>Subscribe to {info.name}</button>}
          </div>
        );
      })}

      <p className="card-sub">Free: {TIERS.free.perks.join(', ').toLowerCase()}.</p>
      {AUTH_ENABLED && (user
        ? <button className="outline-btn" onClick={logout}>Log out</button>
        : <button className="outline-btn" onClick={login}>Sign in</button>)}

      {checkout && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="Payment">
          <div className="dialog checkout" aria-live="polite">
            {checkout.state === 'checking' && (
              <>
                <span className="spinner" aria-hidden="true" />
                <b>Checking payment…</b>
                <span className="card-sub">{TIERS[checkout.tier].name}, ${TIERS[checkout.tier].price}/month</span>
              </>
            )}
            {checkout.state === 'done' && (
              <>
                <span className="done-mark" aria-hidden="true">✓</span>
                <b>Great! You're subscribed.</b>
                <span className="card-sub">Your account is now <b className="plan-name">{TIERS[checkout.tier].name}</b>.</span>
                <button className="primary-btn" onClick={() => setCheckout(null)}>OK</button>
              </>
            )}
            {checkout.state === 'failed' && (
              <>
                <b>The payment didn't go through.</b>
                <span className="card-sub">{checkout.error}</span>
                <button className="primary-btn" onClick={() => setCheckout(null)}>OK</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
