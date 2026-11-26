/**
 * The `openstory` TanStack AI adapters (docs/architecture/model-gateway.md
 * § The openstory adapter). `modelOptions` is the provider's own body, sent
 * as it is; the transport holds, runs, stores and charges.
 */

import type { GatewayJobInput, GatewayJobOutput } from '@/gateway/schema';
import type {
  AudioGenerationOptions,
  AudioGenerationResult,
  ImageGenerationOptions,
  ImageGenerationResult,
  VideoGenerationOptions,
  VideoJobResult,
  VideoStatusResult,
  VideoUrlResult,
} from '@tanstack/ai';
import {
  BaseAudioAdapter,
  BaseImageAdapter,
  BaseVideoAdapter,
  type DurationOptions,
} from '@tanstack/ai/adapters';
import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';

type GatewaySubmitted =
  | { kind: 'queued'; handle: string }
  // `jobId`: the gateway job that charged it; null on a transport that holds no job (an own key).
  | { kind: 'done'; jobId: string | null; outputs: GatewayJobOutput[] };

type GatewayPollResult =
  | { kind: 'pending' }
  | { kind: 'failed'; error: string }
  | { kind: 'done'; outputs: GatewayJobOutput[] };

/** One poll; the poll that sees the job finish stores and charges it. */
export type GatewayPoller = {
  poll: (handle: string) => Promise<GatewayPollResult>;
};

/** The seam between the adapter and where the gateway runs: in-process today, HTTP for a self-hosted install (#2438). */
export type GatewayTransport = GatewayPoller & {
  /** Hold and start under the call's key; a provider that answers at once is stored and charged here. */
  submit: (
    body: GatewayJobInput,
    idempotencyKey: string
  ) => Promise<GatewaySubmitted>;
};

/** Replay-stable per call, e.g. `${instanceId}:${stepName}`: a retried step reuses the job and its hold. */
type GatewayCall = { idempotencyKey: string };

type Submit = (body: GatewayJobInput) => Promise<GatewaySubmitted>;

const POLL_INTERVAL_MS = 3_000;
const DONE = 'done:';
const outputsSchema = z.array(
  z.object({ url: z.string(), path: z.string(), contentType: z.string() })
);
const doneSchema = z.object({
  jobId: z.string().nullable(),
  outputs: outputsSchema,
});

/** A video job that answered at submit: its gateway job and stored outputs; null for a queued handle. */
export function doneVideoJob(handle: string) {
  return handle.startsWith(DONE)
    ? doneSchema.parse(JSON.parse(handle.slice(DONE.length)))
    : null;
}

/** The body is `modelOptions`. TanStack's normalised fields are refused: the gateway never builds a body. */
function bodyOf(options: {
  modelOptions?: GatewayJobInput;
  size?: string;
  duration?: string | number;
  numberOfImages?: number;
}): GatewayJobInput {
  const normalised = (['size', 'duration', 'numberOfImages'] as const).filter(
    (field) => options[field] !== undefined
  );
  if (normalised.length > 0) {
    throw new NonRetryableError(
      `Put ${normalised.join(', ')} in the provider's body (modelOptions)`
    );
  }
  if (!options.modelOptions) {
    throw new NonRetryableError(
      "The provider's body (modelOptions) is required"
    );
  }
  return options.modelOptions;
}

/** Submit and poll until done, in this call: images and audio answer in seconds. */
export async function runGatewayToEnd(
  transport: GatewayTransport,
  call: GatewayCall,
  body: GatewayJobInput,
  signal?: AbortSignal
): Promise<{ outputs: GatewayJobOutput[] }> {
  const submitted = await transport.submit(body, call.idempotencyKey);
  if (submitted.kind === 'done') return submitted;
  for (;;) {
    signal?.throwIfAborted();
    const polled = await transport.poll(submitted.handle);
    if (polled.kind === 'done') return polled;
    if (polled.kind === 'failed') throw new NonRetryableError(polled.error);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

class OpenstoryImageAdapter extends BaseImageAdapter<string, GatewayJobInput> {
  readonly name = 'openstory';
  constructor(
    model: string,
    private readonly transport: GatewayTransport,
    private readonly call: GatewayCall
  ) {
    super(model);
  }

  async generateImages(
    options: ImageGenerationOptions<GatewayJobInput>
  ): Promise<ImageGenerationResult> {
    options.logger.request('openstory.generateImages', { model: this.model });
    const { outputs } = await runGatewayToEnd(
      this.transport,
      this.call,
      bodyOf(options),
      options.abortSignal
    );
    return {
      id: this.generateId(),
      model: this.model,
      images: outputs.map((output) => ({ url: output.url })),
    };
  }
}

class OpenstoryAudioAdapter extends BaseAudioAdapter<string, GatewayJobInput> {
  readonly name = 'openstory';
  constructor(
    model: string,
    private readonly transport: GatewayTransport,
    private readonly call: GatewayCall
  ) {
    super(model);
  }

  async generateAudio(
    options: AudioGenerationOptions<GatewayJobInput>
  ): Promise<AudioGenerationResult> {
    options.logger.request('openstory.generateAudio', { model: this.model });
    const { outputs } = await runGatewayToEnd(
      this.transport,
      this.call,
      bodyOf(options),
      options.abortSignal
    );
    const [output, ...rest] = outputs;
    if (!output || rest.length > 0) {
      throw new NonRetryableError(
        `Expected one audio file, got ${outputs.length}`
      );
    }
    return {
      id: this.generateId(),
      model: this.model,
      audio: { url: output.url, contentType: output.contentType },
    };
  }
}

/**
 * The job id is the transport's handle, or `done:` with the gateway job and
 * its stored outputs when the provider answered at once.
 */
class OpenstoryVideoAdapter extends BaseVideoAdapter<string, GatewayJobInput> {
  readonly name = 'openstory';
  /** What the last poll stored, for the `getVideo` that follows it in the same call. */
  private readonly finished = new Map<string, GatewayJobOutput[]>();

  constructor(
    model: string,
    private readonly poller: GatewayPoller,
    /** Null on an adapter built only to poll. */
    private readonly submit: Submit | null
  ) {
    super(undefined, model);
  }

  async createVideoJob(
    options: VideoGenerationOptions<GatewayJobInput>
  ): Promise<VideoJobResult> {
    options.logger.request('openstory.createVideoJob', { model: this.model });
    if (!this.submit) {
      throw new NonRetryableError(
        'This adapter only polls: build it with openstoryVideo'
      );
    }
    const submitted = await this.submit(bodyOf(options));
    return {
      jobId:
        submitted.kind === 'queued'
          ? submitted.handle
          : `${DONE}${JSON.stringify({ jobId: submitted.jobId, outputs: submitted.outputs })}`,
      model: this.model,
    };
  }

  async getVideoStatus(jobId: string): Promise<VideoStatusResult> {
    if (jobId.startsWith(DONE)) return { jobId, status: 'completed' };
    const polled = await this.poller.poll(jobId);
    if (polled.kind === 'pending') return { jobId, status: 'processing' };
    if (polled.kind === 'failed') {
      return { jobId, status: 'failed', error: polled.error };
    }
    this.finished.set(jobId, polled.outputs);
    return { jobId, status: 'completed' };
  }

  async getVideo(jobId: string): Promise<VideoUrlResult> {
    const outputs = doneVideoJob(jobId)?.outputs ?? this.finished.get(jobId);
    const url = outputs?.[0]?.url;
    if (!url) throw new Error('Ask getVideoStatus first: no stored video');
    return { jobId, url };
  }

  override availableDurations(): DurationOptions<number> {
    return { kind: 'none' };
  }

  override snapDuration(): undefined {
    return undefined;
  }
}

export function openstoryImage(
  model: string,
  transport: GatewayTransport,
  call: GatewayCall
) {
  return new OpenstoryImageAdapter(model, transport, call);
}

/** For the step that creates the video job. */
export function openstoryVideo(
  model: string,
  transport: GatewayTransport,
  call: GatewayCall
) {
  return new OpenstoryVideoAdapter(model, transport, (body) =>
    transport.submit(body, call.idempotencyKey)
  );
}

/** For a step that polls a video job: no model snapshot, key or rights needed. */
export function openstoryVideoStatus(model: string, poller: GatewayPoller) {
  return new OpenstoryVideoAdapter(model, poller, null);
}

export function openstoryAudio(
  model: string,
  transport: GatewayTransport,
  call: GatewayCall
) {
  return new OpenstoryAudioAdapter(model, transport, call);
}
