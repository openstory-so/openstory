/**
 * Team Member Management API Endpoint
 * DELETE /api/v1/teams/[teamId]/members/[userId] - Remove a member (admin/owner only)
 * PATCH /api/v1/teams/[teamId]/members/[userId] - Update member role (owner only)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { removeTeamMember, updateMemberRole } from "@/app/actions/team";
import { handleApiError, ValidationError } from "@/lib/errors";

const updateRoleSchema = z.object({
  role: z.enum(["owner", "admin", "member", "viewer"]),
});

export async function DELETE(
  _: Request,
  { params }: { params: Promise<{ teamId: string; userId: string }> },
) {
  try {
    const { teamId, userId } = await params;

    // Validate UUIDs
    const uuidSchema = z.string().uuid();
    try {
      uuidSchema.parse(teamId);
      uuidSchema.parse(userId);
    } catch {
      throw new ValidationError("Invalid team ID or user ID format");
    }

    // Remove member
    const result = await removeTeamMember({ teamId, userId });

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message: result.error || "Failed to remove member",
          timestamp: new Date().toISOString(),
        },
        { status: result.error?.includes("Authentication") ? 401 : 403 },
      );
    }

    return NextResponse.json(
      {
        success: true,
        message: "Member removed successfully",
        timestamp: new Date().toISOString(),
      },
      { status: 200 },
    );
  } catch (error) {
    console.error(
      "[DELETE /api/v1/teams/[teamId]/members/[userId]] Error:",
      error,
    );
    const handledError = handleApiError(error);
    return NextResponse.json(
      {
        success: false,
        message: "Failed to remove member",
        error: handledError.toJSON(),
        timestamp: new Date().toISOString(),
      },
      { status: handledError.statusCode },
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ teamId: string; userId: string }> },
) {
  try {
    const { teamId, userId } = await params;

    // Validate UUIDs
    const uuidSchema = z.string().uuid();
    try {
      uuidSchema.parse(teamId);
      uuidSchema.parse(userId);
    } catch {
      throw new ValidationError("Invalid team ID or user ID format");
    }

    // Parse and validate request body
    const body = await request.json();
    const validated = updateRoleSchema.parse(body);

    // Update role
    const result = await updateMemberRole({
      teamId,
      userId,
      newRole: validated.role,
    });

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message: result.error || "Failed to update role",
          timestamp: new Date().toISOString(),
        },
        { status: result.error?.includes("Authentication") ? 401 : 403 },
      );
    }

    return NextResponse.json(
      {
        success: true,
        message: "Role updated successfully",
        timestamp: new Date().toISOString(),
      },
      { status: 200 },
    );
  } catch (error) {
    console.error(
      "[PATCH /api/v1/teams/[teamId]/members/[userId]] Error:",
      error,
    );

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
        message: "Failed to update role",
        error: handledError.toJSON(),
        timestamp: new Date().toISOString(),
      },
      { status: handledError.statusCode },
    );
  }
}
