/**
 * Member Role Badge Component
 * Displays a user's role with appropriate styling
 */

"use client";

import { Badge } from "@/components/ui/badge";
import type { TeamRole } from "@/hooks/use-team-role";

interface MemberRoleBadgeProps {
  role: TeamRole;
  className?: string;
}

const roleConfig: Record<
  TeamRole,
  {
    label: string;
    variant: "default" | "secondary" | "destructive" | "outline";
  }
> = {
  owner: {
    label: "Owner",
    variant: "default",
  },
  admin: {
    label: "Admin",
    variant: "secondary",
  },
  member: {
    label: "Member",
    variant: "outline",
  },
  viewer: {
    label: "Viewer",
    variant: "outline",
  },
};

/**
 * Badge component to display user roles
 *
 * @example
 * ```tsx
 * <MemberRoleBadge role="admin" />
 * ```
 */
export function MemberRoleBadge({ role, className }: MemberRoleBadgeProps) {
  const config = roleConfig[role];

  return (
    <Badge variant={config.variant} className={className}>
      {config.label}
    </Badge>
  );
}
