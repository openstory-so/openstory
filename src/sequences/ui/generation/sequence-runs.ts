/**
 * Open workflow runs for the sequence chip (#2113).
 *
 * The count is top-level runs: a run whose parent is not also open. Every
 * other run in that tree is listed under it, so a storyboard shows the
 * sheets and clips it spawned and not only its direct child.
 */

import type { WorkflowRun } from '@/platform/realtime/schema';

export type { WorkflowRun };

const PIPELINE_CLASSES = new Set([
  'StoryboardWorkflow',
  'AnalyzeScriptWorkflow',
]);
const PIPELINE_LABELS = new Set(['Storyboard', 'Script analysis']);

function isPipelineRun(run: WorkflowRun): boolean {
  return PIPELINE_CLASSES.has(run.className) || PIPELINE_LABELS.has(run.label);
}

type RunGroup = {
  run: WorkflowRun;
  children: WorkflowRun[];
};

export function groupRuns(runs: WorkflowRun[]): RunGroup[] {
  const open = new Set(runs.map((run) => run.instanceId));
  const roots = runs.filter(
    (run) => run.parentInstanceId === null || !open.has(run.parentInstanceId)
  );
  const rootIds = new Set(roots.map((run) => run.instanceId));
  const byId = new Map(runs.map((run) => [run.instanceId, run]));

  const rootOf = (run: WorkflowRun): string | null => {
    let current: WorkflowRun | undefined = run;
    const seen = new Set<string>();
    while (current) {
      if (rootIds.has(current.instanceId)) return current.instanceId;
      if (seen.has(current.instanceId)) return null;
      seen.add(current.instanceId);
      const parentId = current.parentInstanceId;
      if (!parentId) return null;
      current = byId.get(parentId);
    }
    return null;
  };

  const groups = roots.map((root) => ({
    run: root,
    children: runs
      .filter(
        (run) =>
          run.instanceId !== root.instanceId && rootOf(run) === root.instanceId
      )
      .sort(byStart),
  }));

  const attached = new Set(
    groups.flatMap((group) => [
      group.run.instanceId,
      ...group.children.map((child) => child.instanceId),
    ])
  );
  for (const run of runs) {
    if (!attached.has(run.instanceId)) {
      groups.push({ run, children: [] });
    }
  }
  return groups.sort((a, b) => byStart(a.run, b.run));
}

function byStart(a: WorkflowRun, b: WorkflowRun): number {
  return a.startedAt - b.startedAt || a.instanceId.localeCompare(b.instanceId);
}

type RunChipItem = {
  key: string;
  label: string;
  showPhases: boolean;
  children: { key: string; label: string }[];
};

type RunChipModel =
  | { kind: 'hidden' }
  | { kind: 'pipeline' }
  /** The closed chip keeps the phase name and the time remaining. */
  | {
      kind: 'runs';
      items: RunChipItem[];
      label: string | null;
      showRemaining: boolean;
    };

/**
 * No open runs and a pipeline in flight: the existing phase chip.
 * Open runs: one row per top-level run. The pipeline's phases sit on its
 * row. Until that run has reported, the phases are a placeholder row so
 * the count still includes the script-to-video run.
 */
export function runChipModel(
  runs: WorkflowRun[],
  isProcessing: boolean
): RunChipModel {
  const items: RunChipItem[] = groupRuns(runs).map((group) => ({
    key: group.run.instanceId,
    label: group.run.label,
    showPhases: isProcessing && isPipelineGroup(group),
    children: group.children.map((child) => ({
      key: child.instanceId,
      label: child.label,
    })),
  }));
  if (isProcessing && !items.some((item) => item.showPhases)) {
    items.unshift({
      key: 'pipeline',
      label: 'Generating sequence',
      showPhases: true,
      children: [],
    });
  }
  if (items.length === 0) return { kind: 'hidden' };
  const only = items[0];
  if (items.length === 1 && only?.key === 'pipeline') {
    return { kind: 'pipeline' };
  }
  const single = items.length === 1 ? only : undefined;
  return {
    kind: 'runs',
    items,
    label: single?.showPhases
      ? null
      : (single?.label ?? `${items.length} running`),
    showRemaining: Boolean(single?.showPhases),
  };
}

function isPipelineGroup(group: RunGroup): boolean {
  return isPipelineRun(group.run) || group.children.some(isPipelineRun);
}

type RunEvent =
  | { type: 'started'; run: WorkflowRun }
  | { type: 'ended'; instanceId: string };

export type SequenceRunState = {
  runs: WorkflowRun[];
  /** False while a `/runs` read is in flight. Events queue instead of landing. */
  snapshotReady: boolean;
  pending: RunEvent[];
};

export const EMPTY_RUN_STATE: SequenceRunState = {
  runs: [],
  snapshotReady: false,
  pending: [],
};

export function beginRunSnapshot(state: SequenceRunState): SequenceRunState {
  return { ...state, snapshotReady: false };
}

/**
 * Apply a `/runs` read. `null` is a failed read: keep the runs already
 * on screen and still replay events that arrived during the fetch.
 */
export function applyRunRead(
  state: SequenceRunState,
  read: WorkflowRun[] | null
): SequenceRunState {
  return applyRunSnapshot(state, read ?? state.runs);
}

export function applyRunSnapshot(
  state: SequenceRunState,
  runs: WorkflowRun[]
): SequenceRunState {
  let next: SequenceRunState = {
    runs,
    snapshotReady: true,
    pending: [],
  };
  for (const event of state.pending) {
    next = applyLive(next, event);
  }
  return next;
}

export function applyRunEvent(
  state: SequenceRunState,
  event: RunEvent
): SequenceRunState {
  if (!state.snapshotReady) {
    return { ...state, pending: [...state.pending, event] };
  }
  return applyLive(state, event);
}

function applyLive(state: SequenceRunState, event: RunEvent): SequenceRunState {
  if (event.type === 'ended') {
    return {
      ...state,
      runs: state.runs.filter((run) => run.instanceId !== event.instanceId),
    };
  }
  return {
    ...state,
    runs: [
      ...state.runs.filter((run) => run.instanceId !== event.run.instanceId),
      event.run,
    ],
  };
}
