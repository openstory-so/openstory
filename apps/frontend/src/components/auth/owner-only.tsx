/**
 * Owner-Only Wrapper Component
 * Only renders children if user has owner role
 */

"use client";

import type React from "react";
import { useTeamRole } from "@/hooks/use-team-role";

interface OwnerOnlyProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  showLoading?: boolean;
}

/**
 * Wrapper component that only renders children for owner users
 *
 * @example
 * ```tsx
 * <OwnerOnly fallback={<p>Owner access required</p>}>
 *   <TransferOwnershipButton />
 * </OwnerOnly>
 * ```
 */
export function OwnerOnly({
  children,
  fallback = null,
  showLoading = false,
}: OwnerOnlyProps) {
  const { isOwner, isLoading } = useTeamRole();

  if (isLoading && showLoading) {
    return <div className="animate-pulse">Loading...</div>;
  }

  if (!isOwner) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}
