/**
 * LOGIN HOOK — flip to true once a login provider (e.g. Cognito) is wired into auth/AuthContext.tsx
 * and backend/shared/auth.ts. Shows the Log in / Log out buttons and sends the auth token with API calls.
 */
export const AUTH_ENABLED = false;

// TODO(donate): replace with the real donate link. Payment provider not chosen yet (client says not PayPal).
export const DONATE_URL = 'https://www.paypal.com/donate';

/** How many genres get their own button on the home screen; the 6th button is "Show all". */
export const QUICK_GENRE_COUNT = 5;
