import { describe, expect, it } from 'vitest';
import { htmlToText } from './web';

describe('htmlToText', () => {
  it('keeps the words, drops scripts and styles, decodes entities', () => {
    const { title, text } = htmlToText(
      '<html><head><title> A &amp; B </title><style>p{}</style></head>' +
        '<body><script>alert(1)</script><h1>Hello</h1><p>one &lt;two&gt;&#39;s &#x41;</p>' +
        '<!-- hidden --><ul><li>x</li><li>y</li></ul></body></html>'
    );
    expect(title).toBe('A & B');
    expect(text).toBe("Hello\none <two>'s A\nx\ny");
  });
});
