/**
 * Team Members API Endpoint
 * GET /api/v1/teams/[teamId]/members - List team members
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getTeamMembers } from "@/app/actions/team";
import { handleApiError, ValidationError } from "@/lib/errors";

export async function GET(
  _request: Request,
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

    // Get team members
    const result = await getTeamMembers(teamId);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message: result.error || "Failed to fetch team members",
          timestamp: new Date().toISOString(),
        },
        { status: result.error?.includes("Authentication") ? 401 : 403 },
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: result.data,
        timestamp: new Date().toISOString(),
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[GET /api/v1/teams/[teamId]/members] Error:", error);
    const handledError = handleApiError(error);
    return NextResponse.json(
      {
        success: false,
        message: "Failed to fetch team members",
        error: handledError.toJSON(),
        timestamp: new Date().toISOString(),
      },
      { status: handledError.statusCode },
    );
  }
}
