import { describe, expect, it } from 'vitest';
import { normalizeScreenplayNewlines } from './markdown-editor';

describe('normalizeScreenplayNewlines', () => {
  it('converts CRLF and CR to LF', () => {
    expect(normalizeScreenplayNewlines('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('converts Unicode line/paragraph separators to LF', () => {
    expect(normalizeScreenplayNewlines('Scene 1\u2028Body\u2029Scene 2')).toBe(
      'Scene 1\nBody\nScene 2'
    );
  });
});
