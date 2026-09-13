/**
 * The visual-prompt LLM only authors 1-shot scenes (#1517). A 2+ shot scene
 * assembles every clip's prompt from its shot-list spec, so the batch spawns
 * nothing for it and returns no scene-level visual for it.
 */

import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { migrateStyleConfigV1ToV2 } from '@/look/style-config';
import type {
  FramePromptBatchWorkflowInput,
  FramePromptWorkflowInput,
} from '@/platform/server/workflow/types';
import type { Scene } from '@/shots/scene-analysis.schema';
import type { ShotSpec } from '@/shots/shot-list.schema';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';

const spawnAndAwaitChild =
  vi.fn<
    (
      step: unknown,
      args: { childId: string; childPayload: FramePromptWorkflowInput }
    ) => Promise<unknown>
  >();
vi.doMock('@/platform/server/workflow/await-child', () => ({
  spawnAndAwaitChild,
}));

const { FramePromptBatchWorkflow } =
  await import('./frame-prompt-batch-workflow');

function spec(shotNumber: number, action: string): ShotSpec {
  return {
    shotNumber,
    framing: {
      shotSize: 'wide',
      angle: 'eye level',
      composition: '',
      subjectStartState: '',
    },
    action,
    cameraMovement: { move: 'static', pacing: 'slow' },
    soundCue: '',
    dialogue: [],
    durationSeconds: 5,
  };
}

function scene(id: string, shots?: ShotSpec[]): Scene {
  return {
    sceneId: id,
    sceneNumber: Number(id.replace(/\D/g, '')),
    originalScript: { extract: `${id} extract`, dialogue: [] },
    metadata: {
      title: id,
      durationSeconds: 10,
      location: '',
      timeOfDay: '',
      storyBeat: '',
    },
    continuity: {
      characterTags: [],
      environmentTag: '',
      colorPalette: '',
      lightingSetup: '',
      styleTag: '',
    },
    ...(shots ? { shots } : {}),
  };
}

class Probe extends FramePromptBatchWorkflow {
  batch(
    event: Readonly<WorkflowEvent<FramePromptBatchWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ) {
    return this.runImpl(event, step, scopedDb);
  }
}

describe('FramePromptBatchWorkflow multi-shot scenes (#1517)', () => {
  test('LLM-authors the 1-shot scene only', async () => {
    spawnAndAwaitChild.mockReset();
    spawnAndAwaitChild.mockImplementation(
      (_step: unknown, args: { childId: string }) =>
        Promise.resolve({
          sceneId: args.childId.split(':').at(-1) ?? '',
          visual: { fullPrompt: 'authored' },
        })
    );

    const payload: FramePromptBatchWorkflowInput = {
      userId: 'u1',
      teamId: 't1',
      sequenceId: 'seq_1',
      scenes: [
        scene('scene_1', [spec(1, 'looks up')]),
        scene('scene_2', [spec(1, 'opens the door'), spec(2, 'walks in')]),
      ],
      aspectRatio: '16:9',
      characterBible: [],
      locationBible: [],
      elementBible: [],
      styleConfig: migrateStyleConfigV1ToV2({
        mood: 'tense',
        artStyle: 'cinematic',
        lighting: 'soft',
        colorPalette: ['#111'],
        cameraWork: 'handheld',
        referenceFilms: [],
        colorGrading: 'neutral',
      }),
      analysisModelId: 'anthropic/claude-sonnet-5',
      shotMapping: [
        {
          analysisSceneId: 'scene_1',
          shotId: 'sh-1',
          frameId: 'fr-1',
          shotNumber: 1,
        },
        {
          analysisSceneId: 'scene_2',
          shotId: 'sh-2',
          frameId: 'fr-2',
          shotNumber: 1,
        },
        {
          analysisSceneId: 'scene_2',
          shotId: 'sh-3',
          frameId: 'fr-3',
          shotNumber: 2,
        },
      ],
    };
    type Ctor = ConstructorParameters<typeof Probe>;
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runImpl never reads ctx
    const ctx = undefined as unknown as Ctor[0];
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only FRAME_PROMPT_WORKFLOW is read, and the spawn is mocked
    const env = { FRAME_PROMPT_WORKFLOW: {} } as unknown as Ctor[1];
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runImpl only uses `do`
    const step = {
      do: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
    } as unknown as WorkflowStep;
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runImpl never touches scopedDb
    const scopedDb = {} as unknown as WorkflowScopedDb;

    const result = await new Probe(ctx, env).batch(
      {
        payload,
        instanceId: 'fpb_run_A',
        workflowName: 'frame-prompt-batch',
        timestamp: new Date(0),
      },
      step,
      scopedDb
    );

    expect(spawnAndAwaitChild).toHaveBeenCalledTimes(1);
    expect(spawnAndAwaitChild.mock.calls[0]?.[1].childPayload.shotId).toBe(
      'sh-1'
    );
    expect(Object.keys(result.visualPromptsBySceneId)).toEqual(['scene_1']);
    // Scene order is preserved for the next phase's 1:1 alignments.
    expect(result.scenes.map((s) => s.sceneId)).toEqual(['scene_1', 'scene_2']);
  });
});
