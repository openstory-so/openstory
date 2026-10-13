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

interface AppLayoutProps extends React.HTMLAttributes<HTMLElement> {}

export const AppLayout: React.FC<AppLayoutProps> = ({
  className,
  children,
  ...props
}) => {
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
          </SidebarProvider>
        </TooltipProvider>
      </UploadRightsGateProvider>
    </AuthGateProvider>
  );
};
