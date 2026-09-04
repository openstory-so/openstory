/**
 * Row builders for the tables a {@link import('@/lib/shots/shot-view').ShotView}
 * is assembled from. Each returns a complete, valid row with sensible defaults;
 * a caller overrides only the columns its test cares about. Parameter names ARE
 * column names, so a fixture reads like the DB.
 */

import type { Frame, FrameVariant, VideoVariant } from '@/lib/db/schema';
import { generateId } from '@/lib/db/id';

/**
 * An anchor `frames` row. Its `id` is its own — a frame is NOT its shot (#989),
 * only `shotId` links them.
 */
export function frameFixture(
  overrides: Partial<Frame> & Pick<Frame, 'shotId' | 'sequenceId'>
): Frame {
  const now = new Date();
  return {
    id: generateId(),
    orderIndex: 0,
    role: 'first',
    imageStatus: 'pending',
    imageWorkflowRunId: null,
    imageError: null,
    selectedImageVersionId: null,
    selectedImagePromptVersionId: null,
    pendingPromoteVersionId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** A completed `frame_variants` row — a frame's still. */
export function frameVariantFixture(
  overrides: Partial<FrameVariant> &
    Pick<FrameVariant, 'frameId' | 'sequenceId'>
): FrameVariant {
  const now = new Date();
  return {
    id: generateId(),
    kind: 'model',
    model: 'nano_banana_2',
    resolution: null,
    sourceVariantId: null,
    url: null,
    storagePath: null,
    status: 'completed',
    workflowRunId: null,
    generatedAt: now,
    error: null,
    promptHash: null,
    inputHash: null,
    pendingInputHash: null,
    dependsOnVersionId: null,
    promptVersionId: null,
    discardedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * A completed primary `video_variants` row — a render segment's video. The
 * `manifest` defaults to empty; pass one when a test exercises staleness.
 */
export function videoVariantFixture(
  overrides: Partial<VideoVariant> &
    Pick<VideoVariant, 'renderSegmentId' | 'sequenceId'>
): VideoVariant {
  const now = new Date();
  return {
    id: generateId(),
    model: 'kling_25_turbo_pro',
    resolution: null,
    manifest: [],
    url: null,
    storagePath: null,
    status: 'completed',
    isPrimary: true,
    workflowRunId: null,
    generatedAt: now,
    error: null,
    inputHash: null,
    discardedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
