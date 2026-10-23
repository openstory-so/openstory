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
      'How can I make this image more striking?',
      'Give me three variations that push the mood further',
      'Turn this into a short clip. What should move?',
    ];
  }
  if (kinds.has('shot')) {
    return [
      'How can I make this shot more interesting?',
      'Give me three alternative framings for this shot',
      'What would a cinematographer change here?',
    ];
  }
  if (kinds.has('scene')) {
    return [
      'How can I make this scene land harder?',
      'Where does this scene drag, and what should I cut?',
      'Suggest a stronger opening and closing shot for this scene',
    ];
  }
  if (kinds.has('draft_script')) {
    return [
      'How can I make this script more visual?',
      'Tighten the dialogue without losing the beats',
      'What is missing from this story?',
    ];
  }
  if (kinds.has('sequence')) {
    return [
      'How can I make this sequence better?',
      'What is the weakest moment in this cut?',
      'What would make the first five seconds hook harder?',
    ];
  }
  if (kinds.has('character')) {
    return [
      'How can I make this character more distinctive?',
      'Suggest a look that says more about who they are',
      'What voice would suit them?',
    ];
  }
  if (kinds.has('location')) {
    return [
      'How can I make this location feel more alive?',
      'What time of day and weather would serve the story best?',
      'Which sequences use this location?',
    ];
  }
  return [
    'Help me write a 30-second script',
    'Review my latest sequence and name the one change with the biggest payoff',
    'Make a reference still for a character I describe',
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
