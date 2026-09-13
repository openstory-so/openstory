/**
 * Admin read of every used endpoint's rate card (#1605): what is stored,
 * whether its worked examples still reproduce, and when it expires. Plain
 * strings and numbers only — the card's JSONLogic is not a serializable
 * server-fn type, so the view carries the evaluator's verdicts, not the card.
 */
import { createServerFn } from '@tanstack/react-start';
import { systemAdminMiddleware } from '@/platform/middleware.fn';
import { getFalEndpointIds } from '@/models/fal-endpoints';
import { BYTEPLUS_RATE_CARD } from '@/billing/byteplus-pricing';
import { verifyRateCardExamples } from '@/billing/rate-card/evaluate';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';

export type RateCardAdminRow = {
  endpointId: string;
  card: {
    verified: boolean;
    sourceUrl: string;
    sourceHash: string;
    extractedAt: string;
    expiresAt: string | null;
    examples: {
      ok: boolean;
      expectedUsd: number;
      usd: number | null;
      /** The example's request params as JSON. */
      params: string;
      quote: string;
      error: string | null;
    }[];
  } | null;
};

export const listRateCardsFn = createServerFn({ method: 'GET' })
  .middleware([systemAdminMiddleware])
  .handler(async (): Promise<RateCardAdminRow[]> => {
    const pricing = await getEffectiveFalPricing();
    const ids = [...getFalEndpointIds(), ...Object.keys(BYTEPLUS_RATE_CARD)];
    return ids.map((endpointId) => {
      const rateCard = pricing[endpointId]?.rateCard;
      if (!rateCard) return { endpointId, card: null };
      const { card, verified } = rateCard;
      return {
        endpointId,
        card: {
          verified,
          sourceUrl: card.source.url,
          sourceHash: card.source.hash,
          extractedAt: card.source.extractedAt,
          expiresAt: card.source.expiresAt ?? null,
          examples: verifyRateCardExamples(card).map((r) => ({
            ok: r.ok,
            expectedUsd: r.example.usd,
            usd: r.usd ?? null,
            params: JSON.stringify(r.example.params),
            quote: r.example.quote,
            error: r.error ?? null,
          })),
        },
      };
    });
  });
