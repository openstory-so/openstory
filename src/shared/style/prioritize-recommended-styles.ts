import type { StyleRecommendation } from '@/hooks/use-styles';
import type { Style } from '@/types/database';

export const RECOMMENDED_STYLE_SLOT_COUNT = 5;

/** Map recommended style ids to their one-line LLM reasoning (for tooltips). */
export function buildRecommendationReasoningMap(
  recommendations: StyleRecommendation[] | undefined
): Map<string, string> {
  const map = new Map<string, string>();
  for (const rec of recommendations ?? []) {
    if (rec.reasoning) map.set(rec.styleId, rec.reasoning);
  }
  return map;
}

/** Join LLM picks back to full `Style` rows, preserving rank order. */
export function resolveRecommendedStyles(
  styles: Style[],
  recommendations: StyleRecommendation[] | undefined,
  limit = RECOMMENDED_STYLE_SLOT_COUNT
): Style[] {
  if (!recommendations?.length) return [];
  const byId = new Map(styles.map((s) => [s.id, s]));
  return recommendations
    .slice(0, limit)
    .map((r) => byId.get(r.styleId))
    .filter((s): s is Style => s !== undefined);
}

/** Catalogue in its natural order with the recommended picks removed. */
export function catalogueWithoutRecommendations(
  styles: Style[],
  recommendations: StyleRecommendation[] | undefined
): Style[] {
  const recommendedIds = new Set(
    resolveRecommendedStyles(styles, recommendations).map((s) => s.id)
  );
  return styles.filter((s) => !recommendedIds.has(s.id));
}
