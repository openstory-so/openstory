/**
 * Reducer for managing real-time generation stream state.
 * Handles events from the Upstash Realtime channel during storyboard generation.
 */

import {
  bannerStagesForStopAt,
  GENERATION_STAGE_META,
  GENERATION_STAGES,
  resolveStopAt,
  sliderStopLabel,
  type GenerationStage,
} from '@/lib/generation/pipeline';

// 'cancelled' (#1108) is video-only in practice; it behaves as a terminal
// status here (clears 'generating') like completed/failed.
type ShotStatus =
  | 'pending'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'cancelled';

type StreamingScene = {
  sceneId: string;
  sceneNumber: number;
  title: string;
  scriptExtract: string;
  durationSeconds: number;
};

type StreamingShot = {
  shotId: string;
  sceneId: string;
  orderIndex: number;
  imageStatus: ShotStatus;
  videoStatus: ShotStatus;
  thumbnailUrl?: string;
  previewThumbnailUrl?: string;
  videoUrl?: string;
};

type TalentMatch = {
  characterId: string;
  characterName: string;
  talentId: string;
  talentName: string;
};

type LocationMatch = {
  locationId: string;
  libraryLocationId: string;
  libraryLocationName: string;
  referenceImageUrl: string;
  description?: string;
};

type UnusedTalent = {
  ids: string[];
  names: string[];
};

/**
 * Which attempt a retrying generation is on, for the "Retrying (N/M)…" overlay.
 * `maxAttempts` is omitted when the emitter relies on Cloudflare's default
 * per-step retry budget (image side, #881) and so has no fixed denominator —
 * the overlay then shows a bare "Retrying…".
 */
type ShotRetryInfo = {
  attempt: number;
  maxAttempts?: number;
};

/**
 * In-flight retry state for a shot (#882). A shot can be mid-retry on its
 * image and/or its video independently; each key is cleared on the next
 * non-retry update for that artifact (terminal or a fresh first attempt).
 */
type ShotRetryState = {
  image?: ShotRetryInfo;
  video?: ShotRetryInfo;
};

export type GenerationPhase = {
  phase: number;
  phaseName: string;
  shortName: string;
  status: 'pending' | 'active' | 'completed';
};

export type GenerationStreamState = {
  /** Current generation phase (1-5) */
  currentPhase: number;
  /** All phases with their status */
  phases: GenerationPhase[];
  /** Scenes received during streaming */
  scenes: StreamingScene[];
  /** Shots with their generation status */
  shots: Map<string, StreamingShot>;
  /** Whether generation is complete */
  isComplete: boolean;
  /** Whether generation failed */
  isFailed: boolean;
  /** Error message if generation failed */
  error?: string;
  /** Talent matched to characters during generation */
  talentMatches: TalentMatch[];
  /** Location matched during generation */
  locationMatches: LocationMatch[];
  /** Talent that weren't matched to any character */
  unusedTalent: UnusedTalent | null;
  /** Per-shot in-flight retry state (#882), keyed by shotId */
  shotRetries: Map<string, ShotRetryState>;
};

export type GenerationStreamAction =
  | {
      type: 'PHASE_START';
      payload: { phase: number; phaseName: string };
    }
  | { type: 'PHASE_COMPLETE'; payload: { phase: number } }
  | { type: 'SCENE_NEW'; payload: StreamingScene }
  | { type: 'SCENE_UPDATED'; payload: StreamingScene }
  | {
      type: 'SHOT_CREATED';
      payload: { shotId: string; sceneId: string; orderIndex: number };
    }
  | {
      type: 'IMAGE_PROGRESS';
      payload: {
        shotId: string;
        status?: ShotStatus;
        thumbnailUrl?: string;
        previewThumbnailUrl?: string;
        /** Set while a retry attempt is starting (#882); cleared otherwise. */
        retry?: ShotRetryInfo;
      };
    }
  | {
      type: 'VIDEO_PROGRESS';
      payload: {
        shotId: string;
        status?: ShotStatus;
        videoUrl?: string;
        /** Set while a retry attempt is starting (#882); cleared otherwise. */
        retry?: ShotRetryInfo;
      };
    }
  | { type: 'COMPLETE'; payload: { sequenceId: string } }
  | { type: 'FAILED'; payload: { message: string } }
  | { type: 'ERROR'; payload: { message: string; phase?: number } }
  | { type: 'TALENT_MATCHED'; payload: { matches: TalentMatch[] } }
  | {
      type: 'TALENT_UNMATCHED';
      payload: { unusedTalentIds: string[]; unusedTalentNames: string[] };
    }
  | { type: 'LOCATION_MATCHED'; payload: { matches: LocationMatch[] } }
  | { type: 'PREVIEW_REPLACED'; payload: { newSceneCount: number } }
  | { type: 'RESET' };

export type GenerationPhaseConfig = {
  stopAt?: GenerationStage;
  autoGenerateMotion?: boolean;
  autoGenerateMusic?: boolean;
  /**
   * Straight-to-video: no shot-images stage. Reference-only renders straight
   * to video, so the images stage never runs and its motion prompts are
   * folded into references alongside the sheets. The step is DROPPED rather
   * than relabelled: it has no work left of its own, and a chip that only
   * ever waits is one the user watches for no reason.
   */
  referenceOnly?: boolean;
};

/**
 * Apply a retry signal (or its absence) to the per-shot retry map for one
 * artifact. A present `retry` records the in-flight attempt; any non-retry
 * update (terminal status, or a fresh first attempt) clears it. Returns the
 * same map reference when nothing changes so the reducer can no-op.
 */
function updateShotRetries(
  map: Map<string, ShotRetryState>,
  shotId: string,
  artifact: 'image' | 'video',
  retry: ShotRetryInfo | undefined
): Map<string, ShotRetryState> {
  const current = map.get(shotId);

  if (retry) {
    const next = new Map(map);
    next.set(shotId, { ...current, [artifact]: retry });
    return next;
  }

  // No retry on this update — clear any prior retry state for this artifact.
  if (!current?.[artifact]) return map;
  const next = new Map(map);
  const updated: ShotRetryState = { ...current };
  delete updated[artifact];
  if (updated.image || updated.video) {
    next.set(shotId, updated);
  } else {
    next.delete(shotId);
  }
  return next;
}

export function createInitialState(
  config?: GenerationPhaseConfig
): GenerationStreamState {
  const stopAt = resolveStopAt(config ?? {});
  const combinedMusic = stopAt === 'music';
  const phases: GenerationPhase[] = bannerStagesForStopAt(stopAt)
    .filter((stage) => !(config?.referenceOnly && stage === 'images'))
    .map((stage) => {
      const meta = GENERATION_STAGE_META[stage];
      const isCombinedLast = combinedMusic && stage === 'motion';
      return {
        phase: meta.phase,
        phaseName: isCombinedLast ? 'Generating motion & music…' : meta.name,
        shortName: isCombinedLast ? 'Music & Motion' : meta.shortName,
        status: 'pending' as const,
      };
    });

  return {
    currentPhase: 0,
    phases,
    scenes: [],
    shots: new Map(),
    isComplete: false,
    isFailed: false,
    talentMatches: [],
    locationMatches: [],
    unusedTalent: null,
    shotRetries: new Map(),
  };
}

const initialGenerationStreamState: GenerationStreamState =
  createInitialState();

export function generationStreamReducer(
  state: GenerationStreamState,
  action: GenerationStreamAction
): GenerationStreamState {
  switch (action.type) {
    case 'PHASE_START': {
      const { phase, phaseName } = action.payload;

      // Ignore backwards phase transitions (prevents flickering from out-of-order events)
      if (phase < state.currentPhase) {
        return state;
      }

      const updatedPhases = state.phases.map((p) =>
        p.phase === phase
          ? { ...p, phaseName, status: 'active' as const }
          : p.phase < phase
            ? { ...p, status: 'completed' as const }
            : p
      );

      // Grow the banner for a phase it was not sized for: the phase list is
      // built once from the sequence row, which is not loaded yet on a cold
      // mid-run load, and a Continue runs past the stop-at it was sized for
      // (#1408). Casting rides on the Script phase number, so a Script stop
      // never sprouts a segment.
      if (!updatedPhases.some((p) => p.phase === phase)) {
        const stage = GENERATION_STAGES.find(
          (s) => GENERATION_STAGE_META[s].phase === phase
        );
        updatedPhases.push({
          phase,
          phaseName,
          shortName: stage ? sliderStopLabel(stage) : phaseName,
          status: 'active',
        });
        updatedPhases.sort((a, b) => a.phase - b.phase);
      }

      return { ...state, currentPhase: phase, phases: updatedPhases };
    }

    case 'PHASE_COMPLETE': {
      const { phase } = action.payload;
      return {
        ...state,
        phases: state.phases.map((p) =>
          p.phase === phase ? { ...p, status: 'completed' } : p
        ),
      };
    }

    case 'SCENE_NEW': {
      // Check if scene already exists to avoid duplicates
      const exists = state.scenes.some(
        (s) => s.sceneId === action.payload.sceneId
      );
      if (exists) return state;

      return {
        ...state,
        scenes: [...state.scenes, action.payload],
      };
    }

    case 'SCENE_UPDATED': {
      const idx = state.scenes.findIndex(
        (s) => s.sceneId === action.payload.sceneId
      );
      if (idx === -1) return state;
      const updated = [...state.scenes];
      updated[idx] = action.payload;
      return { ...state, scenes: updated };
    }

    case 'SHOT_CREATED': {
      const { shotId, sceneId, orderIndex } = action.payload;
      const newShots = new Map(state.shots);
      newShots.set(shotId, {
        shotId,
        sceneId,
        orderIndex,
        imageStatus: 'pending',
        videoStatus: 'pending',
      });
      return {
        ...state,
        shots: newShots,
      };
    }

    case 'IMAGE_PROGRESS': {
      const { shotId, status, thumbnailUrl, previewThumbnailUrl, retry } =
        action.payload;
      // Retry state is tracked independently of the shots map so it surfaces
      // even when regenerating an existing shot (no preceding SHOT_CREATED).
      const shotRetries = updateShotRetries(
        state.shotRetries,
        shotId,
        'image',
        retry
      );
      const shot = state.shots.get(shotId);
      if (!shot) {
        return shotRetries === state.shotRetries
          ? state
          : { ...state, shotRetries };
      }

      const newShots = new Map(state.shots);
      newShots.set(shotId, {
        ...shot,
        imageStatus: status ?? shot.imageStatus,
        thumbnailUrl: thumbnailUrl ?? shot.thumbnailUrl,
        previewThumbnailUrl: previewThumbnailUrl ?? shot.previewThumbnailUrl,
      });
      return {
        ...state,
        shots: newShots,
        shotRetries,
      };
    }

    case 'VIDEO_PROGRESS': {
      const { shotId, status, videoUrl, retry } = action.payload;
      const shotRetries = updateShotRetries(
        state.shotRetries,
        shotId,
        'video',
        retry
      );
      const shot = state.shots.get(shotId);
      if (!shot) {
        return shotRetries === state.shotRetries
          ? state
          : { ...state, shotRetries };
      }

      const newShots = new Map(state.shots);
      newShots.set(shotId, {
        ...shot,
        ...(status !== undefined && { videoStatus: status }),
        videoUrl: videoUrl ?? shot.videoUrl,
      });
      return {
        ...state,
        shots: newShots,
        shotRetries,
      };
    }

    case 'COMPLETE':
      return {
        ...state,
        isComplete: true,
        currentPhase: state.phases.length + 1, // Beyond last phase so all marked complete
        phases: state.phases.map((p) => ({ ...p, status: 'completed' })),
      };

    case 'FAILED':
      return {
        ...state,
        isFailed: true,
        error: action.payload.message,
      };

    case 'ERROR':
      return {
        ...state,
        error: action.payload.message,
      };

    case 'TALENT_MATCHED':
      return {
        ...state,
        talentMatches: action.payload.matches,
      };

    case 'TALENT_UNMATCHED':
      return {
        ...state,
        unusedTalent: {
          ids: action.payload.unusedTalentIds,
          names: action.payload.unusedTalentNames,
        },
      };

    case 'LOCATION_MATCHED':
      return {
        ...state,
        locationMatches: action.payload.matches,
      };

    case 'PREVIEW_REPLACED':
      // Clear shot state when preview shots are replaced by AI-analyzed shots
      return {
        ...state,
        scenes: [],
        shots: new Map(),
        shotRetries: new Map(),
      };

    case 'RESET':
      return initialGenerationStreamState;

    default:
      return state;
  }
}
