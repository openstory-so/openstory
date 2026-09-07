/**
 * Optimised-prompt inspector (#1242). The scene editor used to run the same
 * fal/Ark/Grok/Gemini request builders in the browser; those now live behind
 * this server fn so the client graph does not ship them.
 */

import { isBytePlusConfigured } from '@/lib/ai/byteplus-config';
import { motionPromptFromVersion } from '@/shared/motion/resolve-motion-prompt';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/shared/ai/models';
import { usesStartFrame } from '@/shared/shots/use-start-frame';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import {
  buildShotPromptPreview,
  type ShotPromptPreview,
} from '@/lib/prompts/optimised-prompt-preview';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { shotAccessMiddleware } from './middleware';

const previewShotPromptsInputSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  imageModel: z.string(),
  videoModel: z.string(),
  imagePrompt: z.string().optional(),
  motionPrompt: z.string().optional(),
  generateAudio: z.boolean().optional(),
});

export const previewShotPromptsFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(previewShotPromptsInputSchema))
  .handler(async ({ data, context }): Promise<ShotPromptPreview> => {
    const { shot, frame, sequence, scene, scopedDb } = context;
    const usesFrame = usesStartFrame(shot, sequence);
    const [
      characters,
      elements,
      locations,
      selectedStill,
      selectedMotion,
      selectedVisual,
    ] = await Promise.all([
      scopedDb.characters.listWithSheets(sequence.id),
      scopedDb.sequenceElements.list(sequence.id),
      scopedDb.sequenceLocations.listWithReferences(sequence.id),
      usesFrame
        ? scopedDb.frameVariants.getSelected(frame.id)
        : Promise.resolve(null),
      scopedDb.shotPromptVersions.getSelectedMotion(shot.id),
      scopedDb.framePromptVersions.getSelected(frame.id),
    ]);

    const overrideText = data.motionPrompt ?? selectedMotion?.text ?? '';
    const motionPrompt = selectedMotion
      ? {
          ...motionPromptFromVersion(selectedMotion),
          fullPrompt: overrideText || selectedMotion.text,
        }
      : overrideText
        ? { fullPrompt: overrideText, dialogue: null, audio: null }
        : null;

    return buildShotPromptPreview({
      imageModel: safeTextToImageModel(data.imageModel, DEFAULT_IMAGE_MODEL),
      videoModel: safeImageToVideoModel(data.videoModel, DEFAULT_VIDEO_MODEL),
      imagePrompt: data.imagePrompt ?? selectedVisual?.text ?? '',
      motionPrompt,
      motionPromptText: overrideText || null,
      shotDurationMs: shot.durationMs,
      startFrameUrl: selectedStill?.url ?? null,
      usesStartFrame: usesFrame,
      generateAudio: data.generateAudio ?? true,
      aspectRatio: sequence.aspectRatio,
      resolution: sequence.resolution,
      scene,
      characters,
      elements,
      locations,
      byteplusEnabled: isBytePlusConfigured(),
    });
  });
