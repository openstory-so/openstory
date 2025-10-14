/**
 * Auth Navigation Hook
 * React hook for navigating to auth pages with redirect preservation
 */

"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";
import { getLoginUrl, getSignupUrl } from "@/lib/auth/navigation";

/**
 * Hook for auth navigation with redirect preservation
 * Automatically uses current pathname for redirect
 */
export function useAuthNavigation() {
  const router = useRouter();
  const pathname = usePathname();

  /**
   * Navigate to login page, preserving current path for redirect
   * @param customPath - Optional custom path to redirect to (overrides current pathname)
   */
  const goToLogin = useCallback(
    (customPath?: string) => {
      const loginUrl = getLoginUrl(customPath || pathname);
      router.push(loginUrl);
    },
    [router, pathname],
  );

  /**
   * Navigate to signup page, preserving current path for redirect
   * @param customPath - Optional custom path to redirect to (overrides current pathname)
   */
  const goToSignup = useCallback(
    (customPath?: string) => {
      const signupUrl = getSignupUrl(customPath || pathname);
      router.push(signupUrl);
    },
    [router, pathname],
  );

  /**
   * Get the login URL with redirect preservation (without navigating)
   * Useful for Link components
   */
  const loginUrl = getLoginUrl(pathname);

  /**
   * Get the signup URL with redirect preservation (without navigating)
   * Useful for Link components
   */
  const signupUrl = getSignupUrl(pathname);

  return {
    goToLogin,
    goToSignup,
    loginUrl,
    signupUrl,
  };
}
