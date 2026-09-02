/**
 * `prepareShotImageWorkflowInput` must not read what it cannot use.
 *
 * The prompt read (`framePromptVersions.getSelected`) and the model reads
 * (`frameVariants.getSelected` / `getLastFailed`) both used to execute
 * unconditionally, including on the fully-overridden path update-stale's
 * chained renders take — results discarded. That is a wasted query AND a live
 * read of a mutable selection pointer, one careless edit away from silently
 * regaining a consumer and reintroducing the mid-run staleness class (#1067).
 *
 * These tests pin BOTH directions: skipped when nothing consumes them, and
 * still executed on every path that does. The second half is the one that
 * catches an over-eager guard — dropping the `promptVersionOverride ===
 * undefined` case would null `promptVersionId` for `generateShotImageFn`.
 */

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import type { Frame, Shot } from '@/lib/db/schema';

vi.doMock('@/lib/ai/fal-pricing-live', () => ({
  getEffectiveFalPricing: async () => ({}),
}));
vi.doMock('@/lib/billing/preflight', () => ({
  requireCredits: async () => undefined,
}));

// Dynamic import so the mocks above apply (vi.doMock is not hoisted).
const { prepareShotImageWorkflowInput } = await import('./shot-image-input');

const FRAME_ID = 'frm_1';

function makeScopedDb() {
  const getSelectedPrompt = vi.fn(async () => ({
    id: 'fpv_selected',
    text: 'Stored prompt',
  }));
  const getSelectedVariant = vi.fn(async () => ({ model: 'flux_2_max' }));
  const getLastFailed = vi.fn(async () => ({ model: 'seedream_v5' }));
  const stub = {
    framePromptVersions: { getSelected: getSelectedPrompt },
    frameVariants: {
      getSelected: getSelectedVariant,
      getLastFailed,
    },
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal stub: the mocks above remove every other scopedDb consumer
  const scopedDb = stub as unknown as Parameters<
    typeof prepareShotImageWorkflowInput
  >[0]['scopedDb'];
  return { scopedDb, getSelectedPrompt, getSelectedVariant, getLastFailed };
}

function baseArgs(scopedDb: ReturnType<typeof makeScopedDb>['scopedDb']) {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only `id` is read off the shot on this path
  const shot = { id: 'sht_1' } as unknown as Shot;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only `id` is read off the frame
  const frame = { id: FRAME_ID } as unknown as Frame;
  return {
    scopedDb,
    sequence: {
      id: 'seq_1',
      teamId: 'team_1',
      aspectRatio: '16:9' as const,
      resolution: '720p' as const,
      imageModel: DEFAULT_IMAGE_MODEL,
      styleId: null,
      analysisModel: 'anthropic/claude-haiku-4.5',
    },
    shot,
    frame,
    scene: null,
    scriptExtract: 'INT. HALLWAY — NIGHT',
    userId: 'usr_1',
    // Sequence-scoped refs supplied, so the bible reads don't run either.
    refs: { characters: [], locations: [], elements: [] },
  };
}

describe('prepareShotImageWorkflowInput skips reads nothing consumes', () => {
  it('a fully-overridden chained render reads neither the prompt nor the variants', async () => {
    const { scopedDb, getSelectedPrompt, getSelectedVariant, getLastFailed } =
      makeScopedDb();

    const input = await prepareShotImageWorkflowInput({
      ...baseArgs(scopedDb),
      promptOverride: 'Prompt resolved by the caller',
      promptVersionOverride: 'fpv_from_caller',
      modelOverride: 'nano_banana_pro',
    });

    expect(getSelectedPrompt).not.toHaveBeenCalled();
    expect(getSelectedVariant).not.toHaveBeenCalled();
    expect(getLastFailed).not.toHaveBeenCalled();
    // And the overrides are what actually land on the payload.
    expect(input.prompt).toBe('Prompt resolved by the caller');
    expect(input.promptVersionId).toBe('fpv_from_caller');
    expect(input.model).toBe('nano_banana_pro');
  });

  it('an explicit null version override still skips the prompt read', async () => {
    // `null` means "this prompt came from no version" — a real answer, not an
    // omission, so there is nothing left to look up.
    const { scopedDb, getSelectedPrompt } = makeScopedDb();

    const input = await prepareShotImageWorkflowInput({
      ...baseArgs(scopedDb),
      promptOverride: 'Prompt resolved by the caller',
      promptVersionOverride: null,
      modelOverride: 'nano_banana_pro',
    });

    expect(getSelectedPrompt).not.toHaveBeenCalled();
    expect(input.promptVersionId).toBeNull();
  });
});

describe('prepareShotImageWorkflowInput still reads what it does consume', () => {
  it('no overrides at all → both reads run and feed the payload', async () => {
    const { scopedDb, getSelectedPrompt, getSelectedVariant, getLastFailed } =
      makeScopedDb();

    const input = await prepareShotImageWorkflowInput(baseArgs(scopedDb));

    expect(getSelectedPrompt).toHaveBeenCalledWith(FRAME_ID);
    expect(getSelectedVariant).toHaveBeenCalledWith(FRAME_ID);
    expect(getLastFailed).toHaveBeenCalledWith(FRAME_ID);
    expect(input.prompt).toBe('Stored prompt');
    expect(input.promptVersionId).toBe('fpv_selected');
    // A failed attempt awaiting retry outranks the selected version (#1066).
    expect(input.model).toBe('seedream_v5');
  });

  it('a prompt override WITHOUT a version override still reads the selection', async () => {
    // `generateShotImageFn`'s shape: it supplies the prompt but relies on the
    // live pointer for `promptVersionId`. Skipping the read here would stamp
    // null and detach the render from its prompt's history.
    const { scopedDb, getSelectedPrompt } = makeScopedDb();

    const input = await prepareShotImageWorkflowInput({
      ...baseArgs(scopedDb),
      promptOverride: 'Hand-typed prompt',
      modelOverride: 'nano_banana_pro',
    });

    expect(getSelectedPrompt).toHaveBeenCalledWith(FRAME_ID);
    expect(input.promptVersionId).toBe('fpv_selected');
  });

  it('a claimed user edit reads the selection to check it is not a no-op edit', async () => {
    const { scopedDb, getSelectedPrompt } = makeScopedDb();

    await prepareShotImageWorkflowInput({
      ...baseArgs(scopedDb),
      promptOverride: 'Hand-typed prompt',
      promptVersionOverride: 'fpv_from_caller',
      modelOverride: 'nano_banana_pro',
      userEditedPrompt: true,
    });

    expect(getSelectedPrompt).toHaveBeenCalledWith(FRAME_ID);
  });

  it('an override naming a retired model still falls through to the variant reads', async () => {
    // The guard is on VALIDITY, not presence: `resolveImageModel` takes the
    // first valid candidate, so an id dropped from the catalog must still
    // resolve through the last-failed / selected rows exactly as before.
    const { scopedDb, getSelectedVariant, getLastFailed } = makeScopedDb();

    const input = await prepareShotImageWorkflowInput({
      ...baseArgs(scopedDb),
      promptOverride: 'Prompt resolved by the caller',
      promptVersionOverride: 'fpv_from_caller',
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- simulating an id retired from the catalog since the row was written
      modelOverride: 'model_retired_from_catalog' as Parameters<
        typeof prepareShotImageWorkflowInput
      >[0]['modelOverride'],
    });

    expect(getSelectedVariant).toHaveBeenCalledWith(FRAME_ID);
    expect(getLastFailed).toHaveBeenCalledWith(FRAME_ID);
    expect(input.model).toBe('seedream_v5');
  });
});
