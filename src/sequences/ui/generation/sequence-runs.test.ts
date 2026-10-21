import { describe, expect, it } from 'vitest';

import {
  applyRunEvent,
  applyRunRead,
  applyRunSnapshot,
  beginRunSnapshot,
  EMPTY_RUN_STATE,
  groupRuns,
  runChipModel,
  type WorkflowRun,
} from './sequence-runs';

function run(
  overrides: Partial<WorkflowRun> & Pick<WorkflowRun, 'instanceId'>
): WorkflowRun {
  return {
    binding: 'IMAGE_WORKFLOW',
    className: 'ImageWorkflow',
    label: 'Image generation',
    parentInstanceId: null,
    startedAt: 1,
    ...overrides,
  };
}

describe('groupRuns', () => {
  it('counts a run with no parent as top-level and nests its descendants', () => {
    const groups = groupRuns([
      run({
        instanceId: 'story',
        className: 'StoryboardWorkflow',
        label: 'Storyboard',
        startedAt: 1,
      }),
      run({
        instanceId: 'analyze',
        className: 'AnalyzeScriptWorkflow',
        label: 'Script analysis',
        parentInstanceId: 'story',
        startedAt: 2,
      }),
      run({
        instanceId: 'image',
        parentInstanceId: 'analyze',
        startedAt: 3,
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.run.instanceId).toBe('story');
    expect(groups[0]?.children.map((child) => child.instanceId)).toEqual([
      'analyze',
      'image',
    ]);
  });

  it('promotes a child whose parent has already ended', () => {
    const groups = groupRuns([
      run({ instanceId: 'image', parentInstanceId: 'gone', startedAt: 2 }),
      run({
        instanceId: 'voice',
        className: 'CharacterVoiceWorkflow',
        label: 'Voice',
        parentInstanceId: null,
        startedAt: 1,
      }),
    ]);

    expect(groups.map((group) => group.run.instanceId)).toEqual([
      'voice',
      'image',
    ]);
  });
});

describe('runChipModel', () => {
  it('keeps the phase chip when the only work is the pipeline and it has not reported', () => {
    expect(runChipModel([], true)).toEqual({ kind: 'pipeline' });
  });

  it('hides the chip when nothing is running', () => {
    expect(runChipModel([], false)).toEqual({ kind: 'hidden' });
  });

  it('names a single redraw and counts several top-level runs', () => {
    const one = runChipModel([run({ instanceId: 'image' })], false);
    expect(one).toMatchObject({
      kind: 'runs',
      label: 'Image generation',
      showRemaining: false,
    });

    const two = runChipModel(
      [
        run({ instanceId: 'image', startedAt: 1 }),
        run({
          instanceId: 'voice',
          className: 'CharacterVoiceWorkflow',
          label: 'Voice',
          startedAt: 2,
        }),
      ],
      false
    );
    expect(two).toMatchObject({ kind: 'runs', label: '2 running' });
    if (two.kind !== 'runs') throw new Error('expected runs');
    expect(two.items).toHaveLength(2);
  });

  it('counts an unreported pipeline beside a redraw', () => {
    const model = runChipModel([run({ instanceId: 'image' })], true);
    expect(model).toMatchObject({
      kind: 'runs',
      label: '2 running',
      showRemaining: false,
    });
    if (model.kind !== 'runs') throw new Error('expected runs');
    expect(model.items.map((item) => item.key)).toEqual(['pipeline', 'image']);
    expect(model.items[0]?.showPhases).toBe(true);
  });

  it('puts the pipeline phases on the storyboard row once that run has reported', () => {
    const model = runChipModel(
      [
        run({
          instanceId: 'story',
          className: 'StoryboardWorkflow',
          label: 'Storyboard',
          binding: 'STORYBOARD_WORKFLOW',
        }),
        run({ instanceId: 'image', parentInstanceId: 'story', startedAt: 2 }),
      ],
      true
    );
    expect(model).toMatchObject({
      kind: 'runs',
      label: null,
      showRemaining: true,
    });
    if (model.kind !== 'runs') throw new Error('expected runs');
    expect(model.items[0]).toMatchObject({
      key: 'story',
      showPhases: true,
    });
    expect(model.items[0]?.children.map((child) => child.key)).toEqual([
      'image',
    ]);
  });
});

describe('run snapshot', () => {
  it('queues events that arrive before the snapshot, then applies them on top', () => {
    const started = beginRunSnapshot(EMPTY_RUN_STATE);
    const queued = applyRunEvent(started, {
      type: 'started',
      run: run({ instanceId: 'late', startedAt: 5 }),
    });
    expect(queued.runs).toEqual([]);
    const next = applyRunSnapshot(queued, [
      run({ instanceId: 'early', startedAt: 1 }),
    ]);
    expect(next.snapshotReady).toBe(true);
    expect(next.runs.map((row) => row.instanceId)).toEqual(['early', 'late']);
  });

  it('drops a run when its end event arrives after the snapshot', () => {
    const ready = applyRunSnapshot(EMPTY_RUN_STATE, [
      run({ instanceId: 'image' }),
    ]);
    const next = applyRunEvent(ready, { type: 'ended', instanceId: 'image' });
    expect(next.runs).toEqual([]);
  });

  it('drops a run whose end arrived while the snapshot still lists it', () => {
    const queued = applyRunEvent(beginRunSnapshot(EMPTY_RUN_STATE), {
      type: 'ended',
      instanceId: 'image',
    });
    const next = applyRunSnapshot(queued, [run({ instanceId: 'image' })]);
    expect(next.runs).toEqual([]);
  });

  it('keeps the open runs when the read fails', () => {
    const open = applyRunSnapshot(EMPTY_RUN_STATE, [
      run({ instanceId: 'image' }),
    ]);
    const next = applyRunRead(beginRunSnapshot(open), null);
    expect(next.runs.map((row) => row.instanceId)).toEqual(['image']);
    expect(next.snapshotReady).toBe(true);
  });

  it('still applies a queued end when the read fails', () => {
    const open = applyRunSnapshot(EMPTY_RUN_STATE, [
      run({ instanceId: 'image' }),
    ]);
    const reading = applyRunEvent(beginRunSnapshot(open), {
      type: 'ended',
      instanceId: 'image',
    });
    const next = applyRunRead(reading, null);
    expect(next.runs).toEqual([]);
  });

  it('replaces the list when the read succeeds', () => {
    const open = applyRunSnapshot(EMPTY_RUN_STATE, [
      run({ instanceId: 'image' }),
    ]);
    const next = applyRunRead(beginRunSnapshot(open), [
      run({ instanceId: 'motion' }),
    ]);
    expect(next.runs.map((row) => row.instanceId)).toEqual(['motion']);
  });

  it('does not add a run back when the snapshot already includes a queued start', () => {
    const queued = applyRunEvent(beginRunSnapshot(EMPTY_RUN_STATE), {
      type: 'started',
      run: run({ instanceId: 'image', label: 'Image generation' }),
    });
    const next = applyRunSnapshot(queued, [
      run({ instanceId: 'image', label: 'Image generation' }),
    ]);
    expect(next.runs).toHaveLength(1);
  });
});
