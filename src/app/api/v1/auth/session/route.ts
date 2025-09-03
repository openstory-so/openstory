import { type NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth/service";

/**
 * Get current user session
 * GET /api/v1/auth/session
 */
export async function GET(_request: NextRequest) {
  try {
    const authService = new AuthService();
    const session = await authService.getSession();

    if (!session) {
      return NextResponse.json({
        success: true,
        data: {
          session: null,
          user: null,
          isAuthenticated: false,
        },
      });
    }

    // Get user profile if session exists
    const userProfile = await authService.getUserProfile();

    return NextResponse.json({
      success: true,
      data: {
        session: {
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          expires_at: session.expires_at,
          user: session.user,
        },
        profile: userProfile,
        isAuthenticated: true,
      },
    });
  } catch (error) {
    console.error("Get session error:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to get session",
      },
      { status: 500 },
    );
  }
}

/**
 * Sign out current user
 * DELETE /api/v1/auth/session
 */
export async function DELETE(_request: NextRequest) {
  try {
    const authService = new AuthService();
    const result = await authService.signOut();

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          error: result.error || "Failed to sign out",
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      success: true,
      message: "Signed out successfully",
    });
  } catch (error) {
    console.error("Sign out error:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to sign out",
      },
      { status: 500 },
    );
  }
}
