import { getChannelHistoryFn } from '@/functions/realtime-history';
import { useUser } from '@/hooks/use-user';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer } from 'react';
import { useRealtime } from './client';
import {
  createInitialState,
  generationStreamReducer,
  type GenerationPhaseConfig,
  type GenerationStreamAction,
} from './generation-stream.reducer';
import { updateQueryCacheFromEvent } from './query-cache-updater';

import { getLogger } from '@/lib/observability/logger';
import { toast } from 'sonner';

const logger = getLogger(['openstory', 'realtime', 'use-generation-stream']);

type GenerationEvent = {
  event: string;
  data: Record<string, unknown>;
};

// Type guard helpers for extracting typed values from event data
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

type ShotStatus = 'pending' | 'generating' | 'completed' | 'failed';

function asShotStatus(value: unknown): ShotStatus | undefined {
  if (
    value === 'pending' ||
    value === 'generating' ||
    value === 'completed' ||
    value === 'failed'
  ) {
    return value;
  }
  return undefined;
}

/**
 * Extract retry state (#882) from an image/video progress event. Present only
 * when the emitter is starting a retry attempt (`phase: 'retrying'` with both
 * counters); any other update returns `undefined`, which clears the prior
 * retry state in the reducer.
 *
 * Variant-only retries (#547 alternate-model adds) are ignored: they don't
 * regenerate the live primary, so their retry state must not surface on the
 * primary player overlay.
 */
function asRetryInfo(
  data: Record<string, unknown>
): { attempt: number; maxAttempts?: number } | undefined {
  if (data.phase !== 'retrying' || data.variantOnly === true) return undefined;
  const attempt = asOptionalNumber(data.attempt);
  if (attempt === undefined) return undefined;
  // maxAttempts is optional: absent when the emitter leans on CF's default
  // per-step retry budget (no fixed denominator).
  return { attempt, maxAttempts: asOptionalNumber(data.maxAttempts) };
}

/**
 * Maps a realtime event to a typed reducer action.
 * Uses type guards for runtime type safety.
 */
function mapEventToAction(
  eventName: string,
  data: Record<string, unknown>
): GenerationStreamAction | null {
  switch (eventName) {
    case 'generation.phase:start':
      return {
        type: 'PHASE_START',
        payload: {
          phase: asNumber(data.phase),
          phaseName: asString(data.phaseName),
        },
      };

    case 'generation.phase:complete':
      return {
        type: 'PHASE_COMPLETE',
        payload: { phase: asNumber(data.phase) },
      };

    case 'generation.scene:new':
      return {
        type: 'SCENE_NEW',
        payload: {
          sceneId: asString(data.sceneId),
          sceneNumber: asNumber(data.sceneNumber),
          title: asString(data.title),
          scriptExtract: asString(data.scriptExtract),
          durationSeconds: asNumber(data.durationSeconds),
        },
      };

    case 'generation.scene:updated':
      return {
        type: 'SCENE_UPDATED',
        payload: {
          sceneId: asString(data.sceneId),
          sceneNumber: asNumber(data.sceneNumber),
          title: asString(data.title),
          scriptExtract: asString(data.scriptExtract),
          durationSeconds: asNumber(data.durationSeconds),
        },
      };

    case 'generation.shot:created':
      return {
        type: 'SHOT_CREATED',
        payload: {
          shotId: asString(data.shotId),
          sceneId: asString(data.sceneId),
          orderIndex: asNumber(data.orderIndex),
        },
      };

    case 'generation.image:progress':
      return {
        type: 'IMAGE_PROGRESS',
        payload: {
          shotId: asString(data.shotId),
          status: asShotStatus(data.status),
          thumbnailUrl: asOptionalString(data.thumbnailUrl),
          previewThumbnailUrl: asOptionalString(data.previewThumbnailUrl),
          retry: asRetryInfo(data),
        },
      };

    case 'generation.video:progress':
      return {
        type: 'VIDEO_PROGRESS',
        payload: {
          shotId: asString(data.shotId),
          status: asShotStatus(data.status),
          videoUrl: asOptionalString(data.videoUrl),
          retry: asRetryInfo(data),
        },
      };

    case 'generation.complete':
      return {
        type: 'COMPLETE',
        payload: { sequenceId: asString(data.sequenceId) },
      };

    case 'generation.failed':
      return {
        type: 'FAILED',
        payload: { message: asString(data.message) },
      };

    case 'generation.reservation:short':
      return {
        type: 'FAILED',
        payload: {
          message: `Not enough credits to generate images for ${asNumber(data.sceneCount)} scenes.`,
        },
      };

    case 'generation.error':
      return {
        type: 'ERROR',
        payload: {
          message: asString(data.message),
          phase: asOptionalNumber(data.phase),
        },
      };

    case 'generation.talent:matched':
      // Trust that the realtime schema enforces proper structure
      return {
        type: 'TALENT_MATCHED',
        payload: {
          matches: (Array.isArray(data.matches) ? data.matches : []).map(
            (m: Record<string, unknown>) => ({
              characterId: asString(m.characterId),
              characterName: asString(m.characterName),
              talentId: asString(m.talentId),
              talentName: asString(m.talentName),
            })
          ),
        },
      };

    case 'generation.talent:unmatched':
      return {
        type: 'TALENT_UNMATCHED',
        payload: {
          unusedTalentIds: Array.isArray(data.unusedTalentIds)
            ? data.unusedTalentIds.map(asString)
            : [],
          unusedTalentNames: Array.isArray(data.unusedTalentNames)
            ? data.unusedTalentNames.map(asString)
            : [],
        },
      };

    case 'generation.location:matched':
      return {
        type: 'LOCATION_MATCHED',
        payload: {
          matches: (Array.isArray(data.matches) ? data.matches : []).map(
            (m: Record<string, unknown>) => ({
              locationId: asString(m.locationId),
              libraryLocationId: asString(m.libraryLocationId),
              libraryLocationName: asString(m.libraryLocationName),
              referenceImageUrl: asString(m.referenceImageUrl),
              description: asOptionalString(m.description),
            })
          ),
        },
      };

    case 'generation.preview:replaced':
      return {
        type: 'PREVIEW_REPLACED',
        payload: { newSceneCount: asNumber(data.newSceneCount) },
      };

    default:
      return null;
  }
}

/**
 * Hook for subscribing to real-time generation events for a sequence.
 *
 * @param sequenceId - The sequence ID to subscribe to
 * @param enabled - Whether to enable the subscription (default: true)
 * @returns Generation stream state with scenes, shots, and phase progress
 *
 * @example
 * ```tsx
 * const { state, status, reset } = useGenerationStream(sequenceId, {
 *   enabled: sequence.status === 'processing',
 * });
 *
 * // Show progress indicator
 * <PhaseIndicator phases={state.phases} currentPhase={state.currentPhase} />
 *
 * // Show streaming scenes
 * {state.scenes.map((scene) => (
 *   <SceneCard key={scene.sceneId} scene={scene} />
 * ))}
 * ```
 */
export function useGenerationStream(
  sequenceId: string,
  phaseConfig?: GenerationPhaseConfig,
  options?: { replayHistory?: boolean }
) {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(
    generationStreamReducer,
    phaseConfig,
    createInitialState
  );
  const replayHistory = options?.replayHistory ?? true;
  const { data: user } = useUser();

  // Handle incoming events
  const handleEvent = useCallback(
    (event: GenerationEvent) => {
      const { event: eventName, data } = event;

      // Update TanStack Query cache for data-related events
      updateQueryCacheFromEvent(queryClient, sequenceId, eventName, data);

      // Live-only (history replay does not use this handler). Tell the user
      // the still is being retried from a rewritten prompt, and that the
      // original is still in Versions.
      if (
        eventName === 'generation.image:progress' &&
        data.promptSoftened === true
      ) {
        toast.info('Prompt rewritten to pass a content checker', {
          description: 'The original is kept in Versions.',
        });
      }
      if (
        eventName === 'generation.image:progress' &&
        data.modelFallback === true
      ) {
        toast.info('Retrying on Grok Imagine after the content checker', {
          description: 'The selected model is kept in Versions.',
        });
      }
      // reservation:short is a top-up prompt, not a failure toast (#1328).
      // The scenes banner is the persistent CTA.

      // Map event to typed action and dispatch
      const action = mapEventToAction(eventName, data);
      if (action) {
        dispatch(action);
      }
    },
    [queryClient, sequenceId]
  );

  // Replay channel history on mount so progress survives page refresh.
  // The realtime client doesn't replay past events on reconnect, so we fetch
  // all events from server-side history and replay them through the reducer.
  // Skipped when replayHistory is false (e.g., sequence already complete) to
  // avoid briefly flashing progress UI from old events on tab re-mount.
  useEffect(() => {
    if (!replayHistory || !user) return;
    getChannelHistoryFn({ data: { channel: sequenceId } })
      .then((events: { event: string; data: string }[]) => {
        for (const evt of events) {
          try {
            const parsed = JSON.parse(evt.data);
            const action = mapEventToAction(evt.event, parsed);
            if (action) dispatch(action);
          } catch (e) {
            logger.error(`Failed to parse history event "${evt.event}":`, {
              err: e,
            });
          }
        }
      })
      .catch((error: Error) => {
        logger.error(`Failed to fetch history for "${sequenceId}":`, {
          err: error,
        });
      });
  }, [sequenceId, replayHistory, user]);

  // Subscribe to realtime events for live updates.
  const { status } = useRealtime({
    channels: [sequenceId],
    events: [
      'generation.phase:start',
      'generation.phase:complete',
      'generation.scene:new',
      'generation.scene:updated',
      'generation.shot:created',
      'generation.shot:updated',
      'generation.image:progress',
      'generation.video:progress',
      'generation.audio:progress',
      'generation.variant-image:progress',
      'generation.talent:matched',
      'generation.talent:unmatched',
      'generation.location:matched',
      'generation.character-sheet:progress',
      'generation.poster:ready',
      'generation.style:ready',
      'generation.preview:replaced',
      'generation.stale:detected',
      'generation.complete',
      'generation.failed',
      'generation.reservation:short',
      'generation.updated',
      'generation.error',
    ] as const,
    onData: handleEvent,
    enabled: true,
  });

  const reset = useCallback(() => {
    dispatch({ type: 'RESET' });
  }, []);

  return {
    state,
    status,
    reset,
  };
}
