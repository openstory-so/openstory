import { getEnv } from '#env';
import { uploadFile } from '#storage';
import { falCostFromUnits } from '@/billing/server/fal-cost-billing';
import {
  ELEVENLABS_MUSIC_ENDPOINT,
  ELEVENLABS_MUSIC_MODEL,
  estimateMusicCost,
} from '@/billing/elevenlabs-pricing';
import { FAL_GENERATION_TIMEOUT_MS } from '@/models/server/fal-deadline-fetch';
import {
  AUDIO_MODELS,
  DEFAULT_MUSIC_MODEL,
  type AudioModel,
  type AudioModelConfig,
} from '@/models/models';
import {
  elevenLabsAdapterConfig,
  getElevenLabsApiKey,
  isElevenLabsConfigured,
  loadElevenLabsAudio,
} from '@/models/server/elevenlabs-config';
import type { Microdollars } from '@/billing/money';
import { generateId } from '@/platform/id';
import type { CredentialScopedDb } from '@/platform/server/db/scoped-workflow';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { isContentRejectionError } from '@/models/content-rejection';
import { extractFalErrorMessage } from '@/models/fal-error';
import {
  recordMediaGenerationSpan,
  type AIObservabilityMeta,
} from '@/platform/server/observability/ai-otel';
import { generateAudio } from '@tanstack/ai';
import { falAudio } from '@tanstack/ai-fal';

import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'audio', 'music-generation']);

export type GenerateMusicOptions = {
  scopedDb?: CredentialScopedDb;
  /** PostHog LLM-analytics metadata for the generation span. */
  observability?: AIObservabilityMeta;
  /** Style/mood prompt for the music (e.g., "tense orchestral, dark atmosphere") */
  prompt: string;
  /** Comma-separated genre tags (e.g., "orchestral, ambient, cinematic") */
  tags?: string;
  /** Lyrics with [verse], [chorus], [bridge] structure. Use [inst] for instrumental. */
  lyrics?: string;
  /** Duration in seconds (1-240, default: 60) */
  duration?: number;
  /** Generate instrumental only (default: true) */
  instrumental?: boolean;
  model?: AudioModel;
  /** Number of diffusion steps (default: 27) */
  steps?: number;
  /**
   * Native ElevenLabs returns inline bytes, not a URL. Park them in R2
   * before the workflow step returns — Cloudflare Workflows cap `step.do`
   * payloads at 1 MiB, and a 60s MP3 as base64 exceeds that.
   */
  teamId?: string;
  sequenceId?: string;
};

export type MusicResult = {
  success: boolean;
  audioUrl?: string;
  /**
   * R2 object path when native ElevenLabs already parked the bytes.
   * Present so the workflow can skip a second download of a relative `/r2/`
   * URL (Workers `fetch` has no origin to resolve against).
   */
  storagePath?: string;
  metadata: {
    model: string;
    vendor: string;
    /** Provider endpoint submitted to (billing denominator). */
    endpointId: string;
    /** Fal-reported billed unit count. Recorded as a `model_usage_observations`
     * sample (the pricing cron's median reads that table, not the credit
     * ledger) and also spread into the transaction metadata as a billing
     * trail — see `recordFalUsageStep` (#1069). */
    unitsBilled?: number;
    duration: number;
    cost: Microdollars;
    generatedAt: string;
    usedOwnKey: boolean;
  };
  error?: string;
  requestId?: string;
};

function clampDuration(
  requested: number | undefined,
  config: AudioModelConfig
): number {
  if (!requested) return config.capabilities.defaultDuration;
  return Math.min(requested, config.capabilities.maxDuration);
}

type AudioCallShape = {
  prompt: string;
  /**
   * Pass `duration` (seconds) only for models whose API actually accepts a
   * duration field — falAudio maps this to bare `duration` (or the model's
   * own field). Models without a duration parameter (Lyria 2, Minimax Music
   * v2) must omit this or fal will 422.
   */
  duration?: number;
  modelOptions: Record<string, unknown>;
};

type AudioCallBuilder = (
  options: GenerateMusicOptions,
  config: AudioModelConfig
) => AudioCallShape;

/**
 * Per-model builders that turn `GenerateMusicOptions` into the shape required
 * by `generateAudio`. Builders are the source of truth for which fields each
 * fal endpoint actually accepts. Only models that support a `duration` field
 * are included — fixed-length endpoints have been removed from the registry.
 */
const AUDIO_CALL_BUILDERS: Partial<Record<AudioModel, AudioCallBuilder>> = {
  // fal-ai/ace-step/prompt-to-audio: prompt + duration (seconds) + standard CFG knobs.
  ace_step: (options, config) => ({
    prompt: options.tags ?? options.prompt,
    duration: clampDuration(options.duration, config),
    modelOptions: {
      instrumental: options.instrumental ?? true,
      number_of_steps: options.steps ?? 27,
      scheduler: 'euler',
      guidance_type: 'apg',
    },
  }),

  // fal-ai/ace-step-1.5: prompt + lyrics + duration. No `instrumental` flag —
  // per fal docs, the way to force no vocals is `lyrics: '[Instrumental]'`.
  // Leaving `lyrics` empty/unset lets the built-in LM auto-write vocals.
  ace_step_1_5: (options, config) => {
    const isInstrumental = options.instrumental ?? true;
    const lyrics =
      options.lyrics ?? (isInstrumental ? '[Instrumental]' : undefined);
    return {
      prompt: options.tags ?? options.prompt,
      duration: clampDuration(options.duration, config),
      modelOptions: {
        ...(lyrics !== undefined ? { lyrics } : {}),
        ...(options.steps ? { num_inference_steps: options.steps } : {}),
      },
    };
  },
};

/**
 * Generate music/audio via TanStack AI's `generateAudio` activity.
 * ElevenLabs Music goes through `elevenlabsAudio` (#1640); ACE-Step stays
 * on `falAudio`.
 */
export async function generateMusic(
  options: GenerateMusicOptions
): Promise<MusicResult> {
  const modelKey = options.model || DEFAULT_MUSIC_MODEL;
  const modelConfig = AUDIO_MODELS[modelKey];
  const via = modelKey === 'elevenlabs_music' ? 'elevenlabs' : 'fal';

  // Recorded out here rather than as middleware — see
  // recordMediaGenerationSpan.
  const startedAt = Date.now();
  const attribution = {
    ...options.observability,
    // `??` after the spread — see the note in image-generation.ts.
    userId: options.observability?.userId ?? options.scopedDb?.userId,
  };

  try {
    const result =
      via === 'elevenlabs'
        ? await callElevenLabsAudio(options, modelConfig)
        : await callFalAudio(options, modelConfig);
    recordMediaGenerationSpan({
      ...attribution,
      model: modelKey,
      provider: via,
      activity: 'audio',
      durationMs: Date.now() - startedAt,
      costMicros: result.metadata.cost,
      unitsBilled: result.metadata.unitsBilled,
      usedOwnKey: result.metadata.usedOwnKey,
      prompt: options.prompt,
      outputUrl: result.audioUrl,
    });
    return result;
  } catch (error) {
    recordMediaGenerationSpan({
      ...attribution,
      model: modelKey,
      provider: via,
      activity: 'audio',
      durationMs: Date.now() - startedAt,
      prompt: options.prompt,
      errorType: isContentRejectionError(error)
        ? 'content_filter'
        : 'provider_error',
      errorMessage: extractFalErrorMessage(error),
    });
    throw error;
  }
}

/** Same wall-clock budget as fal.subscribe, in the SDK's seconds unit. */
const ELEVENLABS_MUSIC_TIMEOUT_SECONDS = FAL_GENERATION_TIMEOUT_MS / 1000;

async function callElevenLabsAudio(
  options: GenerateMusicOptions,
  modelConfig: AudioModelConfig
): Promise<MusicResult> {
  if (!isElevenLabsConfigured()) {
    throw new Error(
      'ElevenLabs Music requires ELEVENLABS_API_KEY. ACE-Step remains available without it.'
    );
  }

  const billedDuration = clampDuration(options.duration, modelConfig);
  logger.info(`Generating music with model: ${ELEVENLABS_MUSIC_MODEL}`, {
    vendor: modelConfig.vendor,
    promptLength: options.prompt.length,
    duration: billedDuration,
  });

  const apiKeyInfo = options.scopedDb
    ? await options.scopedDb.resolveKey('elevenlabs')
    : (() => {
        const key = getElevenLabsApiKey();
        if (!key) {
          throw new Error(
            'ElevenLabs Music requires ELEVENLABS_API_KEY. ACE-Step remains available without it.'
          );
        }
        return { key, source: 'platform' as const };
      })();

  const adapterConfig = elevenLabsAdapterConfig(
    apiKeyInfo.key,
    ELEVENLABS_MUSIC_TIMEOUT_SECONDS
  );
  const createElevenLabsAudio = await loadElevenLabsAudio();
  const adapter = createElevenLabsAudio(
    ELEVENLABS_MUSIC_MODEL,
    apiKeyInfo.key,
    {
      timeoutInSeconds: adapterConfig.timeoutInSeconds,
      ...(adapterConfig.baseURL && { baseURL: adapterConfig.baseURL }),
    }
  );
  const result = await generateAudio({
    adapter,
    prompt: options.prompt,
    duration: billedDuration,
    modelOptions: {
      forceInstrumental: options.instrumental ?? true,
    },
    timeout: FAL_GENERATION_TIMEOUT_MS,
    debug: false,
  });

  const b64 = result.audio.b64Json;
  if (!b64) {
    logger.error('No audio body in ElevenLabs result:', { result });
    throw new Error('No audio returned from ElevenLabs music generation');
  }

  const parked = await parkNativeMusic(options, b64, result.audio.contentType);
  const unitsBilled = Math.ceil(billedDuration / 60);

  return {
    success: true,
    audioUrl: parked.url,
    storagePath: parked.path,
    requestId: result.id,
    metadata: {
      model: ELEVENLABS_MUSIC_MODEL,
      vendor: modelConfig.vendor,
      endpointId: ELEVENLABS_MUSIC_ENDPOINT,
      unitsBilled,
      duration: billedDuration,
      cost: estimateMusicCost(billedDuration),
      generatedAt: new Date().toISOString(),
      usedOwnKey: false,
    },
  };
}

async function parkNativeMusic(
  options: GenerateMusicOptions,
  b64Json: string,
  contentType: string | undefined
): Promise<{ url: string; path: string }> {
  const bytes = Buffer.from(b64Json, 'base64');
  if (bytes.byteLength === 0) {
    throw new Error('ElevenLabs music generation returned an empty audio body');
  }
  const path = nativeMusicStoragePath(options);
  const uploaded = await uploadFile(STORAGE_BUCKETS.AUDIO, path, bytes, {
    contentType: contentType || 'audio/mpeg',
    upsert: true,
  });
  return { url: uploaded.publicUrl, path };
}

function nativeMusicStoragePath(options: GenerateMusicOptions): string {
  const id = generateId();
  if (options.teamId && options.sequenceId) {
    return `${options.teamId}/${options.sequenceId}/music/${id}.mp3`;
  }
  if (options.teamId) {
    return `${options.teamId}/music/${id}.mp3`;
  }
  return `music/${id}.mp3`;
}

async function callFalAudio(
  options: GenerateMusicOptions,
  modelConfig: AudioModelConfig
): Promise<MusicResult> {
  const modelKey = options.model || DEFAULT_MUSIC_MODEL;
  const builder = AUDIO_CALL_BUILDERS[modelKey];
  if (!builder) {
    throw new Error(`No audio call builder for model: ${modelKey}`);
  }

  const shape = builder(options, modelConfig);
  // For cost estimation, use the builder's duration (models that accept one)
  // or fall back to the requested/default duration (fixed-length models).
  const billedDuration =
    shape.duration ?? clampDuration(options.duration, modelConfig);

  logger.info(`Generating music with model: ${modelConfig.id}`, {
    vendor: modelConfig.vendor,
    promptLength: shape.prompt.length,
    duration: shape.duration ?? '(fixed by model)',
  });

  const falApiKeyInfo = options.scopedDb
    ? await options.scopedDb.resolveKey('fal')
    : { key: getEnv().FAL_KEY, source: 'platform' as const };

  const adapter = falAudio(modelConfig.id, { apiKey: falApiKeyInfo.key });
  // Bound so a hung fal.subscribe fails the workflow step and CF can retry
  // (#826). Native activity `timeout` since @tanstack/ai@0.44 / ai-fal@0.10.
  const result = await generateAudio({
    adapter,
    prompt: shape.prompt,
    duration: shape.duration,
    modelOptions: shape.modelOptions,
    timeout: FAL_GENERATION_TIMEOUT_MS,
    debug: false,
  });

  if (!result.audio.url) {
    logger.error('No audio URL in result:', { result });
    throw new Error('No audio URL returned from music generation');
  }

  // Exact cost from fal's reported billed units.
  const cost = await falCostFromUnits(
    modelConfig.id,
    result.usage?.unitsBilled
  );

  return {
    success: true,
    audioUrl: result.audio.url,
    requestId: result.id,
    metadata: {
      model: modelConfig.id,
      vendor: modelConfig.vendor,
      endpointId: modelConfig.id,
      unitsBilled: result.usage?.unitsBilled,
      duration: billedDuration,
      cost,
      generatedAt: new Date().toISOString(),
      usedOwnKey: falApiKeyInfo.source === 'team',
    },
  };
}
