import { MarkdownEditor } from '@/components/text-editor/markdown-editor';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

describe('MarkdownEditor empty placeholder', () => {
  it('SSRs the placeholder as a real <p> so LCP does not wait for TipTap', () => {
    const html = renderToStaticMarkup(
      <MarkdownEditor
        value=""
        onValueChange={() => undefined}
        placeholder="A one-liner is enough"
      />
    );
    expect(html).toContain('A one-liner is enough');
    expect(html).toContain('<p');
  });

  it('does not SSR the placeholder over seeded content', () => {
    const html = renderToStaticMarkup(
      <MarkdownEditor
        value="INT. ROOM - NIGHT"
        onValueChange={() => undefined}
        placeholder="A one-liner is enough"
      />
    );
    expect(html).not.toContain('A one-liner is enough');
  });
});

describe('MarkdownEditor scrolling', () => {
  // #1281: a scroll container with overscroll-contain stops Chrome's wheel
  // chaining even when it has nothing to scroll, which froze the panel behind
  // every grow-with-content prompt editor. Only a height-bounded caller may
  // opt the editor into scrolling.
  it('is not a scroll container by default', () => {
    const html = renderToStaticMarkup(
      <MarkdownEditor value="" onValueChange={() => undefined} />
    );
    expect(html).not.toContain('overflow-y-auto');
    expect(html).not.toContain('overscroll-contain');
  });
});
