/**
 * Blast-radius test for the preview-image fan-out (#1149).
 *
 * `scene-split` fires one decorative preview image per shot (`skipStorage:
 * true`, nothing downstream reads the result). Before this fix a single one of
 * them throwing — a content-checker hit on ~15% of runs in the #1143 load test
 * — failed `scene-splitting-stream`, and with it `scene-split` →
 * `analyze-script` → the whole sequence, discarding every still that had
 * already rendered and been paid for.
 *
 * The contract asserted here: previews are attempted for every shot, a failing
 * one is swallowed, and the split still returns its scenes and shot mapping.
 *
 * Plus the streaming-parse contract (#1161): the accumulated buffer is parsed
 * on a coalesced schedule rather than once per delta, and the final chunk is
 * always parsed.
 */

import { SCENE_SPLIT_MODEL } from '@/lib/ai/models.config';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepConfig,
} from 'cloudflare:workers';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { SceneSplittingScene } from '@/lib/ai/streaming-scene-parser';
import type { SceneSplitWorkflowInput } from '@/lib/workflow/types';

const triggerWorkflow =
  vi.fn<(path: string, body: unknown, options?: unknown) => Promise<string>>();
vi.doMock('@/lib/workflow/client', () => ({ triggerWorkflow }));

vi.doMock('@/lib/prompts', () => ({
  getChatPrompt: vi.fn(() =>
    Promise.resolve({ messages: [{ role: 'user', content: 'go' }] })
  ),
}));

const emit = vi.fn(() => Promise.resolve());
vi.doMock('@/lib/realtime', () => ({
  getGenerationChannel: vi.fn(() => ({ emit })),
}));

vi.doMock('@/lib/billing/workflow-deduction', () => ({
  deductWorkflowCredits: vi.fn(() => Promise.resolve()),
}));

type StreamChunk = {
  done: boolean;
  accumulated: string;
  parsed?: typeof SCENES_RESULT | typeof BIBLES_RESULT;
  usage?: undefined;
};

/**
 * Chunks the mocked SCENES stream yields. Defaults to a single `done` chunk
 * carrying the whole (already-validated) result; the parser mock below is what
 * turns it into per-scene events. The coalescing test swaps in a long delta
 * stream. The parallel bibles call is served separately (see the llm-client
 * mock, keyed on observationName).
 */
let streamChunks: StreamChunk[] = [];
function singleDoneChunk(): StreamChunk[] {
  return [
    { done: true, accumulated: '{}', parsed: SCENES_RESULT, usage: undefined },
  ];
}

vi.doMock('@/lib/ai/llm-client', () => ({
  PROMPT_REASONING: undefined,
  llmCostFromUsage: vi.fn(() => 0),
  callLLMStream: vi.fn((params: { observationName?: string }) => ({
    async *[Symbol.asyncIterator]() {
      const chunks =
        params.observationName === 'phase-1-scene-bibles'
          ? [
              {
                done: true,
                accumulated: '{}',
                parsed: BIBLES_RESULT,
                usage: undefined,
              },
            ]
          : streamChunks;
      for (const chunk of chunks) yield chunk;
    },
  })),
}));

/**
 * Scenes are emitted on the FIRST feed only. The real parser tracks how many
 * scenes it has already emitted; without that here, a multi-feed stream would
 * re-emit all three every time and inflate the shot mapping.
 */
const feed = vi.fn();
vi.doMock('@/lib/ai/streaming-scene-parser', async () => {
  const real = await vi.importActual('@/lib/ai/streaming-scene-parser');
  return {
    ...real,
    createStreamingSceneParser: () => {
      let emitted = false;
      return {
        feed: (accumulated: string) => {
          feed(accumulated);
          if (emitted) return [];
          emitted = true;
          return SCENES.map((scene, index) => ({
            type: 'scene',
            scene,
            index,
          }));
        },
        mintedSceneIds: () =>
          new Map(SCENES.map((scene, index) => [index, scene.sceneId])),
      };
    },
  };
});

// Dynamic import so the mocks above apply (vi.doMock is not hoisted).
const { SceneSplitWorkflow } = await import('./scene-split-workflow');
const { callLLMStream } = await import('@/lib/ai/llm-client');

function sceneSplittingLlmCalls() {
  return vi
    .mocked(callLLMStream)
    .mock.calls.filter(
      ([params]) => params.observationName === 'phase-1-scene-splitting'
    );
}

function makeScene(n: number): SceneSplittingScene {
  return {
    sceneId: `scene_${n}`,
    sceneNumber: n,
    originalScript: { extract: `Scene ${n} action`, dialogue: [] },
    metadata: {
      title: `Scene ${n}`,
      durationSeconds: 3,
      location: 'A room',
      timeOfDay: 'day',
      storyBeat: 'setup',
    },
    continuity: {
      characterTags: [],
      environmentTag: '',
      elementTags: null,
      colorPalette: '',
      lightingSetup: '',
      styleTag: '',
    },
  };
}

const SCENES = [makeScene(1), makeScene(2), makeScene(3)];

const SCRIPT = 'Scene 1 action\nScene 2 action\nScene 3 action';

const SCENES_RESULT = {
  projectMetadata: { title: 'Test Film' },
  boundaries: [
    { hintLine: 1, quote: 'Scene 1 action' },
    { hintLine: 2, quote: 'Scene 2 action' },
    { hintLine: 3, quote: 'Scene 3 action' },
  ],
};

const BIBLES_RESULT = {
  characterBible: [],
  locationBible: [],
  elementBible: [],
};

const INPUT: SceneSplitWorkflowInput = {
  userId: 'u1',
  teamId: 't1',
  sequenceId: 'seq_1',
  script: SCRIPT,
  modelId: 'anthropic/claude-sonnet-5',
  promptName: 'scene-splitting',
  aspectRatio: '16:9',
  elements: [],
};

function makeScopedDb(): WorkflowScopedDb {
  let shotSeq = 0;
  const shot = () => {
    shotSeq++;
    return { id: `shot_${shotSeq}`, anchorFrameId: `frame_${shotSeq}` };
  };
  const scopedDb = {
    credentials: {
      resolveLlmKey: () =>
        Promise.resolve({ source: 'platform', via: 'env', key: 'k' }),
    },
    liveRead: {
      compliance: {
        listEnforcementFor: () => Promise.resolve([]),
      },
    },
    scenes: {
      upsert: (row: { orderIndex: number }) =>
        Promise.resolve({
          id: `dbscene_${row.orderIndex}`,
          orderIndex: row.orderIndex,
          createdAt: new Date(0),
        }),
      deleteFromOrderIndex: () => Promise.resolve(),
    },
    sceneScriptVersions: { seedSplitVersions: () => Promise.resolve() },
    shots: {
      upsert: () => Promise.resolve(shot()),
      // Reconcile re-derives the mapping; keep ids stable per scene index.
      bulkUpsert: (rows: Array<{ sceneId: string | null }>) =>
        Promise.resolve(
          rows.map((row, index) => ({
            id: `shot_r${index}`,
            anchorFrameId: `frame_r${index}`,
            sceneId: row.sceneId,
          }))
        ),
      update: () => Promise.resolve(true),
      delete: () => Promise.resolve(),
      deleteByScenesFromOrderIndex: () => Promise.resolve(),
    },
    sequences: {
      updateTitle: () => Promise.resolve(),
      updateWorkflow: () => Promise.resolve(),
    },
    sequenceElements: { updateFirstMention: () => Promise.resolve() },
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only the scoped-db surface runImpl touches
  return scopedDb as unknown as WorkflowScopedDb;
}

function makeEvent(): Readonly<WorkflowEvent<SceneSplitWorkflowInput>> {
  // The stub satisfies WorkflowEvent structurally, so no assertion is needed
  // — and asserting anyway now trips no-unnecessary-type-assertion.
  return {
    payload: INPUT,
    instanceId: 'split_run_A',
    workflowName: 'scene-split',
    timestamp: new Date(0),
  };
}

let lastDoMock: ReturnType<typeof vi.fn>;

function makeStep(): WorkflowStep {
  lastDoMock = vi.fn(
    (
      _name: string,
      configOrFn: WorkflowStepConfig | (() => Promise<unknown>),
      maybeFn?: () => Promise<unknown>
    ) => (typeof configOrFn === 'function' ? configOrFn() : maybeFn?.())
  );
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowStep stub: runImpl only uses `do`
  return { do: lastDoMock } as unknown as WorkflowStep;
}

/**
 * Exposes the protected `runImpl` so the split runs without the base class's
 * scoped-db construction and failure handling. Named `split`, not `run` — the
 * base class already owns `run(event, step)`.
 */
class Probe extends SceneSplitWorkflow {
  split(
    event: Readonly<WorkflowEvent<SceneSplitWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ) {
    return this.runImpl(event, step, scopedDb);
  }
}

function makeWorkflow(): Probe {
  type Ctor = ConstructorParameters<typeof Probe>;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- tests construct the entrypoint directly; runImpl never reads ctx
  const ctx = undefined as unknown as Ctor[0];
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal env stub; runImpl never reads bindings
  const env = {} as unknown as Ctor[1];
  return new Probe(ctx, env);
}

const previewCalls = () =>
  triggerWorkflow.mock.calls.filter((call) => call[0] === '/image');

describe('SceneSplitWorkflow preview fan-out', () => {
  beforeEach(() => {
    streamChunks = singleDoneChunk();
    feed.mockReset();
  });

  test('triggers one preview per shot on the happy path', async () => {
    triggerWorkflow.mockReset();
    triggerWorkflow.mockResolvedValue('run_1');

    const result = await makeWorkflow().split(
      makeEvent(),
      makeStep(),
      makeScopedDb()
    );

    expect(previewCalls()).toHaveLength(SCENES.length);
    expect(result.shotMapping).toHaveLength(SCENES.length);
  });

  // The #1149 failure exactly: one preview's ImageWorkflow instance is a
  // tombstone, so its trigger throws `instance.already_exists` forever.
  test('a failing preview does not fail the split', async () => {
    triggerWorkflow.mockReset();
    triggerWorkflow
      .mockResolvedValueOnce('run_1')
      .mockRejectedValueOnce(
        new Error('(instance.already_exists) Instance already exists')
      )
      .mockResolvedValue('run_3');

    const result = await makeWorkflow().split(
      makeEvent(),
      makeStep(),
      makeScopedDb()
    );

    expect(result.title).toBe('Test Film');
    expect(result.shotMapping).toHaveLength(SCENES.length);
  });

  // A swallow that also stopped the fan-out would silently lose every later
  // preview — the remaining shots must still be attempted.
  test('a failing preview does not stop the ones after it', async () => {
    triggerWorkflow.mockReset();
    triggerWorkflow
      .mockRejectedValueOnce(new Error('content checker flagged this prompt'))
      .mockResolvedValue('run_ok');

    await makeWorkflow().split(makeEvent(), makeStep(), makeScopedDb());

    expect(previewCalls()).toHaveLength(SCENES.length);
  });

  test('every preview fails: the split still completes', async () => {
    triggerWorkflow.mockReset();
    triggerWorkflow.mockRejectedValue(new Error('preview generation failed'));

    const result = await makeWorkflow().split(
      makeEvent(),
      makeStep(),
      makeScopedDb()
    );

    expect(result.scenes).toHaveLength(SCENES.length);
  });
});

/**
 * `parser.feed` re-parses the WHOLE accumulated response and re-validates every
 * scene emitted so far, so calling it once per delta is O(n²) — the isolate
 * OOM that failed 2 of 20 sequences in the #1143 load run (#1161).
 */
describe('SceneSplitWorkflow stream parsing', () => {
  const DELTA = 'x'.repeat(4); // one token's worth, as a real stream arrives
  const DELTA_COUNT = 2_000;

  function deltaStream(): StreamChunk[] {
    const chunks: StreamChunk[] = [];
    let accumulated = '';
    for (let i = 0; i < DELTA_COUNT; i++) {
      accumulated += DELTA;
      chunks.push({ done: false, accumulated });
    }
    chunks.push({
      done: true,
      accumulated,
      parsed: SCENES_RESULT,
      usage: undefined,
    });
    return chunks;
  }

  beforeEach(() => {
    triggerWorkflow.mockReset();
    triggerWorkflow.mockResolvedValue('run_1');
    streamChunks = deltaStream();
    feed.mockReset();
  });

  test('coalesces feeds instead of re-parsing on every delta', async () => {
    await makeWorkflow().split(makeEvent(), makeStep(), makeScopedDb());

    const streamedChars = DELTA.length * DELTA_COUNT;
    // One feed per PARSE_COALESCE_CHARS (256) of stream, plus the forced final
    // one — not one per delta. Asserted as a bound, not an exact count, so the
    // threshold can be retuned without rewriting the test.
    expect(feed.mock.calls.length).toBeLessThanOrEqual(streamedChars / 256 + 2);
    expect(feed.mock.calls.length).toBeGreaterThan(1);
  });

  test('always parses the final chunk so a late scene is not dropped', async () => {
    const result = await makeWorkflow().split(
      makeEvent(),
      makeStep(),
      makeScopedDb()
    );

    const lastFeed = feed.mock.calls.at(-1)?.[0];
    expect(lastFeed).toHaveLength(DELTA.length * DELTA_COUNT);
    expect(result.shotMapping).toHaveLength(SCENES.length);
    expect(previewCalls()).toHaveLength(SCENES.length);
  });
});

const DEGRADED_RESULT = {
  ...SCENES_RESULT,
  boundaries: [
    { hintLine: 1, quote: 'Scene 1 action' },
    { hintLine: 2, quote: 'NO SUCH TEXT ANYWHERE, TRULY NOT PRESENT' },
    { hintLine: 3, quote: 'ALSO ABSENT FROM THE SCRIPT ENTIRELY' },
  ],
};

/** Quotes that resolve via the normalized rung (extra spaces), never drop. */
const FUZZY_ONLY_RESULT = {
  ...SCENES_RESULT,
  boundaries: [
    { hintLine: 1, quote: 'Scene  1 action' },
    { hintLine: 2, quote: 'Scene  2 action' },
    { hintLine: 3, quote: 'Scene  3 action' },
  ],
};

describe('SceneSplitWorkflow stream step config', () => {
  beforeEach(() => {
    triggerWorkflow.mockReset();
    triggerWorkflow.mockResolvedValue('run_1');
    streamChunks = singleDoneChunk();
    feed.mockReset();
  });

  test('times the stream step for a first pass plus one repair retry (#1218)', async () => {
    await makeWorkflow().split(makeEvent(), makeStep(), makeScopedDb());

    const streamDo = lastDoMock.mock.calls.find(
      (call) => call[0] === 'scene-splitting-stream'
    );
    expect(streamDo?.[1]).toMatchObject({
      retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
      timeout: '20 minutes',
    });
  });

  test('runs the scenes call on SCENE_SPLIT_MODEL, bibles on the analysis model', async () => {
    await makeWorkflow().split(makeEvent(), makeStep(), makeScopedDb());

    const sceneCall = sceneSplittingLlmCalls()[0]?.[0];
    expect(sceneCall?.model).toBe(SCENE_SPLIT_MODEL);
    const bibleCall = vi
      .mocked(callLLMStream)
      .mock.calls.find(
        ([params]) => params.observationName === 'phase-1-scene-bibles'
      )?.[0];
    expect(bibleCall?.model).toBe(INPUT.modelId);
  });
});

describe('SceneSplitWorkflow degraded boundary retry', () => {
  beforeEach(() => {
    triggerWorkflow.mockReset();
    triggerWorkflow.mockResolvedValue('run_1');
    emit.mockReset();
    vi.mocked(callLLMStream).mockClear();
    streamChunks = [
      {
        done: true,
        accumulated: '{}',
        parsed: DEGRADED_RESULT,
        usage: undefined,
      },
    ];
    feed.mockReset();
  });

  test('does not start a second LLM call when every quote repaired locally (#1218)', async () => {
    streamChunks = [
      {
        done: true,
        accumulated: '{}',
        parsed: FUZZY_ONLY_RESULT,
        usage: undefined,
      },
    ];

    const result = await makeWorkflow().split(
      makeEvent(),
      makeStep(),
      makeScopedDb()
    );

    expect(sceneSplittingLlmCalls()).toHaveLength(1);
    expect(result.scenes).toHaveLength(SCENES.length);
    expect(result.title).toBe('Test Film');
  });

  test('retries when quotes are dropped, then keeps first-pass LLM scenes if still degraded', async () => {
    const result = await makeWorkflow().split(
      makeEvent(),
      makeStep(),
      makeScopedDb()
    );

    expect(sceneSplittingLlmCalls()).toHaveLength(2);
    // Two unresolvable quotes merge into scene 1; the LLM title stays.
    expect(result.scenes).toHaveLength(1);
    expect(result.title).toBe('Test Film');
    const scene = result.scenes[0];
    expect(scene?.originalScript.extract).toBe(SCRIPT);
    expect(scene?.metadata?.title).toBe('Scene 1 action');
    expect(emit).toHaveBeenCalledWith(
      'generation.error',
      expect.objectContaining({
        message: expect.stringMatching(/merged/i),
        phase: 1,
      })
    );
  });
});
