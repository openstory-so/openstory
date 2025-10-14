import { NextResponse } from "next/server";
import z from "zod";
import { calculateFalCost, calculateFalTime } from "@/lib/ai/fal-client";
import { type FalImageModel, IMAGE_MODELS } from "@/lib/ai/models";
import {
  MODEL_KEYS,
  parseExtraParamsByModel,
} from "@/lib/ai/models-validation";
import { handleApiError } from "@/lib/errors";

const estimateImageCostSchema = z
  .object({
    model: z.enum(MODEL_KEYS),
    prompt: z.string(),
    extra_params: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (data) => {
      try {
        parseExtraParamsByModel(data);
        return true;
      } catch {
        return false;
      }
    },
    {
      message:
        "[api/v1/generation/image/estimate] Generating image | extra_params validation failed for the selected model",
    },
  );

// calculate cost for image generation
export async function POST(request: Request) {
  try {
    // Parse and validate request body
    const body = await request.json();
    let parseResult: ReturnType<typeof estimateImageCostSchema.safeParse>;
    try {
      parseResult = estimateImageCostSchema.safeParse(body);
    } catch (schemaError) {
      if (
        schemaError instanceof Error &&
        schemaError.message.startsWith("[model-validations]")
      ) {
        return NextResponse.json(
          { error: schemaError.message },
          { status: 400 },
        );
      }
      throw schemaError;
    }

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.flatten() },
        { status: 400 },
      );
    }
    const validatedData = parseResult.data;

    const modelKey = validatedData.model as keyof typeof IMAGE_MODELS;
    const model = IMAGE_MODELS[modelKey] as FalImageModel;
    // Normalize extra_params with per-model schema to inject defaults/coercions
    const normalizedResult = parseExtraParamsByModel({
      model: validatedData.model,
      prompt: validatedData.prompt,
      extra_params: validatedData.extra_params,
    });
    const costResult = calculateFalCost(model, normalizedResult);
    const timeResult = calculateFalTime(model, normalizedResult);

    return NextResponse.json(
      {
        success: true,
        data: {
          cost: costResult,
          time: timeResult,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    const velroError = handleApiError(error);
    return NextResponse.json(
      { error: velroError.message },
      { status: velroError.statusCode },
    );
  }
}
