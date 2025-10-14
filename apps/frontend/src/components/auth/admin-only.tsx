/**
 * Admin-Only Wrapper Component
 * Only renders children if user has admin or owner role
 */

"use client";

import type React from "react";
import { useTeamRole } from "@/hooks/use-team-role";

interface AdminOnlyProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  showLoading?: boolean;
}

/**
 * Wrapper component that only renders children for admin/owner users
 *
 * @example
 * ```tsx
 * <AdminOnly fallback={<p>Admin access required</p>}>
 *   <DeleteButton />
 * </AdminOnly>
 * ```
 */
export function AdminOnly({
  children,
  fallback = null,
  showLoading = false,
}: AdminOnlyProps) {
  const { isAdmin, isLoading } = useTeamRole();

  if (isLoading && showLoading) {
    return <div className="animate-pulse">Loading...</div>;
  }

  if (!isAdmin) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}
