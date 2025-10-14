/**
 * Team Invitation API Endpoint
 * POST /api/v1/teams/[teamId]/invite - Invite a member to the team (admin/owner only)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { inviteTeamMember } from "@/app/actions/team";
import { handleApiError, ValidationError } from "@/lib/errors";

const inviteRequestSchema = z.object({
  email: z.string().email("Invalid email address"),
  role: z.enum(["member", "admin", "viewer"]).default("member"),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ teamId: string }> },
) {
  try {
    const { teamId } = await params;

    // Validate UUID
    const uuidSchema = z.string().uuid();
    try {
      uuidSchema.parse(teamId);
    } catch {
      throw new ValidationError("Invalid team ID format");
    }

    // Parse and validate request body
    const body = await request.json();
    const validated = inviteRequestSchema.parse(body);

    // Invite member
    const result = await inviteTeamMember({
      teamId,
      email: validated.email,
      role: validated.role,
    });

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message: result.error || "Failed to invite member",
          timestamp: new Date().toISOString(),
        },
        { status: result.error?.includes("Authentication") ? 401 : 403 },
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: result.data,
        message: "Invitation sent successfully",
        timestamp: new Date().toISOString(),
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[POST /api/v1/teams/[teamId]/invite] Error:", error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid request data",
          errors: error.issues,
          timestamp: new Date().toISOString(),
        },
        { status: 400 },
      );
    }

    const handledError = handleApiError(error);
    return NextResponse.json(
      {
        success: false,
        message: "Failed to invite member",
        error: handledError.toJSON(),
        timestamp: new Date().toISOString(),
      },
      { status: handledError.statusCode },
    );
  }
}
