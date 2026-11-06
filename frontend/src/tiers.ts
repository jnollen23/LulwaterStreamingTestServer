/** Account levels. 'free' is the anonymous listener; the rest are monthly subscriptions. */
export type Tier = 'free' | 'basic' | 'premium' | 'corporate';

export interface TierInfo {
  name: string;
  /** US dollars per month; 0 for free. */
  price: number;
  perks: string[];
}

// TODO(tiers): prices are placeholders from the client (2026-10-30). The limits below are shown to listeners but
// not enforced yet — enforcement needs accounts and server-side listening-time tracking.
export const TIERS: Record<Tier, TierInfo> = {
  free: {
    name: 'Free',
    price: 0,
    perks: ['1 hour of listening a day', 'No account needed'],
  },
  basic: {
    name: 'Basic',
    price: 5,
    perks: ['4 hours of listening a day', 'Best streaming quality'],
  },
  premium: {
    name: 'Premium',
    price: 10,
    perks: ['Unlimited listening at best streaming quality', '1 hour a day of studio lossless quality'],
  },
  corporate: {
    name: 'Corporate',
    price: 50,
    perks: ['Unlimited studio lossless quality', 'License to play in venues'],
  },
};

export const PAID_TIERS: Tier[] = ['basic', 'premium', 'corporate'];
