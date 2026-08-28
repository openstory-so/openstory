/**
 * Which API a media call actually hits (#1216). Distinct from **lab** — who
 * trained the model (`IMAGE_MODELS.*.vendor`, the pricing table's Vendor
 * column). Pricing's Via column is this value. LLM keys use the same word
 * (`ResolvedLlmKey.via`: openrouter | fal | xai).
 *
 * Native PRs widen the union. Poll and billing MUST switch on the via stamped
 * at submit: job ids are via-scoped, and re-resolving from live keys can send
 * a fal id to xAI (or the reverse).
 */
export type MediaVia = 'fal' | 'xai';

export function assertMediaVia(via: string): MediaVia {
  switch (via) {
    case 'fal':
    case 'xai':
      return via;
    default:
      throw new Error(`Unknown media via: ${via}`);
  }
}
