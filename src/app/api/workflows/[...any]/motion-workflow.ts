/**
 * Motion generation workflow
 * Generates video motion from static frame thumbnails (image-to-video)
 */

import { db } from '@/lib/db/client';
import { updateFrame } from '@/lib/db/helpers/frames';
import { frames } from '@/lib/db/schema';
import type { MotionWorkflowInput, MotionWorkflowResult } from '@/lib/workflow';
import { validateWorkflowAuth } from '@/lib/workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { WorkflowContext } from '@upstash/workflow';
import { createWorkflow } from '@upstash/workflow/nextjs';
// Import motion service
import { generateMotionForFrame } from '@/lib/services/motion.service';

import { DEFAULT_VIDEO_MODEL } from '@/lib/ai/models';
import { getImageUrlForApi } from '@/lib/utils/environment';
import { eq } from 'drizzle-orm';

/**
 * Motion generation workflow
 * Generates video motion from static frame thumbnails (image-to-video)
 * @param context - The workflow context. Input is in the request payload.
 * - userId: string;
 * - teamId: string;
 * - frameId: string;
 * - sequenceId: string;
 * - thumbnailUrl: string;
 * - prompt?: string;
 * - model?: keyof typeof IMAGE_TO_VIDEO_MODELS;
 * - duration?: number;
 * - fps?: number;
 * - motionBucket?: number;
 * @param  - The motion workflow input
 * @returns The motion workflow result
 * @throws WorkflowValidationError if the thumbnail URL is required for motion generation
 * @throws WorkflowValidationError if the team ID is not authorized
 * @throws WorkflowValidationError if the frame is not found
 * @throws WorkflowValidationError if the frame is not authorized
 * @throws WorkflowValidationError if the frame is not found
 */
export const generateMotionWorkflow = createWorkflow(
  async (context: WorkflowContext<MotionWorkflowInput>) => {
    const input = context.requestPayload;

    // Validate authentication
    validateWorkflowAuth(input);

    // Validate required fields
    if (!input.thumbnailUrl || input.thumbnailUrl.trim().length === 0) {
      throw new WorkflowValidationError(
        'Thumbnail URL is required for motion generation'
      );
    }

    console.log(
      '[MotionWorkflow]',
      `Starting motion generation workflow for frame ${input.frameId}`
    );

    // Step 1: Verify frame and get sequence/style info
    const frame = await context.run('verify-frame', async () => {
      const data = await db.query.frames.findFirst({
        where: eq(frames.id, input.frameId),
        with: {
          sequence: {
            columns: {
              id: true,
              teamId: true,
              styleId: true,
            },
            with: {
              style: {
                columns: {
                  id: true,
                  config: true,
                },
              },
            },
          },
        },
      });

      if (!data) {
        throw new WorkflowValidationError(`Frame not found: ${input.frameId}`);
      }

      // Verify team authorization
      if (data.sequence.teamId !== input.teamId) {
        throw new WorkflowValidationError('Unauthorized: Team ID mismatch');
      }

      return data;
    });

    // Step 2: Set status to generating
    await context.run('set-generating-status', async () => {
      await updateFrame(input.frameId, {
        videoStatus: 'generating',
        videoWorkflowRunId: context.workflowRunId,
      });
    });

    // Step 3: Generate motion/video
    const videoResult = await context.run('generate-motion', async () => {
      try {
        // Select appropriate image URL based on environment
        // - Local dev: Use temporary FAL URL (publicly accessible)
        // - Production: Use Supabase storage URL (publicly accessible)
        const imageUrl = getImageUrlForApi(
          frame.metadata?.sourceImageUrl,
          input.thumbnailUrl
        );

        if (!imageUrl) {
          throw new Error(
            'No accessible image URL available for motion generation'
          );
        }

        console.log(
          '[MotionWorkflow]',
          `Using image URL for motion generation: ${imageUrl.substring(0, 50)}...`
        );

        const result = await generateMotionForFrame({
          imageUrl,
          prompt: input.prompt,
          model: input.model || DEFAULT_VIDEO_MODEL,
          duration: input.duration,
          fps: input.fps,
          motionBucket: input.motionBucket,
        });

        if (!result.success || !result.videoUrl) {
          throw new Error(result.error || 'Motion generation failed');
        }

        return result;
      } catch (error) {
        console.error(
          '[MotionWorkflow]',
          `Motion generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
        throw error; // Re-throw so QStash will retry
      }
    });

    // Step 3: Upload video to storage
    const storageUrl = await context.run('upload-to-storage', async () => {
      if (!videoResult.videoUrl) {
        throw new Error('No video URL from generation step');
      }

      const { uploadVideoToStorage } = await import(
        '@/lib/services/video-storage.service'
      );

      const result = await uploadVideoToStorage({
        videoUrl: videoResult.videoUrl,
        teamId: input.teamId,
        sequenceId: input.sequenceId,
        frameId: input.frameId,
      });

      if (!result.success || !result.url) {
        throw new Error(result.error || 'Failed to upload video');
      }

      return result.url;
    });

    // Step 4: Update frame with video URL and status
    await context.run('update-frame', async () => {
      try {
        await updateFrame(input.frameId, {
          videoUrl: storageUrl,
          durationMs: (input.duration || 2) * 1000,
          videoStatus: 'completed',
          videoGeneratedAt: new Date(),
          videoError: null,
        });
      } catch (error) {
        throw new Error(
          `Failed to update frame: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });

    console.log('[MotionWorkflow]', 'Motion generation workflow completed');

    // Return result
    const result: MotionWorkflowResult = {
      frameId: input.frameId,
      videoUrl: storageUrl,
      duration: input.duration || 2,
    };

    return result;
  },
  {
    retries: 3,
    retryDelay: 'pow(2, retried) * 1000', // 1s, 2s, 4s, 8s
    flowControl: {
      key: 'fal-requests', // Shared key for both image & motion
      parallelism: process.env.FAL_CONCURRENCY_LIMIT
        ? parseInt(process.env.FAL_CONCURRENCY_LIMIT)
        : 10,
    },
    failureFunction: async ({ context, failResponse }) => {
      const input = context.requestPayload;

      // Set frame video status to 'failed' after all retries exhausted
      await updateFrame(input.frameId, {
        videoStatus: 'failed',
        videoError: failResponse,
      });

      console.error(
        '[MotionWorkflow]',
        `Motion generation failed for frame ${input.frameId}: ${failResponse}`
      );

      return `Motion generation failed for frame ${input.frameId}`;
    },
  }
);
