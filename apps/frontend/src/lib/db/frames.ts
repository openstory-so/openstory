/**
 * Database helper functions for frame operations
 * Provides optimistic locking and batch operations for frames
 */

import { DatabaseError } from "@/lib/errors";
import { createAdminClient } from "@/lib/supabase/server";
import type { Frame, FrameInsert, FrameUpdate, Json } from "@/types/database";

export interface FrameWithVersion extends Frame {
  version?: number;
}

/**
 * Get frames for a sequence with optional filtering
 */
export async function getFramesBySequenceId(
  sequenceId: string,
  options?: {
    includeDeleted?: boolean;
    orderBy?: "order_index" | "created_at" | "updated_at";
    ascending?: boolean;
    limit?: number;
    offset?: number;
  },
): Promise<Frame[]> {
  const supabase = createAdminClient();
  const {
    orderBy = "order_index",
    ascending = true,
    limit,
    offset,
  } = options || {};

  let query = supabase
    .from("frames")
    .select("*")
    .eq("sequence_id", sequenceId)
    .order(orderBy, { ascending });

  if (limit) {
    query = query.limit(limit);
  }

  if (offset) {
    query = query.range(offset, offset + (limit || 100) - 1);
  }

  const { data, error } = await query;

  if (error) {
    throw new DatabaseError("Failed to fetch frames", {
      supabaseError: error.message,
      code: error.code,
      sequenceId,
    });
  }

  return data || [];
}

/**
 * Get a single frame by ID with optional locking
 */
export async function getFrameById(
  frameId: string,
  _options?: {
    forUpdate?: boolean; // Lock for update (requires transaction)
  },
): Promise<Frame | null> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("frames")
    .select("*")
    .eq("id", frameId)
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      return null; // Not found
    }
    throw new DatabaseError("Failed to fetch frame", {
      supabaseError: error.message,
      code: error.code,
      frameId,
    });
  }

  return data;
}

/**
 * Create multiple frames in a batch
 */
export async function batchCreateFrames(
  frames: FrameInsert[],
): Promise<Frame[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase.from("frames").insert(frames).select();

  if (error) {
    throw new DatabaseError("Failed to create frames", {
      supabaseError: error.message,
      code: error.code,
      frameCount: frames.length,
    });
  }

  return data || [];
}

/**
 * Update a frame with optimistic locking
 */
export async function updateFrameWithVersion(
  frameId: string,
  updates: FrameUpdate,
  expectedVersion?: number,
): Promise<Frame> {
  const supabase = createAdminClient();

  // If version checking is requested, first verify the version
  if (expectedVersion !== undefined) {
    const current = await getFrameById(frameId);
    if (!current) {
      throw new DatabaseError("Frame not found", { frameId });
    }

    const currentVersion =
      ((current.metadata as Record<string, unknown>)?.version as number) || 0;
    if (currentVersion !== expectedVersion) {
      throw new DatabaseError("Frame has been modified by another process", {
        frameId,
        expectedVersion,
        currentVersion,
      });
    }
  }

  // Update with incremented version
  const newMetadata = {
    ...((updates.metadata as Record<string, unknown>) || {}),
    version:
      (((updates.metadata as Record<string, unknown>)?.version as number) ||
        expectedVersion ||
        0) + 1,
    lastModified: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("frames")
    .update({
      ...updates,
      metadata: newMetadata as Json,
      updated_at: new Date().toISOString(),
    })
    .eq("id", frameId)
    .select()
    .single();

  if (error) {
    throw new DatabaseError("Failed to update frame", {
      supabaseError: error.message,
      code: error.code,
      frameId,
    });
  }

  return data;
}

/**
 * Batch update frames
 */
export async function batchUpdateFrames(
  updates: Array<{ id: string; updates: FrameUpdate }>,
): Promise<Frame[]> {
  const supabase = createAdminClient();
  const results: Frame[] = [];

  // Process updates in parallel batches
  const batchSize = 10;
  for (let i = 0; i < updates.length; i += batchSize) {
    const batch = updates.slice(i, i + batchSize);
    const promises = batch.map(({ id, updates }) =>
      supabase
        .from("frames")
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select()
        .single(),
    );

    const batchResults = await Promise.all(promises);
    for (const result of batchResults) {
      if (result.error) {
        console.error("Failed to update frame:", result.error);
      } else if (result.data) {
        results.push(result.data);
      }
    }
  }

  return results;
}

/**
 * Delete frames by IDs
 */
export async function deleteFramesByIds(frameIds: string[]): Promise<void> {
  const supabase = createAdminClient();

  const { error } = await supabase.from("frames").delete().in("id", frameIds);

  if (error) {
    throw new DatabaseError("Failed to delete frames", {
      supabaseError: error.message,
      code: error.code,
      frameIds,
    });
  }
}

/**
 * Reorder frames in a sequence
 */
export async function reorderSequenceFrames(
  sequenceId: string,
  frameOrders: Array<{ id: string; order_index: number }>,
): Promise<void> {
  const supabase = createAdminClient();

  // Update all frames in parallel
  const promises = frameOrders.map(({ id, order_index }) =>
    supabase
      .from("frames")
      .update({
        order_index,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("sequence_id", sequenceId),
  );

  const results = await Promise.all(promises);
  const errors = results.filter((r) => r.error);

  if (errors.length > 0) {
    throw new DatabaseError("Failed to reorder some frames", {
      errors: errors.map((e) => e.error?.message),
      sequenceId,
    });
  }
}

/**
 * Get frame count for a sequence
 */
export async function getFrameCount(sequenceId: string): Promise<number> {
  const supabase = createAdminClient();

  const { count, error } = await supabase
    .from("frames")
    .select("id", { count: "exact", head: true })
    .eq("sequence_id", sequenceId);

  if (error) {
    throw new DatabaseError("Failed to count frames", {
      supabaseError: error.message,
      code: error.code,
      sequenceId,
    });
  }

  return count || 0;
}

/**
 * Get total duration for a sequence
 */
export async function getSequenceDuration(sequenceId: string): Promise<number> {
  const frames = await getFramesBySequenceId(sequenceId, {
    orderBy: "order_index",
  });

  return frames.reduce((total, frame) => total + (frame.duration_ms || 0), 0);
}

/**
 * Find frames by job ID
 */
export async function getFramesByJobId(jobId: string): Promise<Frame[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("frames")
    .select("*")
    .eq("metadata->jobId", jobId)
    .order("order_index", { ascending: true });

  if (error) {
    throw new DatabaseError("Failed to fetch frames by job ID", {
      supabaseError: error.message,
      code: error.code,
      jobId,
    });
  }

  return data || [];
}

/**
 * Update frame generation status
 */
export async function updateFrameGenerationStatus(
  frameId: string,
  status: "generating" | "completed" | "failed",
  additionalMetadata?: Record<string, unknown>,
): Promise<Frame> {
  const frame = await getFrameById(frameId);
  if (!frame) {
    throw new DatabaseError("Frame not found", { frameId });
  }

  const currentMetadata = (frame.metadata as Record<string, unknown>) || {};
  const updatedMetadata = {
    ...currentMetadata,
    ...additionalMetadata,
    status,
    statusUpdatedAt: new Date().toISOString(),
  };

  return updateFrameWithVersion(
    frameId,
    {
      metadata: updatedMetadata as Json,
    },
    currentMetadata.version as number | undefined,
  );
}

/**
 * Clear placeholder frames for a sequence
 */
export async function clearPlaceholderFrames(
  sequenceId: string,
  jobId?: string,
): Promise<number> {
  const supabase = createAdminClient();

  let query = supabase
    .from("frames")
    .delete()
    .eq("sequence_id", sequenceId)
    .eq("metadata->status", "generating");

  if (jobId) {
    query = query.eq("metadata->jobId", jobId);
  }

  const { error, count } = await query;

  if (error) {
    throw new DatabaseError("Failed to clear placeholder frames", {
      supabaseError: error.message,
      code: error.code,
      sequenceId,
      jobId,
    });
  }

  return count || 0;
}
