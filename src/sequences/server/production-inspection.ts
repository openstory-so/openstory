import { z } from 'zod';
import { createSelectSchema } from 'drizzle-orm/zod';
import { SHOT_GENERATION_STATUSES } from '@/platform/server/db/schema/shots';
import {
  frames,
  renderSegments,
  sequences,
  sequenceExports,
  sequenceEvents,
  shots,
} from '@/platform/server/db/schema';
import {
  StyleConfigSchema,
  resolveSequenceStyleConfig,
} from '@/look/style-config';
import {
  projectRead,
  readDate,
  textWindow,
  textWindowSchema,
} from '@/platform/server/read-projection';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type {
  Frame,
  Sequence,
  SequenceMusicVariant,
} from '@/platform/server/db/schema';
import { readinessImageStatus } from '@/shots/shot-view';
import { productionAccess } from './production-access';
import { ValidationError } from '@/platform/errors';

export const settingsSchema = createSelectSchema(sequences)
  .pick({
    id: true,
    title: true,
    status: true,
    statusError: true,
    aspectRatio: true,
    resolution: true,
    analysisDurationMs: true,
    analysisModel: true,
    imageModel: true,
    videoModel: true,
    musicModel: true,
    includeMusic: true,
    generateStartFrames: true,
    generateVoices: true,
    targetDurationSeconds: true,
    generationStopAt: true,
    workflow: true,
    workflowRunId: true,
    createdBy: true,
    updatedBy: true,
  })
  .extend({
    createdAt: readDate,
    updatedAt: readDate,
    suggestedTalentIds: z.array(z.string()).nullable(),
    suggestedLocationIds: z.array(z.string()).nullable(),
    style: z.object({
      id: z.string().nullable(),
      name: z.string().nullable(),
      source: z.enum(['snapshot', 'library', 'missing']),
      config: StyleConfigSchema.nullable(),
    }),
  });
export async function readSequenceSettings(
  scopedDb: ScopedDb,
  sequenceId: string,
  origin: string
) {
  const sequence = await productionAccess(scopedDb).sequence(sequenceId);
  const style = sequence.styleId
    ? await scopedDb.styles.getById(sequence.styleId)
    : null;
  return projectRead(
    settingsSchema,
    {
      ...sequence,
      style: {
        id: sequence.styleId,
        name: style?.name ?? null,
        source: sequence.styleConfig
          ? 'snapshot'
          : style
            ? 'library'
            : 'missing',
        config:
          sequence.styleConfig || style
            ? resolveSequenceStyleConfig({
                snapshot: sequence.styleConfig,
                live: style?.config,
              })
            : null,
      },
    },
    origin
  );
}
export const musicReadSchema = z.object({
  sequenceId: z.string(),
  enabled: z.boolean(),
  status: z.string().nullable(),
  url: z.string().nullable(),
  model: z.string().nullable(),
  error: z.string().nullable(),
  prompt: z.string().nullable(),
  tags: z.string().nullable(),
  generatedAt: readDate.nullable(),
  /** The selected `sequence_music_variants` row (list_versions kind music). */
  variantId: z.string().nullable(),
  /** The selected `sequence_music_prompt_versions` row (kind music_prompt). */
  promptVersionId: z.string().nullable(),
  selection: z.literal('version_pointer'),
});
/**
 * The sequence's music: the selected track (its own model — the sequence's
 * audio-model setting is on the settings read) and the selected prompt.
 */
export function inspectMusic(
  sequence: Sequence,
  track: Pick<SequenceMusicVariant, 'model'> | null,
  origin: string
) {
  return projectRead(
    musicReadSchema,
    {
      sequenceId: sequence.id,
      enabled: sequence.includeMusic,
      status: sequence.musicStatus,
      url: sequence.musicUrl,
      model: track?.model ?? null,
      error: sequence.musicError,
      prompt: sequence.musicPrompt,
      tags: sequence.musicTags,
      generatedAt: sequence.musicGeneratedAt,
      variantId: sequence.selectedMusicVariantId,
      promptVersionId: sequence.selectedMusicPromptVersionId,
      selection: 'version_pointer',
    },
    origin
  );
}
export const frameReadSchema = createSelectSchema(frames)
  .pick({
    id: true,
    sequenceId: true,
    shotId: true,
    role: true,
    orderIndex: true,
    selectedImageVersionId: true,
    selectedImagePromptVersionId: true,
    pendingPromoteVersionId: true,
  })
  .extend({
    // The current image attempt: the newest primary `frame_variants` row's
    // (#1942), no longer a copy on the frame.
    imageStatus: z.enum(SHOT_GENERATION_STATUSES),
    imageError: z.string().nullable(),
    imageWorkflowRunId: z.string().nullable(),
  });

/** Frames with their current image attempt, for {@link frameReadSchema}. */
export async function withImageAttempts(scopedDb: ScopedDb, rows: Frame[]) {
  const primaryByFrame = await scopedDb.frameVariants.getPrimaryByFrameIds(
    rows.map((frame) => frame.id)
  );
  return rows.map((frame) => {
    const primary = primaryByFrame.get(frame.id);
    const imageStatus = readinessImageStatus({
      hasSelectedImage: frame.selectedImageVersionId !== null,
      primaryImageStatus: primary?.status ?? null,
    });
    return {
      ...frame,
      imageStatus,
      imageError: imageStatus === 'failed' ? (primary?.error ?? null) : null,
      imageWorkflowRunId: primary?.workflowRunId ?? null,
    };
  });
}
export const segmentReadSchema = createSelectSchema(renderSegments).pick({
  id: true,
  sequenceId: true,
  sceneId: true,
  selectedVideoVersionId: true,
  pendingPromoteVersionId: true,
});
export const shotMembershipSchema = createSelectSchema(shots).pick({
  id: true,
  sequenceId: true,
  sceneId: true,
  shotNumber: true,
  durationMs: true,
  useStartFrame: true,
  selectedMotionPromptVersionId: true,
  renderSegmentId: true,
});
export const audioClipSchema = z.object({
  id: z.string(),
  url: z.string(),
  token: z.string(),
  durationSeconds: z.number().nullable(),
  sourceKey: z.string().optional(),
  // The wording a fitted take actually delivers (#1651), when it was rewritten.
  spokenLines: z
    .array(z.object({ index: z.number(), text: z.string() }))
    .optional(),
});
export const exportReadSchema = createSelectSchema(sequenceExports)
  .pick({
    id: true,
    sequenceId: true,
    url: true,
    status: true,
    error: true,
    workflowRunId: true,
    sourceShotsHash: true,
    sourceMusicVariantId: true,
  })
  .extend({
    createdAt: readDate,
    // The column is declared integer() but holds the container-measured length,
    // which is fractional (15.125). The generated validator demands an int and
    // would reject every real export.
    durationSeconds: z.number().nullable(),
  });
export const eventReadSchema = createSelectSchema(sequenceEvents)
  .pick({
    id: true,
    sequenceId: true,
    actorId: true,
    kind: true,
    targetType: true,
    targetId: true,
    summary: true,
  })
  .extend({ createdAt: readDate });
export const documentReadSchema = textWindowSchema.extend({
  revision: z.string(),
  format: z.enum(['text', 'json']),
});

/** Content-bound continuation prevents splicing together different revisions. */
export async function readDocument(
  text: string,
  input: { offset: number; length: number; revision?: string },
  format: 'text' | 'json'
) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text)
  );
  const revision = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  if (input.revision && input.revision !== revision)
    throw new ValidationError(
      'Document changed. Restart at offset 0 without a revision.'
    );
  return { ...textWindow(text, input), revision, format };
}
