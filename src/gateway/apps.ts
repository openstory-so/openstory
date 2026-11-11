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
