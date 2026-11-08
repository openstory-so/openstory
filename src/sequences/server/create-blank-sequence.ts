import { generateId } from '@/platform/id';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Sequence } from '@/platform/server/db/schema';
import { getAnalysisModelById } from '@/models/models.config';
import { UNTITLED_SEQUENCE_TITLE } from '@/sequences/untitled-sequence-title';
import type { z } from 'zod';
import { resolveStyleSource } from './resolve-style-source';
import type { blankSequenceSchema } from './sequence.schemas';

export type BlankSequenceInput = z.infer<typeof blankSequenceSchema>;

/**
 * A draft sequence with an empty script. Does not reserve credits or start
 * a storyboard. Stop-at is `script` so a later Continue does not jump to motion
 * before the user has written scenes.
 */
export async function createBlankSequence(
  data: BlankSequenceInput,
  context: { scopedDb: ScopedDb; user: { id: string } }
): Promise<Sequence> {
  const styleSource = await resolveStyleSource(context.scopedDb, data.styleId);
  const sequenceId = generateId();
  const boundStyle =
    styleSource.kind === 'library'
      ? null
      : await context.scopedDb.styles.createForSequence({
          sequenceId,
          draft: styleSource.draft,
        });

  return context.scopedDb.sequences.create({
    id: sequenceId,
    title: UNTITLED_SEQUENCE_TITLE,
    script: '',
    styleId: boundStyle?.id ?? data.styleId,
    deferStyleSnapshot: styleSource.kind === 'pending',
    aspectRatio: data.aspectRatio,
    resolution: data.resolution,
    analysisModel:
      getAnalysisModelById(data.analysisModel)?.id ?? data.analysisModel,
    imageModel: data.imageModel,
    videoModel: data.videoModel,
    generationStopAt: 'script',
  });
}
