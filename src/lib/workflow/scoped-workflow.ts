/**
 * Scoped Workflow Factory
 * The ONLY workflow-side file that imports createScopedDb.
 * All workflows use createScopedWorkflow instead of createWorkflow directly.
 */

import { createScopedDb, type ScopedDb } from '@/lib/db/scoped';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type { UserWorkflowContext } from '@/lib/workflow/types';
import type { WorkflowContext } from '@upstash/workflow';
import { WorkflowMiddleware } from '@upstash/workflow';
import { createWorkflow } from '@upstash/workflow/tanstack';

export type ScopedWorkflowFailureData<T extends UserWorkflowContext> = {
  context: Omit<
    WorkflowContext<T>,
    | 'run'
    | 'sleepUntil'
    | 'sleep'
    | 'call'
    | 'waitForEvent'
    | 'notify'
    | 'cancel'
    | 'api'
    | 'invoke'
    | 'createWebhook'
    | 'waitForWebhook'
  >;
  scopedDb: ScopedDb;
  failResponse: string;
  failStatus: number;
  failHeaders: Record<string, string[]>;
  failStack: string;
};

/**
 * Inputs that opt into the workflow-snapshot pattern carry a SHA-256 hash of
 * the canonical serialization of the inlined DTO. The framework validates the
 * payload against the same hash at start-time (tamper check), exposes the hash
 * via `context.snapshot`, and offers a bound `computeCurrent` that recomputes
 * from current DB state for write-time divergence checks.
 */
export type SnapshotInput = { snapshotInputHash: string };

export type SnapshotConfig<T extends SnapshotInput & UserWorkflowContext> = {
  /**
   * Recomputes the hash from a DTO (no live DB reads). Called at workflow
   * start with the payload to verify `snapshotInputHash` matches.
   */
  computeFromDto: (input: T) => Promise<string> | string;
  /**
   * Recomputes the hash from current DB state. Exposed to the workflow via
   * `context.snapshot.computeCurrent()` for write-time divergence checks.
   */
  computeCurrent: (input: T, scopedDb: ScopedDb) => Promise<string> | string;
};

export type SnapshotContext = {
  snapshotInputHash: string;
  computeCurrent: () => Promise<string>;
};

/**
 * `WorkflowContext` augmented with an optional `snapshot` slot. The slot is
 * populated only when the workflow opts into the snapshot pattern via
 * `createScopedWorkflow({ snapshot })`; non-opted workflows see `undefined`.
 */
export type ScopedWorkflowContext<T extends UserWorkflowContext> =
  WorkflowContext<T> & { snapshot?: SnapshotContext };

export function createScopedWorkflow<
  T extends UserWorkflowContext,
  TResult = unknown,
>(
  fn: (
    context: ScopedWorkflowContext<T>,
    scopedDb: ScopedDb
  ) => Promise<TResult>,
  options?: {
    failureFunction?: (
      params: ScopedWorkflowFailureData<T>
    ) => Promise<void | string> | void | string;
    snapshot?: SnapshotConfig<T & SnapshotInput>;
  }
) {
  const teamIdValidation = new WorkflowMiddleware<T, TResult>({
    name: 'teamId-validation',
    callbacks: {
      runStarted: async ({ context }) => {
        if (!context.requestPayload.teamId) {
          throw new WorkflowValidationError('teamId is required');
        }
      },
    },
  });

  const middlewares: WorkflowMiddleware<T, TResult>[] = [teamIdValidation];

  const snapshotConfig = options?.snapshot;
  if (snapshotConfig) {
    const snapshotValidation = new WorkflowMiddleware<T, TResult>({
      name: 'snapshot-validation',
      callbacks: {
        runStarted: async ({ context }) => {
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- workflow opted into snapshot, so payload must carry SnapshotInput; the next branch surfaces violations as workflow errors
          const payload = context.requestPayload as T & Partial<SnapshotInput>;
          if (typeof payload.snapshotInputHash !== 'string') {
            throw new WorkflowValidationError(
              'snapshotInputHash is required for workflows with snapshot config'
            );
          }
          const recomputed = await snapshotConfig.computeFromDto(
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- snapshotInputHash narrowed to string above, so payload satisfies SnapshotInput
            payload as T & SnapshotInput
          );
          if (recomputed !== payload.snapshotInputHash) {
            throw new WorkflowValidationError(
              'snapshotInputHash does not match the inlined DTO; payload was tampered with or serialized inconsistently'
            );
          }
        },
      },
    });
    middlewares.push(snapshotValidation);
  }

  return createWorkflow<T, TResult>(
    async (context) => {
      const scopedDb = createScopedDb(
        context.requestPayload.teamId,
        context.requestPayload.userId
      );

      const augmented: ScopedWorkflowContext<T> = context;
      if (snapshotConfig) {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the snapshot middleware already verified snapshotInputHash before this fn runs
        const payload = context.requestPayload as T & SnapshotInput;
        augmented.snapshot = {
          snapshotInputHash: payload.snapshotInputHash,
          computeCurrent: async () =>
            snapshotConfig.computeCurrent(payload, scopedDb),
        };
      }

      return fn(augmented, scopedDb);
    },
    {
      middlewares,
      failureFunction: options?.failureFunction
        ? async (failData) => {
            const scopedDb = createScopedDb(
              failData.context.requestPayload.teamId,
              failData.context.requestPayload.userId
            );
            const failureFn = options.failureFunction;
            if (failureFn) return failureFn({ ...failData, scopedDb });
          }
        : undefined,
    }
  );
}
