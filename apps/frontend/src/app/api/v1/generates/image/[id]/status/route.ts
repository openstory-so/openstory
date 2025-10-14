import { NextResponse } from "next/server";
import { fetchGeneratedImageStatusAction } from "@/app/actions/generates/image";
import { handleApiError } from "@/lib/errors";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    console.log(
      "[api/v1/generates/image/[id]/status] Image generation status request",
      {
        id,
      },
    );
    const result = await fetchGeneratedImageStatusAction(id);
    console.log(
      "[api/v1/generates/image/[id]/status] Image generation status result",
      {
        result,
      },
    );
    if (!result.success) {
      throw new Error(
        result.error ||
          "[api/v1/generates/image/[id]/status] FAL Generation status retrieval failed",
      );
    }

    return NextResponse.json(
      {
        success: true,
        message:
          "[api/v1/generates/image/[id]/status] FAL Generation status retrieved",
        data: result.data,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error(
      "[api/v1/generates/image/[id]/status] Error getting the generated image status",
      error,
    );
    const velroError = handleApiError(error);
    return NextResponse.json(
      { error: velroError.message },
      { status: velroError.statusCode },
    );
  }
}
