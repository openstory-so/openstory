"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AuthService } from "@/lib/auth/service";
import { createServerClient } from "@/lib/supabase/server";
import type {
  Frame,
  FrameInsert,
  Sequence,
  SequenceInsert,
} from "@/types/database";

// Re-export validation types from mock for backward compatibility
export type {
  FrameGenerationResult,
  MotionGenerationResult,
  ScriptEnhancementResult,
  ScriptValidationResult,
} from "#actions/anonymous-flow";

// Re-export mock functions for validation and enhancement (still using mocks for these)
export {
  enhanceScript,
  validateScript,
} from "#actions/anonymous-flow";

// Schema definitions
const createSequenceSchema = z.object({
  name: z.string().min(1).max(100),
  script: z.string().min(10).max(10000),
  style_id: z.uuid().optional(),
});

const updateSequenceSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(100).optional(),
  script: z.string().min(10).max(10000).optional(),
  style_id: z.uuid().nullable().optional(),
});

export type CreateSequenceInput = z.infer<typeof createSequenceSchema>;
export type UpdateSequenceInput = z.infer<typeof updateSequenceSchema>;

/**
 * Create or update a sequence in the database
 */
export async function saveSequence(
  script: string,
  styleId: string | null,
  sequenceId?: string,
  name?: string,
): Promise<{ success: boolean; sequence?: Sequence; error?: string }> {
  try {
    const supabase = createServerClient();
    const authService = new AuthService();

    if (sequenceId) {
      // Update existing sequence
      const { data, error } = await supabase
        .from("sequences")
        .update({
          script,
          style_id: styleId,
          title: name || "Untitled Sequence",
          updated_at: new Date().toISOString(),
        })
        .eq("id", sequenceId)
        .select()
        .single();

      if (error) {
        throw new Error(error.message);
      }

      revalidatePath(`/sequences/${sequenceId}`);
      return {
        success: true,
        sequence: data,
      };
    } else {
      // Create new sequence - get team_id from current user's session
      const teamId = await authService.getCurrentUserTeamId();

      if (!teamId) {
        throw new Error(
          "No team found for current user. Please ensure you are logged in.",
        );
      }

      const sequenceData: SequenceInsert = {
        script,
        style_id: styleId,
        title: name || "Untitled Sequence",
        team_id: teamId,
        status: "draft",
      };

      const { data, error } = await supabase
        .from("sequences")
        .insert(sequenceData)
        .select()
        .single();

      if (error) {
        throw new Error(error.message);
      }

      revalidatePath("/");
      return {
        success: true,
        sequence: data,
      };
    }
  } catch (error) {
    console.error("Error saving sequence:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to save sequence",
    };
  }
}

/**
 * Generate frames from script and save to database
 */
export async function generateFrames(
  script: string,
  styleId: string,
  sequenceId: string,
): Promise<{ success: boolean; frames?: Frame[]; error?: string }> {
  try {
    const supabase = createServerClient();

    // First, use the mock function to generate frame data
    // In production, this would call an AI service
    const { generateFrames: generateMockFrames } = await import(
      "#actions/anonymous-flow"
    );
    const mockResult = await generateMockFrames(script, styleId, sequenceId);

    if (!mockResult.success || !mockResult.frames) {
      throw new Error(mockResult.error || "Failed to generate frames");
    }

    // Save frames to database
    const frameInserts: FrameInsert[] = mockResult.frames.map(
      (frame, index) => ({
        sequence_id: sequenceId,
        description: frame.description,
        order_index: index + 1,
        thumbnail_url: frame.thumbnail_url,
        video_url: frame.video_url,
        duration_ms: frame.duration_ms,
        metadata: frame.metadata,
      }),
    );

    const { data, error } = await supabase
      .from("frames")
      .insert(frameInserts)
      .select();

    if (error) {
      throw new Error(error.message);
    }

    revalidatePath(`/sequences/${sequenceId}`);
    return {
      success: true,
      frames: data,
    };
  } catch (error) {
    console.error("Error generating frames:", error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to generate frames",
    };
  }
}

/**
 * Generate motion for a frame and update in database
 */
export async function generateFrameMotion(
  frameId: string,
  frameDescription: string,
  styleId: string,
): Promise<{
  success: boolean;
  videoUrl?: string;
  duration?: number;
  error?: string;
}> {
  try {
    const supabase = createServerClient();

    // Use mock function to generate video URL
    // In production, this would call an AI video service
    const { generateFrameMotion: generateMockMotion } = await import(
      "#actions/anonymous-flow"
    );
    const mockResult = await generateMockMotion(
      frameId,
      frameDescription,
      styleId,
    );

    if (!mockResult.success) {
      throw new Error(mockResult.error || "Failed to generate motion");
    }

    // Update frame with video URL
    const { data, error } = await supabase
      .from("frames")
      .update({
        video_url: mockResult.videoUrl,
        metadata: {
          motionGenerated: true,
          motionDuration: mockResult.duration,
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", frameId)
      .select()
      .single();

    if (error) {
      throw new Error(error.message);
    }

    revalidatePath(`/sequences/${data.sequence_id}`);
    return {
      success: true,
      videoUrl: mockResult.videoUrl,
      duration: mockResult.duration,
    };
  } catch (error) {
    console.error("Error generating motion:", error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to generate motion",
    };
  }
}

/**
 * Get a sequence by ID with all its frames
 */
export async function getSequence(sequenceId: string): Promise<{
  success: boolean;
  sequence?: Sequence & { frames: Frame[] };
  error?: string;
}> {
  try {
    const supabase = createServerClient();

    const { data, error } = await supabase
      .from("sequences")
      .select(`
        *,
        frames (*)
      `)
      .eq("id", sequenceId)
      .single();

    if (error) {
      throw new Error(error.message);
    }

    return {
      success: true,
      sequence: data,
    };
  } catch (error) {
    console.error("Error getting sequence:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get sequence",
    };
  }
}

// Legacy functions for backward compatibility with existing schema
export async function createSequence(input: CreateSequenceInput) {
  const validated = createSequenceSchema.parse(input);
  return saveSequence(
    validated.script,
    validated.style_id || null,
    undefined,
    validated.name,
  );
}

export async function updateSequence(input: UpdateSequenceInput) {
  const validated = updateSequenceSchema.parse(input);
  return saveSequence(
    validated.script || "",
    validated.style_id === undefined ? null : validated.style_id,
    validated.id,
    validated.name,
  );
}

export async function deleteSequence(_id: string) {
  throw new Error("Not implemented - use mock in Storybook");
}

export async function listSequences(_teamId?: string) {
  throw new Error("Not implemented - use mock in Storybook");
}

export async function generateStoryboard(sequenceId: string) {
  const sequenceResult = await getSequence(sequenceId);
  if (!sequenceResult.success || !sequenceResult.sequence) {
    throw new Error("Sequence not found");
  }

  const { script, style_id } = sequenceResult.sequence;
  if (!script || !style_id) {
    throw new Error("Sequence missing script or style");
  }

  return generateFrames(script, style_id, sequenceId);
}
