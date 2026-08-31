import { DocsAppSidebar } from '@/components/docs/docs-app-sidebar';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/docs')({
  component: DocsLayout,
});

function DocsLayout() {
  return (
    <TooltipProvider>
      <SidebarProvider className="h-svh">
        <DocsAppSidebar />
        <SidebarInset className="min-w-0 min-h-0">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 md:hidden">
            <SidebarTrigger />
          </header>
          <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
            <main className="mx-auto w-full max-w-3xl px-6 py-10">
              <Outlet />
            </main>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
