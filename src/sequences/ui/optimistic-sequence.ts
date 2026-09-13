/**
 * Client-minted sequence for Generate (#1601).
 *
 * The click navigates to `/sequences/$id/scenes` on the same tick, before
 * `createSequenceFn` returns — same feel as a form POST. Cache is seeded so
 * the destination loader and progressive-reveal script view have something
 * to render while the insert + workflow trigger catch up.
 */
import { AUTO_STYLE_ID } from '@/look/auto-style';
import { DEFAULT_ASPECT_RATIO } from '@/models/aspect-ratios';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
} from '@/models/models';
import { DEFAULT_ANALYSIS_MODEL } from '@/models/models.config';
import { DEFAULT_RESOLUTION } from '@/models/resolutions';
import { generateId } from '@/platform/id';
import type { Sequence } from '@/platform/server/db/schema';
import {
  DEFAULT_GENERATION_STOP_AT,
  flagsFromStopAt,
} from '@/sequences/pipeline';
import type { CreateSequenceInput } from '@/sequences/server/sequence.schemas';
import { UNTITLED_SEQUENCE_TITLE } from '@/sequences/untitled-sequence-title';
import type { QueryClient } from '@tanstack/react-query';
import {
  clearPendingSequenceCreate,
  markPendingSequenceCreate,
} from './pending-sequence-create';

/** Same shapes as the destination hooks — kept local so this module stays
 *  import-safe from `use-sequences` (no cycle through shots/styles). */
const sequenceDetailKey = (id: string) => ['sequences', 'detail', id] as const;
const shotListKey = (id: string) => ['shots', 'list', id] as const;
const sceneListKey = (id: string) => ['scenes', 'list', id] as const;
const segmentListKey = (id: string) => ['segments', 'list', id] as const;
const styleForSequenceKey = (id: string) => ['styles', 'sequence', id] as const;

const EMPTY_SELECTED_MODELS = {
  imageModelByShot: {},
  videoModelByShot: {},
  failedImageModelByShot: {},
  failedVideoModelByShot: {},
};

export function allocateSequenceIds(input: CreateSequenceInput): string[] {
  const modelCount = Math.max(input.analysisModels?.length ?? 1, 1);
  if (input.ids && input.ids.length >= modelCount) {
    return input.ids.slice(0, modelCount);
  }
  const ids = input.ids ? [...input.ids] : [];
  while (ids.length < modelCount) {
    ids.push(generateId());
  }
  return ids;
}

export function buildOptimisticSequence(
  id: string,
  input: CreateSequenceInput
): Sequence {
  const stopAt = input.stopAt ?? DEFAULT_GENERATION_STOP_AT;
  const flags = flagsFromStopAt(stopAt);
  const now = new Date();
  return {
    id,
    teamId: input.teamId ?? '',
    title: input.title || UNTITLED_SEQUENCE_TITLE,
    script: input.script,
    status: 'processing',
    statusError: null,
    workflowRunId: null,
    createdAt: now,
    updatedAt: now,
    createdBy: null,
    updatedBy: null,
    styleId: input.styleId || AUTO_STYLE_ID,
    styleConfig: null,
    aspectRatio: input.aspectRatio ?? DEFAULT_ASPECT_RATIO,
    resolution: input.resolution ?? DEFAULT_RESOLUTION,
    analysisModel: input.analysisModels?.[0] ?? DEFAULT_ANALYSIS_MODEL,
    analysisDurationMs: 0,
    imageModel:
      input.imageModels?.[0] ?? input.imageModel ?? DEFAULT_IMAGE_MODEL,
    videoModel:
      input.videoModels?.[0] ?? input.videoModel ?? DEFAULT_VIDEO_MODEL,
    workflow: null,
    musicUrl: null,
    musicPath: null,
    musicStatus: 'pending',
    musicGeneratedAt: null,
    musicError: null,
    musicModel:
      input.audioModels?.[0] ?? input.musicModel ?? DEFAULT_MUSIC_MODEL,
    musicPrompt: null,
    musicTags: null,
    musicPromptInputHash: null,
    includeMusic: true,
    posterUrl: null,
    readyEmailSentAt: null,
    autoGenerateMotion: input.autoGenerateMotion ?? flags.autoGenerateMotion,
    autoGenerateMusic: input.autoGenerateMusic ?? flags.autoGenerateMusic,
    generationStopAt: stopAt,
    pipelineStage: null,
    generationCheckpoint: null,
    generateStartFrames: input.generateStartFrames ?? false,
    generateVoices: input.generateVoices ?? false,
    suggestedTalentIds: input.suggestedTalentIds ?? null,
    suggestedLocationIds: input.suggestedLocationIds ?? null,
  };
}

function seedOptimisticSequence(
  queryClient: QueryClient,
  id: string,
  input: CreateSequenceInput
): void {
  queryClient.setQueryData(
    sequenceDetailKey(id),
    buildOptimisticSequence(id, input)
  );
  queryClient.setQueryData(shotListKey(id), []);
  queryClient.setQueryData(sceneListKey(id), []);
  queryClient.setQueryData(segmentListKey(id), []);
  queryClient.setQueryData(['sequence-image-variants', id], []);
  queryClient.setQueryData(['sequence-video-variants', id], []);
  queryClient.setQueryData(['sequence-audio-variants', id], []);
  queryClient.setQueryData(['sequence-image-models', id], []);
  queryClient.setQueryData(['sequence-video-models', id], []);
  queryClient.setQueryData(['sequence-audio-models', id], []);
  queryClient.setQueryData(
    ['sequence-selected-models', id],
    EMPTY_SELECTED_MODELS
  );
  queryClient.setQueryData(styleForSequenceKey(id), null);
}

function dropOptimisticSequence(queryClient: QueryClient, id: string): void {
  queryClient.removeQueries({ queryKey: sequenceDetailKey(id) });
  queryClient.removeQueries({ queryKey: shotListKey(id) });
  queryClient.removeQueries({ queryKey: sceneListKey(id) });
  queryClient.removeQueries({ queryKey: segmentListKey(id) });
  queryClient.removeQueries({ queryKey: styleForSequenceKey(id) });
  queryClient.removeQueries({ queryKey: ['sequence-image-variants', id] });
  queryClient.removeQueries({ queryKey: ['sequence-video-variants', id] });
  queryClient.removeQueries({ queryKey: ['sequence-audio-variants', id] });
  queryClient.removeQueries({ queryKey: ['sequence-image-models', id] });
  queryClient.removeQueries({ queryKey: ['sequence-video-models', id] });
  queryClient.removeQueries({ queryKey: ['sequence-audio-models', id] });
  queryClient.removeQueries({ queryKey: ['sequence-selected-models', id] });
}

/**
 * Mint ids, seed the destination cache, and mark the create pending — all
 * synchronous, so `navigate()` on the next line sees a populated cache.
 */
export function beginSequenceCreate(
  queryClient: QueryClient,
  input: CreateSequenceInput
): { ids: string[] } {
  const ids = allocateSequenceIds(input);
  const [firstId] = ids;
  if (!firstId) {
    throw new Error('beginSequenceCreate: expected at least one sequence id');
  }
  seedOptimisticSequence(queryClient, firstId, { ...input, ids });
  markPendingSequenceCreate(firstId);
  return { ids };
}

export function finishSequenceCreate(
  queryClient: QueryClient,
  id: string,
  sequence?: Sequence
): void {
  if (sequence) {
    queryClient.setQueryData(sequenceDetailKey(id), sequence);
  }
  clearPendingSequenceCreate(id);
}

export function failSequenceCreate(queryClient: QueryClient, id: string): void {
  clearPendingSequenceCreate(id);
  dropOptimisticSequence(queryClient, id);
  if (
    typeof window !== 'undefined' &&
    window.location.pathname.includes(`/sequences/${id}`)
  ) {
    window.history.back();
  }
}
