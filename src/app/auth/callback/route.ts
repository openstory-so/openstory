import { type NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth/service";
import { createSessionAwareClient } from "@/lib/supabase/server";

/**
 * Handle magic link callback
 * GET /auth/callback
 */
export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const _anonymousId = requestUrl.searchParams.get("anonymousId");
  const redirectTo = requestUrl.searchParams.get("redirectTo") || "/dashboard";

  if (code) {
    try {
      const supabase = await createSessionAwareClient();

      // Exchange code for session
      const { data: sessionData, error: sessionError } =
        await supabase.auth.exchangeCodeForSession(code);

      if (sessionError) {
        console.error("Session exchange error:", sessionError);
        return NextResponse.redirect(
          new URL(
            `/login?error=${encodeURIComponent("Authentication failed")}`,
            request.url,
          ),
        );
      }

      const session = sessionData.session;
      const user = session?.user;

      if (!user) {
        return NextResponse.redirect(
          new URL(
            `/login?error=${encodeURIComponent("No user found")}`,
            request.url,
          ),
        );
      }

      const authService = new AuthService();

      // For anonymous upgrade, we now use the native Supabase approach
      // The linkIdentity mechanism handles this automatically during OTP verification

      // Update user profile metadata if needed
      const profileUpdate = {
        full_name:
          user.user_metadata?.full_name || user.email?.split("@")[0] || null,
        avatar_url: user.user_metadata?.avatar_url || null,
        onboarding_completed: user.user_metadata?.onboarding_completed || false,
      };

      await authService.updateUserProfile(profileUpdate);

      // Redirect to the intended destination
      const redirectUrl = new URL(redirectTo, request.url);

      // Add success parameter
      redirectUrl.searchParams.set("auth", "success");

      return NextResponse.redirect(redirectUrl);
    } catch (error) {
      console.error("Auth callback error:", error);
      return NextResponse.redirect(
        new URL(
          `/login?error=${encodeURIComponent("Authentication failed. Please try again.")}`,
          request.url,
        ),
      );
    }
  }

  // No code provided, redirect to login
  return NextResponse.redirect(
    new URL(
      `/login?error=${encodeURIComponent("Invalid authentication request")}`,
      request.url,
    ),
  );
}
