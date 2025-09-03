import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AuthService } from "@/lib/auth/service";

const sendMagicLinkSchema = z.object({
  email: z.string().email("Valid email is required"),
  redirectTo: z.string().url().optional(),
});

/**
 * Send magic link to user's email
 * POST /api/v1/auth/magic-link
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate input
    const { email, redirectTo } = sendMagicLinkSchema.parse(body);

    // Send magic link
    const authService = new AuthService();
    const result = await authService.sendMagicLink(email, redirectTo);

    if (!result || !result.success) {
      return NextResponse.json(
        {
          success: false,
          error: result?.error || "Failed to send magic link",
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      success: true,
      message: "Magic link sent successfully. Check your email.",
    });
  } catch (error) {
    console.error("Send magic link error:", error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid request data",
          details: error.issues,
        },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to send magic link",
      },
      { status: 500 },
    );
  }
}
