/**
 * The lines of a gateway charge (docs/architecture/model-gateway.md § Money).
 * Pure and client-safe: the hold at submit and the settle use the same function.
 */

import type { ChargeLineKind } from '@/billing/charge-lines';
import { type Microdollars, micros } from '@/billing/money';

/** The gateway's own fee on provider cost, in basis points. Off for now. */
export const GATEWAY_PLATFORM_FEE_BPS = 0;

const BPS_DENOMINATOR = 10_000;

type GatewayChargeLine = {
  kind: ChargeLineKind;
  amountMicros: Microdollars;
  /** Null is the platform. */
  payeeOrganizationId: string | null;
};

export type GatewayCharge = {
  totalMicros: Microdollars;
  /** Positive lines only; they sum to `totalMicros`. */
  lines: GatewayChargeLine[];
};

function assertBps(name: string, bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > BPS_DENOMINATOR) {
    throw new Error(`${name} must be an integer from 0 to ${BPS_DENOMINATOR}`);
  }
}

/** `bps` of `amount`, rounded half up to a whole microdollar. */
function basisPointsOf(amount: Microdollars, bps: number): Microdollars {
  return micros(
    Math.floor((amount * bps + BPS_DENOMINATOR / 2) / BPS_DENOMINATOR)
  );
}

/**
 * A charge on `providerCostMicros`: the provider line, the platform fee and,
 * from PR 4, an app's margin to its organization. Each line is rounded on its
 * own and the total is their sum, so the lines always add up exactly.
 */
export function gatewayCharge(params: {
  providerCostMicros: Microdollars;
  platformFeeBps: number;
  appMargin?: { bps: number; payeeOrganizationId: string };
}): GatewayCharge {
  const cost = params.providerCostMicros;
  if (!Number.isSafeInteger(cost) || cost < 0) {
    throw new Error('Provider cost must be a non-negative integer');
  }
  assertBps('platformFeeBps', params.platformFeeBps);
  if (params.appMargin) assertBps('appMargin.bps', params.appMargin.bps);

  const candidates: GatewayChargeLine[] = [
    { kind: 'provider_cost', amountMicros: cost, payeeOrganizationId: null },
    {
      kind: 'platform_fee',
      amountMicros: basisPointsOf(cost, params.platformFeeBps),
      payeeOrganizationId: null,
    },
    ...(params.appMargin
      ? [
          {
            kind: 'app_margin' as const,
            amountMicros: basisPointsOf(cost, params.appMargin.bps),
            payeeOrganizationId: params.appMargin.payeeOrganizationId,
          },
        ]
      : []),
  ];
  const lines = candidates.filter((line) => line.amountMicros > 0);
  return {
    totalMicros: micros(
      lines.reduce((sum, line) => sum + line.amountMicros, 0)
    ),
    lines,
  };
}
