/**
 * Gateway apps and grants (docs/architecture/model-gateway.md § Apps and
 * user-pays). Client-safe: Settings reads these.
 */

const GATEWAY_APP_STATUSES = ['active', 'suspended'] as const;
export type GatewayAppStatus = (typeof GATEWAY_APP_STATUSES)[number];

/** What a grant allows and has used this UTC month, in microdollars. */
export type GrantStanding = {
  monthlyCapMicros: number;
  /** Settled charge lines this UTC month for the organization and client. */
  spentMicros: number;
  /** Live holds for the organization and client. */
  heldMicros: number;
  /** Never negative: settle growth can push spend past the cap. */
  remainingMicros: number;
};

/** The standing from a cap and what counts against it. */
export function grantStanding(
  monthlyCapMicros: number,
  spentMicros: number,
  heldMicros: number
): GrantStanding {
  return {
    monthlyCapMicros,
    spentMicros,
    heldMicros,
    remainingMicros: Math.max(0, monthlyCapMicros - spentMicros - heldMicros),
  };
}

/** The most margin an app may add on top of model cost, in basis points (50%). */
export const MAX_APP_MARGIN_BPS = 5000;

/** The most one declared SKU may cost, in microdollars ($100). */
export const MAX_APP_SKU_PRICE_MICROS = 100_000_000;

/** A SKU key: lowercase letters, digits, `_` and `-`, up to 64; safe in a JSON path. */
export const APP_SKU_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const APP_SKU_STATUSES = ['active', 'archived'] as const;
export type GatewayAppSkuStatus = (typeof APP_SKU_STATUSES)[number];

/** A SKU's price per key, in microdollars. */
export type SkuPrices = Record<string, number>;

/** What an app charges a user: its margin and its active SKUs' prices. */
export type AppTerms = { marginBps: number; skuPrices: SkuPrices };

/** An active app's terms as the consent screen and Settings show them. */
export type AppTermsView = {
  appId: string;
  appName: string;
  ownerOrganizationId: string;
  ownerOrganizationName: string;
  marginBps: number;
  skus: { key: string; name: string; priceMicros: number }[];
};

/** The terms a view asks for, as a grant records them; none without an app. */
export function termsOfView(view: AppTermsView | null): AppTerms {
  if (!view) return { marginBps: 0, skuPrices: {} };
  return {
    marginBps: view.marginBps,
    skuPrices: Object.fromEntries(
      view.skus.map((sku) => [sku.key, sku.priceMicros])
    ),
  };
}

/** The margin a charge applies: never above what the user accepted. */
export function appliedMarginBps(
  appMarginBps: number,
  acceptedMarginBps: number
): number {
  return Math.max(0, Math.min(appMarginBps, acceptedMarginBps));
}

/**
 * What approving records: no more than the user was shown and no more than
 * the app asks now, and only SKUs that exist now.
 */
export function boundedTerms(shown: AppTerms, current: AppTerms): AppTerms {
  const skuPrices: SkuPrices = {};
  for (const [key, price] of Object.entries(current.skuPrices)) {
    const seen = shown.skuPrices[key];
    if (seen !== undefined) skuPrices[key] = Math.min(seen, price);
  }
  return {
    marginBps: appliedMarginBps(current.marginBps, shown.marginBps),
    skuPrices,
  };
}

/** True when the app now asks for more than the user accepted. */
export function termsNeedApproval(
  current: AppTerms,
  accepted: AppTerms
): boolean {
  if (current.marginBps > accepted.marginBps) return true;
  return Object.entries(current.skuPrices).some(([key, price]) => {
    const ok = accepted.skuPrices[key];
    return ok === undefined || price > ok;
  });
}

/** Basis points as a percent for people, e.g. 2050 → "20.5%". */
export function formatMarginBps(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}
