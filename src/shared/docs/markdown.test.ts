import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';
import { highlightDocsCode } from './highlight';
import {
  isInternalDocsHref,
  parseDocsMarkdown,
  type MarkdownDocument,
} from './markdown';

const publishedRoots = [
  'getting-started.md',
  'user-guide',
  'developer-guide',
  'deployment',
  'support',
];

function walkPublishedDocs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walkPublishedDocs(path);
    return entry.name.endsWith('.md') ? [path] : [];
  });
}

function publishedDocFiles(): string[] {
  const docsRoot = join(process.cwd(), 'docs');
  return publishedRoots.flatMap((root) => {
    const path = join(docsRoot, root);
    if (root.endsWith('.md')) return [path];
    return walkPublishedDocs(path);
  });
}

function collectFenceLangs(source: string): string[] {
  const langs: string[] = [];
  const fence = /^```([a-zA-Z0-9+-]*)[^\n]*$/gm;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(source)) !== null) {
    langs.push(match[1] ?? '');
  }
  return langs;
}

function collectMermaidComponents(document: MarkdownDocument): number {
  let count = 0;
  const walk = (blocks: MarkdownDocument['children']) => {
    for (const block of blocks) {
      if (block.type === 'component' && block.tagName === 'mermaid-diagram') {
        count += 1;
      }
      if (block.type === 'list') {
        for (const item of block.items) walk(item.children);
      }
      if (block.type === 'blockquote' || block.type === 'callout') {
        walk(block.children);
      }
      if (block.type === 'component') walk(block.children);
    }
  };
  walk(document.children);
  return count;
}

describe('isInternalDocsHref', () => {
  it('treats root-relative paths as internal', () => {
    expect(isInternalDocsHref('/docs/user-guide/scenes')).toBe(true);
  });

  it('treats hashes and absolute URLs as external', () => {
    expect(isInternalDocsHref('#quick-start')).toBe(false);
    expect(isInternalDocsHref('https://fal.ai')).toBe(false);
  });
});

describe('parseDocsMarkdown', () => {
  it('collects heading ids and text for TOC parity', () => {
    const { headings } = parseDocsMarkdown(`# Title

## Install

### bun
`);
    expect(headings).toEqual([
      { id: 'title', text: 'Title', level: 1 },
      { id: 'install', text: 'Install', level: 2 },
      { id: 'bun', text: 'bun', level: 3 },
    ]);
  });

  it('makes duplicate heading ids unique', () => {
    const { headings } = parseDocsMarkdown(`## Setup

## Setup
`);
    expect(headings.map((heading) => heading.id)).toEqual(['setup', 'setup-1']);
  });

  it('matches github-slugger / rehype-slug for punctuation headings', () => {
    const { headings } = parseDocsMarkdown(`## Build & Deploy

## wrangler.jsonc
`);
    expect(headings.map((heading) => heading.id)).toEqual([
      'build--deploy',
      'wranglerjsonc',
    ]);
  });

  it('rewrites mermaid fences to mermaid-diagram components', () => {
    const source = `Intro

\`\`\`mermaid
flowchart TD
    A --> B
\`\`\`

Outro
`;
    const { document } = parseDocsMarkdown(source);
    expect(collectMermaidComponents(document)).toBe(1);
    const mermaid = document.children.find(
      (node) => node.type === 'component' && node.tagName === 'mermaid-diagram'
    );
    expect(mermaid?.type).toBe('component');
    if (mermaid?.type !== 'component') return;
    expect(mermaid.properties?.source).toContain('flowchart TD');
    expect(
      document.children.some(
        (node) => node.type === 'code' && node.lang === 'mermaid'
      )
    ).toBe(false);
  });

  it('parses GFM tables used in the user guide', () => {
    const { document } = parseDocsMarkdown(`| Preset | Duration |
| ------ | -------- |
| 15s    | 15 seconds |
`);
    const table = document.children.find((node) => node.type === 'table');
    expect(table?.type).toBe('table');
    if (table?.type !== 'table') return;
    expect(table.header).toHaveLength(2);
    expect(table.rows).toHaveLength(1);
  });

  it('parses every published docs page without silent content loss', () => {
    const files = publishedDocFiles();
    expect(files.length).toBeGreaterThan(5);

    const allowedFenceLangs = new Set([
      '',
      'bash',
      'typescript',
      'json',
      'mermaid',
    ]);

    for (const file of files) {
      const raw = readFileSync(file, 'utf8');
      const { content } = matter(raw);
      const { document, headings } = parseDocsMarkdown(content);

      expect(document.children.length, file).toBeGreaterThan(0);

      for (const heading of headings) {
        expect(heading.id, `${file} heading "${heading.text}"`).toBeTruthy();
        expect(heading.text, file).toBeTruthy();
      }

      const fenceLangs = collectFenceLangs(content);
      for (const lang of fenceLangs) {
        expect(allowedFenceLangs.has(lang), `${file} fence lang ${lang}`).toBe(
          true
        );
      }

      const mermaidFences = fenceLangs.filter((lang) => lang === 'mermaid');
      expect(collectMermaidComponents(document), file).toBe(
        mermaidFences.length
      );

      const headingIds = new Set(headings.map((heading) => heading.id));
      for (const match of content.matchAll(/\]\(#([^)]+)\)/g)) {
        const target = match[1];
        if (target === undefined) continue;
        expect(headingIds.has(target), `${file} hash link #${target}`).toBe(
          true
        );
      }
    }
  });
});

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
