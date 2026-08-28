import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { isSystemAdminFn } from '@/functions/gift-tokens';
import { useUser } from '@/hooks/use-user';
import { authClient } from '@/lib/auth/client';
import { sessionQueryOptions } from '@/lib/auth/session-query';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  BarChart3,
  ChevronsUpDown,
  LogIn,
  LogOut,
  Settings,
  ShieldAlert,
  Wallet,
} from 'lucide-react';
import { useState } from 'react';

export function UserSidebarFooter() {
  const { data: user, isLoading } = useUser();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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
          <Link to="/login">
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            size="lg"
            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
          >
            <Avatar className="h-8 w-8 rounded-lg">
              <AvatarImage src={user.image || undefined} alt={displayName} />
              <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
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
          className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
        >
          <DropdownMenuLabel className="p-0 font-normal">
            <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
              <Avatar className="h-8 w-8 rounded-lg">
                <AvatarImage src={user.image || undefined} alt={displayName} />
                <AvatarFallback className="rounded-lg">
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
            </div>
          </DropdownMenuLabel>
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

function AdminMenuItem() {
  const { data: adminStatus } = useQuery({
    queryKey: ['system-admin-status'],
    queryFn: () => isSystemAdminFn(),
    staleTime: 5 * 60 * 1000,
  });

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

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first || !last) return '';
  if (parts.length === 1) {
    return first.substring(0, 2).toUpperCase();
  }
  const firstChar = first[0];
  const lastChar = last[0];
  if (!firstChar || !lastChar) return '';
  return (firstChar + lastChar).toUpperCase();
}
