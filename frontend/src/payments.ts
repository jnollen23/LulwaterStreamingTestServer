import type { Tier } from './tiers';

export type CheckoutResult = { ok: true; tier: Tier } | { ok: false; error: string };

/** How long the pretend "Checking payment" step takes. */
const MOCK_CHECKOUT_MS = 500;

/**
 * PAYMENT HOOK — starts a subscription to `tier`.
 *
 * For now this pretends the payment went through. TODO(payments): once the provider is chosen (Stripe or Paddle),
 * replace the body with:
 *   1. POST /api/checkout { tier } — the backend asks the provider for a checkout session and returns its URL.
 *   2. Send the listener to that URL. The card is typed on the provider's own page and never reaches our servers,
 *      which keeps PCI to the short self-assessment form.
 *   3. The provider charges monthly on its own and tells our backend (webhook) when a subscription starts, renews,
 *      fails or is cancelled; the backend stores only the provider's customer id and the current tier.
 *   4. The provider's return URL brings the listener back here, and the app reads the tier from GET /api/me.
 */
export async function startCheckout(tier: Tier): Promise<CheckoutResult> {
  await new Promise((resolve) => setTimeout(resolve, MOCK_CHECKOUT_MS));
  return { ok: true, tier };
}
