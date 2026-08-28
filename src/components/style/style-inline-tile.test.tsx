import { generateMockStyles } from '@/lib/mocks/data-generators';
import { StyleInlineTile } from '@/components/style/style-inline-tile';
import type { Style } from '@/types/database';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

function makeStyle(over: Partial<Style>): Style {
  const [base] = generateMockStyles(1);
  if (!base) throw new Error('expected a mock style');
  return { ...base, ...over };
}

describe('StyleInlineTile', () => {
  it('SSRs a transformed <img> so the tile is in the first HTML', () => {
    const html = renderToStaticMarkup(
      <StyleInlineTile
        style={makeStyle({
          name: 'Product Ad',
          previewUrl:
            'https://assets.openstory.so/styles/product-ad/thumbnail.webp',
        })}
        selected={false}
        priority
        tabIndex={0}
        onSelect={() => undefined}
        onKeyDown={() => undefined}
      />
    );

    expect(html).toContain('<img');
    expect(html).toContain('/cdn-cgi/image/');
    expect(html).toMatch(/fetchpriority="high"/i);
    expect(html).toContain('width=130');
    expect(html).not.toContain('width=6016');
  });
});
