/**
 * Tests for the storyboard launcher + generation mutex (#839).
 *
 * The mutex contract: a storyboard can never start while the sequence's
 * previous run is still in flight, two racing requests can't both win the
 * CAS claim, and the launcher owns the side effects (status write, run-id
 * persistence, deduplication id) so call sites can't drift apart.
 *
 * The launcher also owns the trigger-time content snapshot: the payload the
 * workflow runs on is resolved HERE, from the same row the mutex read, so no
 * step can re-derive it from a row the user edited in the meantime.
 */

import { migrateStyleConfigV1ToV2 } from '@/lib/style/style-config';
import { describe, expect, test, vi } from 'vitest';
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from '@/lib/ai/models';
import { DEFAULT_ANALYSIS_MODEL } from '@/lib/ai/models.config';
import type { ScopedDb } from '@/lib/db/scoped';
import type { StyleConfig } from '@/lib/db/schema';
import type { StoryboardTriggerInput } from '@/lib/workflow/types';

const triggerWorkflowMock = vi.fn();
vi.doMock('@/lib/workflow/client', () => ({
  triggerWorkflow: triggerWorkflowMock,
}));

let runStateResult: 'failed' | 'completed' | 'unknown' | null = null;
vi.doMock('@/lib/workflow/reconcile', () => ({
  resolveRunState: vi.fn(async () => runStateResult),
}));

// Dynamic import so the mocks above apply (vi.doMock is not hoisted).
const {
  triggerStoryboard,
  assertNoActiveStoryboard,
  GenerationInProgressError,
  GenerationStatusUnknownError,
} = await import('./launchers');

const INPUT: StoryboardTriggerInput = {
  userId: 'u1',
  teamId: 't1',
  sequenceId: 'seq_1',
  options: {
    shotsPerScene: 3,
    generateThumbnails: true,
    generateDescriptions: true,
    aiProvider: 'openrouter',
    regenerateAll: true,
  },
};

const STYLE_CONFIG: StyleConfig = migrateStyleConfigV1ToV2({
  mood: 'tense and hopeful',
  artStyle: 'photoreal cinematic',
  lighting: 'hard key, deep shadows',
  colorPalette: ['#101020', '#e0d0b0'],
  cameraWork: 'handheld, tight lenses',
  referenceFilms: ['Children of Men'],
  colorGrading: 'cool shadows, warm highlights',
});

function makeScopedDb(opts: {
  workflowRunId: string | null;
  claimSucceeds?: boolean;
  script?: string | null;
  styleId?: string | null;
  styleConfig?: StyleConfig | null;
  style?: {
    id?: string;
    sequenceId?: string | null;
    config: StyleConfig;
  } | null;
  elementIds?: string[];
  talent?: Array<{ id: string; name: string; description: string | null }>;
  locations?: Array<{ id: string; name: string; description: string | null }>;
  musicPrompt?: string | null;
}) {
  const updateStatus = vi.fn();
  const claimWorkflowSlot = vi.fn<
    (params: {
      id: string;
      expectedRunId: string | null;
      claimId: string;
    }) => Promise<boolean>
  >(async () => opts.claimSucceeds ?? true);
  const update = vi.fn();
  const getForUser = vi.fn(async () => ({
    id: 'seq_1',
    title: 'The Long Walk',
    generateStartFrames: true,
    script: opts.script === undefined ? 'INT. HALLWAY — NIGHT' : opts.script,
    aspectRatio: '16:9',
    styleId: opts.styleId === undefined ? 'style_1' : opts.styleId,
    styleConfig: opts.styleConfig === undefined ? null : opts.styleConfig,
    analysisModel: 'invalid-model-id',
    imageModel: 'not-a-real-image-model',
    videoModel: 'not-a-real-video-model',
    workflowRunId: opts.workflowRunId,
    musicPrompt: opts.musicPrompt ?? null,
    status: 'failed',
  }));
  const getStyleById = vi.fn(async () =>
    opts.style === undefined ? { config: STYLE_CONFIG } : opts.style
  );
  const listElements = vi.fn(async () =>
    (opts.elementIds ?? ['el_1', 'el_2']).map((id) => ({ id }))
  );
  const getTalentByIds = vi.fn(async () => opts.talent ?? []);
  const getLocationsByIds = vi.fn(async () => opts.locations ?? []);
  const getMemberEmail = vi.fn(async () => 'owner@example.com');
  const stub = {
    sequences: { getForUser, claimWorkflowSlot, update },
    styles: { getById: getStyleById },
    sequenceElements: { list: listElements },
    talent: { getByIds: getTalentByIds },
    locations: { getByIds: getLocationsByIds },
    teamManagement: { getMemberEmail },
    sequence: () => ({ updateStatus }),
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal ScopedDb stub exposing only what the launcher touches
  const scopedDb = stub as unknown as ScopedDb;
  return {
    scopedDb,
    updateStatus,
    claimWorkflowSlot,
    update,
    getForUser,
    getStyleById,
    listElements,
    getTalentByIds,
    getLocationsByIds,
  };
}

describe('triggerStoryboard', () => {
  test('previous run still in flight → GenerationInProgressError, nothing triggered', async () => {
    runStateResult = null; // queued/running/waiting
    triggerWorkflowMock.mockReset();
    const { scopedDb, claimWorkflowSlot } = makeScopedDb({
      workflowRunId: 'openstory-so_storyboard_live',
    });

    await expect(triggerStoryboard(scopedDb, INPUT)).rejects.toBeInstanceOf(
      GenerationInProgressError
    );
    expect(claimWorkflowSlot).not.toHaveBeenCalled();
    expect(triggerWorkflowMock).not.toHaveBeenCalled();
  });

  test('status lookup failed → GenerationStatusUnknownError (not "already running"), nothing triggered', async () => {
    runStateResult = 'unknown'; // CF status API blip — can't verify
    triggerWorkflowMock.mockReset();
    const { scopedDb, claimWorkflowSlot } = makeScopedDb({
      workflowRunId: 'openstory-so_storyboard_maybe',
    });

    await expect(triggerStoryboard(scopedDb, INPUT)).rejects.toBeInstanceOf(
      GenerationStatusUnknownError
    );
    expect(claimWorkflowSlot).not.toHaveBeenCalled();
    expect(triggerWorkflowMock).not.toHaveBeenCalled();
  });

  test('terminal previous run → claims, triggers with the claim as dedup id, persists instance id', async () => {
    runStateResult = 'failed';
    triggerWorkflowMock.mockReset();
    triggerWorkflowMock.mockResolvedValue('openstory-so_storyboard_new-run');
    const { scopedDb, claimWorkflowSlot, update, updateStatus } = makeScopedDb({
      workflowRunId: 'openstory-so_storyboard_old',
    });

    const result = await triggerStoryboard(scopedDb, INPUT);

    expect(claimWorkflowSlot).toHaveBeenCalledWith({
      id: 'seq_1',
      expectedRunId: 'openstory-so_storyboard_old',
      claimId: expect.stringMatching(/^storyboard-seq_1-/),
    });
    expect(updateStatus).toHaveBeenCalledWith('processing');
    const claimId = claimWorkflowSlot.mock.calls[0]?.[0]?.claimId;
    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/storyboard',
      expect.objectContaining(INPUT),
      { deduplicationId: claimId, label: expect.any(String) }
    );
    expect(update).toHaveBeenCalledWith({
      id: 'seq_1',
      workflowRunId: 'openstory-so_storyboard_new-run',
    });
    expect(result).toEqual({
      workflowRunId: 'openstory-so_storyboard_new-run',
    });
  });

  test('snapshots the sequence row onto the payload so no step re-derives it', async () => {
    runStateResult = 'failed';
    triggerWorkflowMock.mockReset();
    triggerWorkflowMock.mockResolvedValue('run-1');
    const { scopedDb, listElements } = makeScopedDb({
      workflowRunId: null,
      elementIds: ['el_1', 'el_2'],
    });

    await triggerStoryboard(scopedDb, INPUT);

    expect(listElements).toHaveBeenCalledWith('seq_1');
    expect(triggerWorkflowMock.mock.calls[0]?.[1]).toEqual({
      ...INPUT,
      title: 'The Long Walk',
      script: 'INT. HALLWAY — NIGHT',
      // The sequence default, inverted into the payload's render vocabulary.
      referenceOnly: false,
      aspectRatio: '16:9',
      styleConfig: STYLE_CONFIG,
      // Unrecognised model ids on the row fall back to the defaults here, not
      // mid-run.
      analysisModelId: DEFAULT_ANALYSIS_MODEL,
      imageModel: DEFAULT_IMAGE_MODEL,
      videoModel: DEFAULT_VIDEO_MODEL,
      elementIds: ['el_1', 'el_2'],
      // No music prompt on the row yet, so whatever the pipeline writes is a
      // first generation — resolved here, not by a lookup in the grandchild.
      musicPromptSource: 'ai-generated',
      // Casting identity is snapshotted here too; INPUT suggests neither.
      suggestedTalent: [],
      suggestedLocations: [],
      ownerEmail: 'owner@example.com',
      sequenceUrl: expect.stringMatching(/\/sequences\/seq_1\/scenes$/),
    });
  });

  test('uses the sequence-owned style snapshot, not the live catalog row', async () => {
    runStateResult = 'failed';
    triggerWorkflowMock.mockReset();
    triggerWorkflowMock.mockResolvedValue('run-1');
    const snapshot = migrateStyleConfigV1ToV2({
      mood: 'snapshotted mood on the sequence',
      artStyle: 'photoreal cinematic',
      lighting: 'hard key, deep shadows',
      colorPalette: ['#101020', '#e0d0b0'],
      cameraWork: 'handheld, tight lenses',
      referenceFilms: ['Children of Men'],
      colorGrading: 'cool shadows, warm highlights',
    });
    const { scopedDb, getStyleById } = makeScopedDb({
      workflowRunId: null,
      styleConfig: snapshot,
      style: { config: STYLE_CONFIG },
    });

    await triggerStoryboard(scopedDb, INPUT);

    expect(getStyleById).not.toHaveBeenCalled();
    expect(triggerWorkflowMock.mock.calls[0]?.[1]).toMatchObject({
      styleConfig: snapshot,
    });
  });

  test('automatic style still a placeholder (no snapshot + row bound here) → pendingAutoStyleId on the payload', async () => {
    runStateResult = 'failed';
    triggerWorkflowMock.mockReset();
    triggerWorkflowMock.mockResolvedValue('run-1');
    const { scopedDb } = makeScopedDb({
      workflowRunId: null,
      styleId: 'style_auto',
      styleConfig: null,
      style: { id: 'style_auto', sequenceId: 'seq_1', config: STYLE_CONFIG },
    });

    await triggerStoryboard(scopedDb, INPUT);

    expect(triggerWorkflowMock.mock.calls[0]?.[1]).toMatchObject({
      pendingAutoStyleId: 'style_auto',
      styleConfig: STYLE_CONFIG,
    });
  });

  test('automatic style already derived (snapshot present) → no pendingAutoStyleId, so a retry never re-derives', async () => {
    runStateResult = 'failed';
    triggerWorkflowMock.mockReset();
    triggerWorkflowMock.mockResolvedValue('run-1');
    const { scopedDb } = makeScopedDb({
      workflowRunId: null,
      styleId: 'style_auto',
      styleConfig: STYLE_CONFIG,
      style: { id: 'style_auto', sequenceId: 'seq_1', config: STYLE_CONFIG },
    });

    await triggerStoryboard(scopedDb, INPUT);

    const payload = triggerWorkflowMock.mock.calls[0]?.[1];
    expect(payload).toMatchObject({ styleConfig: STYLE_CONFIG });
    expect(payload).toHaveProperty('pendingAutoStyleId', undefined);
  });

  test('library style with no snapshot (pre-snapshot row) → no pendingAutoStyleId', async () => {
    runStateResult = 'failed';
    triggerWorkflowMock.mockReset();
    triggerWorkflowMock.mockResolvedValue('run-1');
    const { scopedDb } = makeScopedDb({
      workflowRunId: null,
      styleConfig: null,
      style: { id: 'style_1', sequenceId: null, config: STYLE_CONFIG },
    });

    await triggerStoryboard(scopedDb, INPUT);

    expect(triggerWorkflowMock.mock.calls[0]?.[1]).toHaveProperty(
      'pendingAutoStyleId',
      undefined
    );
  });

  test('a sequence that already has a music prompt snapshots promptSource=regenerated', async () => {
    runStateResult = 'failed';
    triggerWorkflowMock.mockReset();
    triggerWorkflowMock.mockResolvedValue('run-1');
    const { scopedDb } = makeScopedDb({
      workflowRunId: null,
      musicPrompt: 'warm analog synths, slow build',
    });

    await triggerStoryboard(scopedDb, INPUT);

    expect(triggerWorkflowMock.mock.calls[0]?.[1]).toMatchObject({
      musicPromptSource: 'regenerated',
    });
  });

  test('snapshots suggested talent + location identity so matching never re-reads it', async () => {
    runStateResult = 'failed';
    triggerWorkflowMock.mockReset();
    triggerWorkflowMock.mockResolvedValue('run-1');
    const { scopedDb, getTalentByIds, getLocationsByIds } = makeScopedDb({
      workflowRunId: null,
      talent: [{ id: 'tal_1', name: 'Alice', description: 'Lead' }],
      locations: [{ id: 'loc_1', name: 'Docks', description: null }],
    });

    await triggerStoryboard(scopedDb, {
      ...INPUT,
      suggestedTalentIds: ['tal_1'],
      suggestedLocationIds: ['loc_1'],
    });

    expect(getTalentByIds).toHaveBeenCalledWith(['tal_1']);
    expect(getLocationsByIds).toHaveBeenCalledWith(['loc_1']);
    expect(triggerWorkflowMock.mock.calls[0]?.[1]).toMatchObject({
      suggestedTalent: [
        { talentId: 'tal_1', name: 'Alice', description: 'Lead' },
      ],
      suggestedLocations: [
        { locationId: 'loc_1', name: 'Docks', description: null },
      ],
    });
  });

  test('skips the identity reads entirely when nothing is suggested', async () => {
    runStateResult = 'failed';
    triggerWorkflowMock.mockReset();
    triggerWorkflowMock.mockResolvedValue('run-1');
    const { scopedDb, getTalentByIds, getLocationsByIds } = makeScopedDb({
      workflowRunId: null,
    });

    await triggerStoryboard(scopedDb, INPUT);

    expect(getTalentByIds).not.toHaveBeenCalled();
    expect(getLocationsByIds).not.toHaveBeenCalled();
  });

  test('sequence with no script → throws synchronously, nothing claimed or triggered', async () => {
    runStateResult = 'failed';
    triggerWorkflowMock.mockReset();
    const { scopedDb, claimWorkflowSlot } = makeScopedDb({
      workflowRunId: null,
      script: '   ',
    });

    await expect(triggerStoryboard(scopedDb, INPUT)).rejects.toThrow(
      'Sequence has no script'
    );
    expect(claimWorkflowSlot).not.toHaveBeenCalled();
    expect(triggerWorkflowMock).not.toHaveBeenCalled();
  });

  test('sequence with no style → throws synchronously', async () => {
    runStateResult = 'failed';
    triggerWorkflowMock.mockReset();
    const { scopedDb } = makeScopedDb({
      workflowRunId: null,
      styleId: null,
    });

    await expect(triggerStoryboard(scopedDb, INPUT)).rejects.toThrow(
      'Sequence has no style selected'
    );
    expect(triggerWorkflowMock).not.toHaveBeenCalled();
  });

  test('style row deleted → throws synchronously', async () => {
    runStateResult = 'failed';
    triggerWorkflowMock.mockReset();
    const { scopedDb } = makeScopedDb({ workflowRunId: null, style: null });

    await expect(triggerStoryboard(scopedDb, INPUT)).rejects.toThrow(
      'No style found'
    );
    expect(triggerWorkflowMock).not.toHaveBeenCalled();
  });

  test('no previous run (fresh sequence) → claims against null without a status lookup', async () => {
    runStateResult = null; // would reject if consulted — it must not be
    triggerWorkflowMock.mockReset();
    triggerWorkflowMock.mockResolvedValue('run-1');
    const { scopedDb, claimWorkflowSlot } = makeScopedDb({
      workflowRunId: null,
    });

    await triggerStoryboard(scopedDb, INPUT);

    expect(claimWorkflowSlot).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRunId: null })
    );
  });

  test('lost CAS race → GenerationInProgressError, nothing triggered', async () => {
    runStateResult = 'failed';
    triggerWorkflowMock.mockReset();
    const { scopedDb } = makeScopedDb({
      workflowRunId: 'openstory-so_storyboard_old',
      claimSucceeds: false,
    });

    await expect(triggerStoryboard(scopedDb, INPUT)).rejects.toBeInstanceOf(
      GenerationInProgressError
    );
    expect(triggerWorkflowMock).not.toHaveBeenCalled();
  });

  test('missing sequenceId → throws before touching the db', async () => {
    const { scopedDb, getForUser } = makeScopedDb({ workflowRunId: null });

    await expect(
      triggerStoryboard(scopedDb, { ...INPUT, sequenceId: undefined })
    ).rejects.toThrow('requires input.sequenceId');
    expect(getForUser).not.toHaveBeenCalled();
  });
});

describe('assertNoActiveStoryboard', () => {
  test('live run → throws', async () => {
    runStateResult = null;
    const { scopedDb } = makeScopedDb({
      workflowRunId: 'openstory-so_storyboard_live',
    });

    await expect(
      assertNoActiveStoryboard(scopedDb, 'seq_1')
    ).rejects.toBeInstanceOf(GenerationInProgressError);
  });

  test('status lookup failed → GenerationStatusUnknownError', async () => {
    runStateResult = 'unknown';
    const { scopedDb } = makeScopedDb({
      workflowRunId: 'openstory-so_storyboard_maybe',
    });

    await expect(
      assertNoActiveStoryboard(scopedDb, 'seq_1')
    ).rejects.toBeInstanceOf(GenerationStatusUnknownError);
  });

  test('terminal run → passes', async () => {
    runStateResult = 'completed';
    const { scopedDb } = makeScopedDb({
      workflowRunId: 'openstory-so_storyboard_done',
    });

    await expect(
      assertNoActiveStoryboard(scopedDb, 'seq_1')
    ).resolves.toBeUndefined();
  });

  test('no recorded run → passes (legacy rows)', async () => {
    runStateResult = null;
    const { scopedDb } = makeScopedDb({ workflowRunId: null });

    await expect(
      assertNoActiveStoryboard(scopedDb, 'seq_1')
    ).resolves.toBeUndefined();
  });
});
