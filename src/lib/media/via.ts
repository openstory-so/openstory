/**
 * Which API a media call actually hits (#1216). Distinct from **lab** — who
 * trained the model (`IMAGE_MODELS.*.provider`, the pricing table's Lab
 * column). Pricing's Via column is this value.
 *
 * Native PRs widen the union. Poll and billing MUST switch on the via stamped
 * at submit: job ids are via-scoped, and re-resolving from live keys can send
 * a fal id to xAI (or the reverse).
 */
export type MediaVia = 'fal';

export function assertMediaVia(via: string): MediaVia {
  switch (via) {
    case 'fal':
      return via;
    default:
      throw new Error(`Unknown media via: ${via}`);
  }
}
