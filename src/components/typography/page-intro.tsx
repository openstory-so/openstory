import { PageContainer } from '@/components/layout/page-container';
import { PageDescription } from '@/components/typography/page-description';
import { PageHeader } from '@/components/typography/page-header';
import type { ReactNode } from 'react';

/**
 * Locked chrome for the page one-liner. Same inset and size on every list
 * page (and the signed-in composer). Pass the same `maxWidth` as the content
 * container below so both share a left edge at every viewport width.
 */
export function PageIntro({
  title,
  children,
  actions,
  maxWidth = 'default',
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  maxWidth?: 'default' | 'narrow' | 'wide' | 'full';
}) {
  return (
    <PageContainer maxWidth={maxWidth} padding="compact" className="shrink-0">
      <h1 className="sr-only">{title}</h1>
      <PageHeader actions={actions} className="items-start">
        <PageDescription>{children}</PageDescription>
      </PageHeader>
    </PageContainer>
  );
}
