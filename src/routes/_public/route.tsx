import {
  createFileRoute,
  Link,
  Outlet,
  useRouterState,
} from '@tanstack/react-router';
import { RouteErrorFallback } from '@/ui/error/route-error-fallback';
import { AuthGateProvider } from '@/platform/ui/auth/auth-gate-provider';
import { UploadRightsGateProvider } from '@/cast/ui/upload-rights-gate';
import { rememberLastPage } from '@/platform/ui/auth/last-page';
import { TooltipProvider } from '@/ui/shadcn/tooltip';
import { Button } from '@/ui/shadcn/button';
import { SITE_CONFIG } from '@/ui/marketing/constants';
import { GitHubIcon } from '@/ui/icons/github-icon';

// Signed-out pages: no sidebar, links and Sign in top right (#2372).
export const Route = createFileRoute('/_public')({
  component: PublicLayout,
  errorComponent: RouteErrorFallback,
});

function PublicLayout() {
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  return (
    <AuthGateProvider>
      <UploadRightsGateProvider>
        <TooltipProvider>
          <div className="flex h-svh flex-col bg-background">
            <header className="flex h-16 shrink-0 items-center justify-end px-6">
              <div className="flex items-center gap-2">
                <Button
                  asChild
                  size="lg"
                  variant="ghost"
                  className="hidden sm:inline-flex"
                >
                  <Link to="/docs">Docs</Link>
                </Button>
                <Button
                  asChild
                  size="lg"
                  variant="ghost"
                  className="hidden sm:inline-flex"
                >
                  <Link to="/pricing">Pricing</Link>
                </Button>
                <Button asChild size="lg" variant="outline" className="px-5">
                  <a
                    href={SITE_CONFIG.githubHref}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <GitHubIcon className="size-4" />
                    GitHub
                  </a>
                </Button>
                <Button asChild size="lg" className="px-5">
                  <Link
                    to="/login"
                    onClick={() => rememberLastPage(`/${searchStr}`)}
                  >
                    Sign in
                  </Link>
                </Button>
              </div>
            </header>
            <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
              <Outlet />
            </div>
          </div>
        </TooltipProvider>
      </UploadRightsGateProvider>
    </AuthGateProvider>
  );
}
