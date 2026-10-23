import { cn } from '@/ui/utils';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/ui/shadcn/sidebar';
import { Separator } from '@/ui/shadcn/separator';
import { TooltipProvider } from '@/ui/shadcn/tooltip';
import type * as React from 'react';
import { AuthGateProvider } from '@/platform/ui/auth/auth-gate-provider';
import { UploadRightsGateProvider } from '@/cast/ui/upload-rights-gate';
import { AddCreditsDialog } from '@/billing/ui/add-credits-dialog';
import { GlobalBillingGateDialog } from '@/billing/ui/billing-gate-dialog';
import { AppSidebar } from './app-sidebar';
import { AutoTopUpFailedBanner } from './auto-top-up-failed-banner';
import { Breadcrumbs } from './breadcrumbs';
import { SEQUENCE_HEADER_SLOT_ID } from '@/sequences/ui/sequence-header-slot';
import { ComplianceRestrictionBanner } from './compliance-restriction-banner';
import { InvalidApiKeyBanner } from './invalid-api-key-banner';
import { AssistantPanel } from '@/assistant/ui/assistant-panel';
import { AssistantToggle } from '@/assistant/ui/assistant-toggle';
import { usePageContext } from '@/assistant/ui/use-page-context';
import { useAssistantState } from '@/assistant/ui/assistant-store';

interface AppLayoutProps extends React.HTMLAttributes<HTMLElement> {}

/** Starters for an empty assistant thread; the page decides them (#2155). */
function suggestionsFor(kinds: ReadonlySet<string>): string[] {
  if (kinds.has('studio_asset')) {
    return [
      'Make a variation of this with a wider shot',
      'Use this as a reference for a new clip',
      'What prompt made this?',
    ];
  }
  if (kinds.has('shot')) {
    return [
      'What is still missing before this shot can render?',
      'Make this shot darker and more handheld',
      'Why is this shot stale?',
    ];
  }
  if (kinds.has('sequence')) {
    return [
      'What does this sequence still owe before it can export?',
      'Summarise the script in three lines',
      'Which shots have no clip yet?',
    ];
  }
  if (kinds.has('character')) {
    return [
      'Give this character a second look in different clothes',
      'Which sequences cast this character?',
      'Describe this character’s voice',
    ];
  }
  if (kinds.has('location')) {
    return [
      'Which sequences use this location?',
      'Redraw this location’s sheet at night',
      'Describe this location in one line',
    ];
  }
  return [
    'What did I work on most recently?',
    'Start a new sequence from a script I paste',
    'Show my characters',
  ];
}

export const AppLayout: React.FC<AppLayoutProps> = ({
  className,
  children,
  ...props
}) => {
  const pageContext = usePageContext();
  // Starters follow everything the composer shows: the route, what a page
  // registered (the Studio viewer), and what a button handed over.
  const { extraContext, draft } = useAssistantState();
  const suggestions = suggestionsFor(
    new Set(
      [...pageContext, ...extraContext.values(), ...(draft?.context ?? [])].map(
        (item) => item.kind
      )
    )
  );
  return (
    <AuthGateProvider>
      <UploadRightsGateProvider>
        <TooltipProvider>
          <SidebarProvider className="h-svh">
            <AppSidebar />
            <AddCreditsDialog />
            <GlobalBillingGateDialog />
            <SidebarInset className="min-w-0 min-h-0">
              <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
                <SidebarTrigger className="-ml-1" />
                <Separator
                  orientation="vertical"
                  className="mr-2 data-vertical:h-4 data-vertical:self-auto"
                />
                <div className="min-w-0 flex-1">
                  <Breadcrumbs />
                </div>
                {/* Sequence generation progress portals in here (#1427,
                    #2102). `@container` so the chip sizes its label against
                    the room it has, which needs the slot to be `flex-1`;
                    `empty:hidden` so an idle slot takes nothing from the
                    breadcrumb. */}
                <div
                  id={SEQUENCE_HEADER_SLOT_ID}
                  className="@container flex min-w-0 flex-1 items-center justify-end empty:hidden"
                />
                <AssistantToggle />
              </header>
              <ComplianceRestrictionBanner />
              <InvalidApiKeyBanner />
              <AutoTopUpFailedBanner />
              <div
                className={cn(
                  'flex flex-col flex-1 min-w-0 min-h-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]',
                  className
                )}
                {...props}
              >
                {children}
              </div>
            </SidebarInset>
            {/* Mounted once here so the conversation survives navigation;
                the chips follow the route (#2155). */}
            <AssistantPanel
              pageContext={pageContext}
              suggestions={suggestions}
            />
          </SidebarProvider>
        </TooltipProvider>
      </UploadRightsGateProvider>
    </AuthGateProvider>
  );
};
