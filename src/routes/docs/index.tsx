import { createFileRoute, redirect } from '@tanstack/react-router';
import { allDocs } from 'content-collections';
import { SECTION_ORDER } from '@/components/docs/sections';

const sectionIndex = new Map<string, number>(
  SECTION_ORDER.map((section, i) => [section, i])
);

function getSectionOrder(section: string): number {
  return sectionIndex.get(section) ?? SECTION_ORDER.length;
}

function getFirstDoc() {
  const sorted = [...allDocs].sort((a, b) => {
    const orderA = getSectionOrder(a.section);
    const orderB = getSectionOrder(b.section);

    if (orderA !== orderB) return orderA - orderB;
    return a.order - b.order;
  });

  return sorted[0];
}

export const Route = createFileRoute('/docs/')({
  beforeLoad: () => {
    const firstDoc = getFirstDoc();
    if (firstDoc) {
      throw redirect({ to: '/docs/$', params: { _splat: firstDoc.slug } });
    }
  },
});
