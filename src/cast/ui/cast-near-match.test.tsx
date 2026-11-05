import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CastMergeOffer, suggestCastMerge } from './cast-near-match';

describe('suggestCastMerge', () => {
  it('names the one member a letter away, and a unique first name', () => {
    expect(
      suggestCastMerge('Marloe', [{ id: 'a', name: 'Marlow' }])?.name
    ).toBe('Marlow');
    expect(
      suggestCastMerge('Priya', [{ id: 'b', name: 'Priya Nair' }])?.id
    ).toBe('b');
    expect(
      suggestCastMerge('Marloe', [
        { id: 'a', name: 'Marlow' },
        { id: 'c', name: 'Marlowe' },
      ])
    ).toBeNull();
  });
});

describe('CastMergeOffer', () => {
  it('asks before merging and names the character that stays', () => {
    const html = renderToStaticMarkup(
      createElement(CastMergeOffer, {
        fromName: 'Marloe',
        intoName: 'Marlow',
        keepsLoserSheet: true,
        pending: false,
        onMerge: () => undefined,
      })
    );
    expect(html).toContain('Did you mean Marlow?');
    expect(html).toContain('Merge into Marlow');
  });
});
