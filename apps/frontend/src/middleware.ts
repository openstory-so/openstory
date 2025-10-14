/**
 * Next.js middleware for BetterAuth route protection
 * Lightweight middleware for Velro's anonymous-first approach
 */

import { betterFetch } from "@better-fetch/fetch";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { Session } from "@/lib/auth/config";

// Routes that require full authentication (not anonymous)
const authRequiredRoutes = ["/settings", "/billing"];

// Routes that authenticated users should skip
const authOnlyRoutes = ["/login", "/signup"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip middleware for static files, API routes, and Next.js internals
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api") ||
    pathname.startsWith("/favicon") ||
    pathname.includes(".") ||
    pathname.startsWith("/public")
  ) {
    return NextResponse.next();
  }

  // Check for BetterAuth session using the proper API
  const { data: session, error } = await betterFetch<Session>(
    "/api/auth/get-session",
    {
      baseURL: request.nextUrl.origin,
      headers: {
        cookie: request.headers.get("cookie") || "",
      },
    },
  );

  // SECURITY: Fail closed if auth service is unavailable
  // Prevents authentication bypass during service degradation
  if (error) {
    console.error("[Middleware] Auth service error:", error);

    // Check if this is a protected route
    const isAuthRequired = authRequiredRoutes.some((route) =>
      pathname.startsWith(route),
    );

    if (isAuthRequired) {
      // Deny access to protected routes when auth service is down
      return NextResponse.json(
        {
          error: "Authentication service unavailable",
          message: "Unable to verify authentication. Please try again.",
        },
        { status: 503 },
      );
    }

    // Allow public routes to continue even if auth service is down
    // This maintains availability for anonymous users
    return NextResponse.next();
  }

  const hasSession = !!session;
  const isAnonymous = session?.user?.isAnonymous ?? true;

  // For Velro's anonymous-first approach:
  // - Allow access to most routes without authentication
  // - Only protect truly sensitive routes (settings, billing)
  // - Let components handle showing upgrade prompts for anonymous users

  // Redirect authenticated (non-anonymous) users away from auth pages
  const isAuthOnlyRoute = authOnlyRoutes.some((route) =>
    pathname.startsWith(route),
  );
  if (hasSession && !isAnonymous && isAuthOnlyRoute) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  // Protect sensitive routes that require full authentication (not anonymous)
  const isAuthRequired = authRequiredRoutes.some((route) =>
    pathname.startsWith(route),
  );
  if (isAuthRequired && (!hasSession || isAnonymous)) {
    // Preserve the original URL for redirect after login
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirectTo", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Allow all other routes - anonymous users can create sequences
  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api/auth (BetterAuth API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files with extensions
     */
    "/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\..*).*)",
  ],
};
