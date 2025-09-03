import { NextResponse } from "next/server";
import { verifySession } from "@/lib/auth/verify-session";

/**
 * GET /api/v1/user
 * Get current user information - works for both authenticated and anonymous users
 */
export async function GET() {
  try {
    const sessionResult = await verifySession();

    return NextResponse.json({
      success: true,
      data: {
        user: sessionResult.user,
        isAuthenticated: sessionResult.isAuthenticated,
        isAnonymous: sessionResult.isAnonymous,
      },
    });
  } catch (error) {
    console.error("Failed to get user:", error);

    return NextResponse.json(
      {
        success: false,
        error: "Failed to get user information",
        code: "GET_USER_FAILED",
      },
      { status: 500 },
    );
  }
}
