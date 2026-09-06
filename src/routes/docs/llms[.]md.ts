import { createFileRoute } from '@tanstack/react-router';
import { allDocs } from 'content-collections';
import { SECTION_ORDER } from '@/components/docs/sections';

const sectionIndex = new Map<string, number>(
  SECTION_ORDER.map((section, i) => [section, i])
);

function getSectionOrder(section: string): number {
  return sectionIndex.get(section) ?? SECTION_ORDER.length;
}

function buildDocsMarkdown(): string {
  const sorted = [...allDocs].sort((a, b) => {
    const orderA = getSectionOrder(a.section);
    const orderB = getSectionOrder(b.section);
    if (orderA !== orderB) return orderA - orderB;
    return a.order - b.order;
  });

  const lines: string[] = [];
  lines.push('# OpenStory Documentation');
  lines.push('');

  let currentSection = '';

  for (const doc of sorted) {
    if (doc.section !== currentSection) {
      currentSection = doc.section;
      lines.push(`## ${currentSection}`);
      lines.push('');
    }

    lines.push(`### ${doc.title}`);
    lines.push('');
    lines.push(doc.body);
    lines.push('');
  }

  return lines.join('\n');
}

export const Route = createFileRoute('/docs/llms.md')({
  server: {
    handlers: {
      GET: async () => {
        return new Response(buildDocsMarkdown(), {
          status: 200,
          headers: {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Cache-Control': 'public, max-age=86400',
          },
        });
      },
    },
  },
});
