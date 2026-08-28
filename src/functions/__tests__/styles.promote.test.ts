/**
 * Guards on promoting an automatic style into the library (#1213). The
 * server-fn middleware chain is covered by e2e; this pins the decision.
 */
import { describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { placeholderAutoStyleDraft } from '@/lib/style/auto-style';
import { assertPromotableAutoStyle } from '@/functions/styles';

const derived = placeholderAutoStyleDraft().config;

describe('assertPromotableAutoStyle', () => {
  it('passes for a derived style the sequence still points at', () => {
    expect(() =>
      assertPromotableAutoStyle(
        { styleId: 'style_auto', styleConfig: derived },
        { id: 'style_auto' }
      )
    ).not.toThrow();
  });

  it('is not found when the sequence has no bound row', () => {
    expect(() =>
      assertPromotableAutoStyle(
        { styleId: 'style_lib', styleConfig: derived },
        null
      )
    ).toThrow(NotFoundError);
  });

  it('is not found when the sequence was re-styled after deriving', () => {
    expect(() =>
      assertPromotableAutoStyle(
        { styleId: 'style_lib', styleConfig: derived },
        { id: 'style_auto' }
      )
    ).toThrow(NotFoundError);
  });

  it('rejects while the recipe is still being derived', () => {
    expect(() =>
      assertPromotableAutoStyle(
        { styleId: 'style_auto', styleConfig: null },
        { id: 'style_auto' }
      )
    ).toThrow(ValidationError);
  });
});
