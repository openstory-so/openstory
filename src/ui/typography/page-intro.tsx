import { SignInButton } from '@/platform/ui/auth/sign-in-button';
import { PageContainer } from '@/ui/layout/page-container';
import { PageDescription } from './page-description';
import { PageHeader } from './page-header';
import type { ReactNode } from 'react';

/**
 * Locked chrome for the page one-liner. Same inset and size on every list
 * page (and the signed-in composer). Pass the same `maxWidth` as the content
 * container below so both share a left edge at every viewport width.
 *
 * Logged-out visits get the sequences Sign in button under the subtitle.
 * Sequences itself opts out — its list is replaced by `SignInPrompt`, which
 * already renders that button.
 */
export function PageIntro({
  title,
  children,
  actions,
  maxWidth = 'default',
  signIn = true,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  maxWidth?: 'default' | 'narrow' | 'wide' | 'full';
  signIn?: boolean;
}) {
  return (
    <PageContainer maxWidth={maxWidth} padding="compact" className="shrink-0">
      <h1 className="sr-only">{title}</h1>
      <PageHeader actions={actions} className="items-start">
        <div className="flex flex-col items-start gap-3">
          <PageDescription>{children}</PageDescription>
          {signIn ? <SignInButton /> : null}
        </div>
      </PageHeader>
    </PageContainer>
  );
}
