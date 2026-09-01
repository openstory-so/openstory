import { cn } from '@/lib/utils';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { TooltipProvider } from '@/components/ui/tooltip';
import type * as React from 'react';
import { AuthGateProvider } from '@/components/auth/auth-gate-provider';
import { AddCreditsDialog } from '@/components/billing/add-credits-dialog';
import { GlobalBillingGateDialog } from '@/components/billing/billing-gate-dialog';
import { WelcomeCreditsProvider } from '@/components/billing/welcome-credits-dialog';
import { AppSidebar } from './app-sidebar';
import { Breadcrumbs } from './breadcrumbs';
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
      <WelcomeCreditsProvider>
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
              </header>
              <ComplianceRestrictionBanner />
              <InvalidApiKeyBanner />
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
      </WelcomeCreditsProvider>
    </AuthGateProvider>
  );
};
