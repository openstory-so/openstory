import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHOT_PREVIEW_IMAGE_MODEL } from '@/models/models';
import { simpleHash } from '@/platform/hash';
import { frameVariantFixture } from '@/mocks/frame-fixtures';
import {
  buildPreviewPrompt,
  previewTextForShot,
} from '@/sequences/server/poster-prompt';
import type { ShotContext } from '@/shots/shot-access.fn';
import type { StoredShotSpec } from '@/shots/shot-list.schema';
import { asStub } from '@/test/as-stub';

const mocks = vi.hoisted(() => ({ trigger: vi.fn() }));
vi.mock('@/platform/server/workflow/client', () => ({
  triggerWorkflow: mocks.trigger,
}));
vi.mock('@/billing/server/fal-pricing-live', () => ({
  getEffectiveFalPricing: vi.fn(async () => ({})),
}));
import { drawSpecSketch, readShotStoryboard } from './shot-preview';

const SPEC = asStub<StoredShotSpec>({
  framing: {
    shotSize: 'Wide shot',
    angle: 'Eye level',
    composition: '',
    subjectStartState: 'Mara at the door',
  },
  action: 'Mara crosses the hall',
  cameraMovement: { move: 'Push in', pacing: 'slow' },
  direction: '',
});
const PROMPT = buildPreviewPrompt(
  previewTextForShot(
    {
      shots: [{ ...SPEC, shotNumber: 1 }],
      originalScript: { extract: '' },
      metadata: { title: '', location: '', timeOfDay: '' },
    },
    1
  ),
  []
);
const listPreviews = vi.fn();
const listByShot = vi.fn();
const hasEnoughCredits = vi.fn();

const contextFor = (useStartFrame: boolean, selectedSpecVersionId = 'spec-2') =>
  // only the fields read by this helper are needed in the fixture
  asStub<ShotContext>({
    shot: { id: 'shot-1', useStartFrame, selectedSpecVersionId },
    frame: { id: 'frame-1' },
    sequence: {
      id: 'sequence-1',
      generateStartFrames: false,
      aspectRatio: '16:9',
    },
    user: { id: 'user-1' },
    organizationId: 'org-1',
    scene: null,
    scopedDb: {
      characters: { list: vi.fn(async () => []) },
      frameVariants: { listPreviews },
      shotSpecVersions: { listByShot },
      shotPromptVersions: { getSelectedMotion: vi.fn(async () => null) },
      apiKeys: { hasUsableKey: vi.fn(async () => false) },
      billing: { hasEnoughCredits },
    },
  });

const sketch = (
  overrides: Partial<ReturnType<typeof frameVariantFixture>> = {}
) =>
  frameVariantFixture({
    frameId: 'frame-1',
    sequenceId: 'sequence-1',
    kind: 'preview',
    url: '/r2/sketch.png',
    promptHash: simpleHash(PROMPT),
    ...overrides,
  });

beforeEach(() => {
  vi.clearAllMocks();
  listPreviews.mockResolvedValue([]);
  listByShot.mockResolvedValue([]);
  hasEnoughCredits.mockResolvedValue(true);
  mocks.trigger.mockResolvedValue('run-1');
});

describe('drawSpecSketch', () => {
  it.each([false, true])(
    'draws the spec and stamps its version (start frame: %s)',
    async (useStartFrame) => {
      await drawSpecSketch(contextFor(useStartFrame), {
        id: 'spec-2',
        spec: SPEC,
      });
      expect(mocks.trigger).toHaveBeenCalledWith(
        '/image',
        expect.objectContaining({
          prompt: PROMPT,
          model: SHOT_PREVIEW_IMAGE_MODEL,
          frameId: 'frame-1',
          skipStorage: true,
          specVersionId: 'spec-2',
        }),
        undefined
      );
    }
  );

  it('does not draw a version twice from the same prompt', async () => {
    listPreviews.mockResolvedValue([sketch({ specVersionId: 'spec-2' })]);
    await drawSpecSketch(contextFor(false), { id: 'spec-2', spec: SPEC });
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it('spends nothing and keeps the edit when credits run out', async () => {
    hasEnoughCredits.mockResolvedValue(false);
    await expect(
      drawSpecSketch(contextFor(false), { id: 'spec-2', spec: SPEC })
    ).resolves.toBeUndefined();
    expect(mocks.trigger).not.toHaveBeenCalled();
  });
});

describe('readShotStoryboard', () => {
  const t0 = new Date('2026-11-10T00:00:00Z');
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
  const version = (id: string, source: string, minutes: number) => ({
    id,
    shotId: 'shot-1',
    spec: SPEC,
    source,
    inputHash: null,
    createdAt: at(minutes),
    createdBy: null,
  });

  it('pairs each version with its sketch; scene split reads as analysis', async () => {
    const split = sketch({ id: 'split', createdAt: at(0) });
    const edited = sketch({
      id: 'edited',
      specVersionId: 'spec-2',
      createdAt: at(30),
    });
    listPreviews.mockResolvedValue([edited, split]);
    listByShot.mockResolvedValue([
      version('spec-2', 'edit', 30),
      version('spec-1', 'analysis', 2),
    ]);
    const board = await readShotStoryboard(contextFor(true));
    expect(board.versions.map((v) => [v.id, v.sketch?.id])).toEqual([
      ['spec-2', 'edited'],
      ['spec-1', 'split'],
    ]);
    expect(board.current?.id).toBe('edited');
    expect(board.staleReason).toBeNull();
  });

  it('shows the old sketch, stale, until the selected version has one', async () => {
    listPreviews.mockResolvedValue([
      sketch({ id: 'old', specVersionId: 'spec-1' }),
    ]);
    listByShot.mockResolvedValue([
      version('spec-2', 'edit', 30),
      version('spec-1', 'analysis', 2),
    ]);
    const board = await readShotStoryboard(contextFor(false));
    expect(board.current?.id).toBe('old');
    expect(board.staleReason).toBe('changed');
    expect(board.versions[0]?.sketch).toBeNull();
  });
});
