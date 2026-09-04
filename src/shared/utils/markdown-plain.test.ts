import { describe, expect, it } from 'vitest';
import { plainSceneTitle, stripMarkdown } from './markdown-plain';

describe('stripMarkdown', () => {
  it('drops emphasis, headings, and links, keeping the visible text', () => {
    expect(stripMarkdown('**Office**')).toBe('Office');
    expect(stripMarkdown('_Kitchen_ at *dawn*')).toBe('Kitchen at dawn');
    expect(stripMarkdown('## The Reveal')).toBe('The Reveal');
    expect(stripMarkdown('[cut](https://example.com)')).toBe('cut');
  });

  it('leaves plain text and screenplay sluglines alone', () => {
    expect(stripMarkdown('INT. OFFICE - DAY')).toBe('INT. OFFICE - DAY');
    expect(stripMarkdown("GIRLS' ROOM")).toBe("GIRLS' ROOM");
  });
});

describe('plainSceneTitle', () => {
  it('strips markdown and treats nullish as empty', () => {
    expect(plainSceneTitle('**The Reveal**')).toBe('The Reveal');
    expect(plainSceneTitle('## INT. OFFICE')).toBe('INT. OFFICE');
    expect(plainSceneTitle(null)).toBe('');
    expect(plainSceneTitle(undefined)).toBe('');
    expect(plainSceneTitle('  ')).toBe('');
  });
});
