import { describe, expect, it } from 'vitest';
import { highlightDocsCode } from './markdown';

describe('highlightDocsCode', () => {
  it('emits token classes for TypeScript', () => {
    const html = highlightDocsCode('const answer: number = 42', 'ts');
    expect(html).toContain('th-keyword');
    expect(html).toContain('th-type');
    expect(html).not.toContain('<script');
  });

  it('accepts the typescript alias used in the corpus', () => {
    const html = highlightDocsCode('export const ok = true', 'typescript');
    expect(html).toContain('th-keyword');
  });

  it('accepts the bash alias used in the corpus', () => {
    const html = highlightDocsCode('bun install', 'bash');
    expect(html).toContain('bun');
  });

  it('escapes unknown languages as plaintext', () => {
    const html = highlightDocsCode('<script>alert("x")</script>', 'not-a-lang');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
