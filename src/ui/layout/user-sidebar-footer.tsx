import { Avatar, AvatarFallback, AvatarImage } from '@/ui/shadcn/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/ui/shadcn/dropdown-menu';
import { SidebarMenuButton, SidebarMenuItem } from '@/ui/shadcn/sidebar';
import { systemAdminStatusQueryOptions } from '@/billing/ui/system-admin-status';
import { useUser } from '@/platform/ui/use-user';
import { authClient, authData } from '@/platform/ui/auth/client';
import { rememberLastPage } from '@/platform/ui/auth/last-page';
import {
  sessionQueryOptions,
  useAuthSession,
} from '@/platform/ui/auth/session-query';
import { avatarStyle, getInitials } from '@/ui/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  BarChart3,
  Check,
  ChevronsUpDown,
  LogIn,
  LogOut,
  Settings,
  ShieldAlert,
  Wallet,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

export function UserSidebarFooter() {
  const { data: user, isLoading } = useUser();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const resumeHref = useRouterState({
    select: (s) => `${s.location.pathname}${s.location.searchStr}`,
  });

  // Initial session resolve only — not after sign-out (we seed null session
  // so isLoading stays false and "Sign in" shows immediately).
  if (isLoading) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" disabled>
          <div className="h-8 w-8 shrink-0 rounded-full bg-muted animate-pulse" />
          <div className="flex flex-1 flex-col gap-1">
            <div className="h-3 w-24 rounded bg-muted animate-pulse" />
            <div className="h-2.5 w-32 rounded bg-muted animate-pulse" />
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  if (!user) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton asChild tooltip="Sign in">
          <Link
            to="/login"
            onClick={() => {
              rememberLastPage(resumeHref);
            }}
          >
            <LogIn />
            <span>Sign in</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  const userEmail = user.email;
  const displayName = user.name || userEmail || 'User';
  const initials = getInitials(displayName);

  const handleSignOut = async () => {
    setIsSigningOut(true);
    try {
      // Do NOT removeQueries(['session']) first — that puts useUser into
      // isLoading and flashes the skeleton. authClient.signOut clears caches
      // then seeds session=null (see client.ts).
      await authClient.signOut({
        fetchOptions: {
          onSuccess: () => {
            // Only seed anonymous session after a confirmed sign-out. A
            // failed network/API call must not flip the UI to "Sign in"
            // while the cookie is still valid.
            queryClient.setQueryData(sessionQueryOptions.queryKey, null);
            void navigate({ to: '/' });
          },
        },
      });
    } finally {
      setIsSigningOut(false);
    }
  };

  return (
    <SidebarMenuItem>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            size="lg"
            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
          >
            <Avatar>
              <AvatarImage src={user.image || undefined} alt={displayName} />
              <AvatarFallback style={avatarStyle(displayName)}>
                {initials}
              </AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{displayName}</span>
              {userEmail && (
                <span className="truncate text-xs text-muted-foreground">
                  {userEmail}
                </span>
              )}
            </div>
            <ChevronsUpDown className="ml-auto size-4" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="end"
          sideOffset={4}
          className="w-(--radix-dropdown-menu-trigger-width) min-w-64 rounded-lg"
        >
          <OrganizationSwitcher open={menuOpen} />
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link to="/settings">
              <Settings className="mr-2 h-4 w-4" />
              Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/credits" search={{ tab: 'balance' }}>
              <Wallet className="mr-2 h-4 w-4" />
              Credits
            </Link>
          </DropdownMenuItem>
          <AdminMenuItem />
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => void handleSignOut()}
            disabled={isSigningOut}
          >
            <LogOut className="mr-2 h-4 w-4" />
            {isSigningOut ? 'Signing out…' : 'Sign Out'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

function OrganizationAvatar({
  name,
  logo,
}: {
  name: string;
  logo?: string | null;
}) {
  return (
    <Avatar className="rounded-lg after:rounded-lg">
      <AvatarImage className="rounded-lg" src={logo || undefined} alt="" />
      <AvatarFallback className="rounded-lg" style={avatarStyle(name)}>
        {getInitials(name)}
      </AvatarFallback>
    </Avatar>
  );
}

/** The active organization as a row; its submenu lists the others. */
function OrganizationSwitcher({ open }: { open: boolean }) {
  const { data: session } = useAuthSession();
  const activeId = session?.session.activeOrganizationId ?? null;
  const activeName = session?.membership?.organizationName ?? 'No organization';
  const organizations = useQuery({
    queryKey: ['organization', 'list'],
    enabled: open,
    queryFn: () => authData(authClient.organization.list()),
  });

  // Every loader and query on the page is per organization: reload, do not
  // chase them. The auth client's cache clear leaves mounted queries orphaned.
  const switchTo = (organizationId: string) =>
    authData(authClient.organization.setActive({ organizationId })).then(
      () => window.location.reload(),
      (error: Error) =>
        toast.error('Could not switch organization', {
          description: error.message,
        })
    );

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2">
        <OrganizationAvatar name={activeName} />
        <span className="flex-1 truncate">{activeName}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="min-w-56">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Organizations
          </DropdownMenuLabel>
          {organizations.isPending ? (
            <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
          ) : organizations.isError ? (
            <DropdownMenuLabel className="text-xs font-normal text-destructive">
              {organizations.error.message}
            </DropdownMenuLabel>
          ) : (
            organizations.data.map((organization) => (
              <DropdownMenuItem
                key={organization.id}
                className="gap-2"
                onSelect={() => {
                  if (organization.id !== activeId)
                    void switchTo(organization.id);
                }}
              >
                <OrganizationAvatar
                  name={organization.name}
                  logo={organization.logo}
                />
                <span className="flex-1 truncate">{organization.name}</span>
                {organization.id === activeId ? (
                  <Check className="size-4" aria-label="Current" />
                ) : null}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

function AdminMenuItem() {
  const { data: adminStatus } = useQuery(systemAdminStatusQueryOptions);

  if (!adminStatus?.isAdmin) return null;

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
        Admin
      </DropdownMenuLabel>
      <DropdownMenuItem asChild>
        <Link to="/admin/usage">
          <BarChart3 className="mr-2 h-4 w-4" />
          Usage
        </Link>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <Link to="/admin/moderation">
          <ShieldAlert className="mr-2 h-4 w-4" />
          Moderation
        </Link>
      </DropdownMenuItem>
    </>
  );
}
