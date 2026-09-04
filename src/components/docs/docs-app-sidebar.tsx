import { DocsSidebar } from '@/components/docs/docs-sidebar';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from '@/components/ui/sidebar';
import { UserSidebarFooter } from '@/components/layout/user-sidebar-footer';
import { getDocsReturnUrl } from '@/shared/docs/docs-referrer';
import { useRouter } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';

export function DocsAppSidebar() {
  const router = useRouter();

  const handleBack = () => {
    const returnUrl = getDocsReturnUrl();
    void router.navigate({ href: returnUrl ?? '/' });
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={handleBack} tooltip="Back">
              <ArrowLeft />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarSeparator />
      <SidebarContent>
        <DocsSidebar />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <UserSidebarFooter />
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
