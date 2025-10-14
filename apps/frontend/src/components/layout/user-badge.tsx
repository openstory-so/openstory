/**
 * User Badge Component
 * Displays user authentication state with login/logout actions
 */

"use client";

import { LogIn, LogOut, User, UserPlus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuthNavigation } from "@/hooks/use-auth-navigation";
import { useUser } from "@/hooks/use-user";
import { authClient, useSession } from "@/lib/auth/client";

export function UserBadge() {
  const { data: userData, isLoading } = useUser();
  const { data: session } = useSession();
  const { loginUrl, signupUrl } = useAuthNavigation();
  const [isSigningOut, setIsSigningOut] = useState(false);

  // Show loading state
  if (isLoading) {
    return (
      <div className="flex items-center gap-2">
        <div className="h-8 w-8 rounded-full bg-muted animate-pulse" />
      </div>
    );
  }

  // Anonymous user - show login/signup buttons
  if (!userData || userData.isAnonymous) {
    return (
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link href={loginUrl}>
            <LogIn className="h-4 w-4 mr-2" />
            Sign In
          </Link>
        </Button>
        <Button size="sm" asChild>
          <Link href={signupUrl}>
            <UserPlus className="h-4 w-4 mr-2" />
            Sign Up
          </Link>
        </Button>
      </div>
    );
  }

  // Authenticated user - show user menu
  const user = userData.user;
  const userEmail = session?.user?.email;
  const displayName = user.full_name || userEmail || "User";
  const initials = getInitials(displayName);

  const handleSignOut = async () => {
    setIsSigningOut(true);
    try {
      await authClient.signOut();
      // Refresh the page to clear state
      window.location.href = "/sequences";
    } catch (error) {
      console.error("Sign out error:", error);
      setIsSigningOut(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="relative h-10 w-10 rounded-full">
          <Avatar className="h-10 w-10">
            <AvatarImage src={user.avatar_url || undefined} alt={displayName} />
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" align="end">
        <DropdownMenuLabel>
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium leading-none">{displayName}</p>
            {userEmail && (
              <p className="text-xs leading-none text-muted-foreground">
                {userEmail}
              </p>
            )}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/sequences">
            <User className="mr-2 h-4 w-4" />
            My Sequences
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleSignOut} disabled={isSigningOut}>
          <LogOut className="mr-2 h-4 w-4" />
          {isSigningOut ? "Signing out..." : "Sign Out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Get user initials from display name
 */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);

  if (parts.length === 1) {
    // Single name - use first 2 characters
    return parts[0].substring(0, 2).toUpperCase();
  }

  // Multiple names - use first letter of first and last name
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
