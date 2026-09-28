/**
 * Structural stand-ins for Cloudflare Workflow types in unit tests.
 *
 * `WorkflowStep` and `Workflow` are small public surfaces, so a test can
 * supply the methods it actually calls and still be the real type. Missing
 * methods throw if a test reaches them.
 */
import type { WorkflowStep, WorkflowStepContext } from 'cloudflare:workers';

function unimplemented(what: string): never {
  throw new Error(`workflow test double: ${what} was not stubbed`);
}

export function workflowStepContext(name: string): WorkflowStepContext {
  return {
    step: { name, count: 1 },
    attempt: 1,
    config: {},
  };
}

type StepCallback<T> = (ctx: WorkflowStepContext) => Promise<T>;

export type WorkflowStepDoubleOptions = {
  /** Filled with each `do` name, in call order. */
  names?: string[];
  sleep?: WorkflowStep['sleep'];
  sleepUntil?: WorkflowStep['sleepUntil'];
  waitForEvent?: WorkflowStep['waitForEvent'];
  /**
   * Runs the step callback. The default calls it once with
   * {@link workflowStepContext} and returns that result. A custom `run` is
   * the only caller of the callback.
   */
  run?: <T>(name: string, callback: StepCallback<T>) => Promise<T>;
};

export function workflowStep(
  options: WorkflowStepDoubleOptions = {}
): WorkflowStep {
  const run: <T>(name: string, callback: StepCallback<T>) => Promise<T> =
    options.run ??
    (async <T>(name: string, callback: StepCallback<T>) =>
      callback(workflowStepContext(name)));

  const step: WorkflowStep = {
    do(name, second, third) {
      const callback = typeof second === 'function' ? second : third;
      if (typeof callback !== 'function') unimplemented(`step "${name}"`);
      options.names?.push(name);
      return run(name, callback);
    },
    async sleep(name, duration) {
      if (options.sleep) return options.sleep(name, duration);
      unimplemented(`sleep "${name}"`);
    },
    async sleepUntil(name, timestamp) {
      if (options.sleepUntil) return options.sleepUntil(name, timestamp);
      unimplemented(`sleepUntil "${name}"`);
    },
    async waitForEvent(name, eventOptions) {
      if (options.waitForEvent) {
        return options.waitForEvent(name, eventOptions);
      }
      unimplemented(`waitForEvent "${name}"`);
    },
  };
  return step;
}

/** A `WorkflowInstance` whose unimplemented methods throw. */
export function workflowInstance(
  impl: Partial<WorkflowInstance> = {}
): WorkflowInstance {
  return {
    id: impl.id ?? 'instance',
    pause: impl.pause ?? (async () => unimplemented('WorkflowInstance.pause')),
    resume:
      impl.resume ?? (async () => unimplemented('WorkflowInstance.resume')),
    terminate:
      impl.terminate ??
      (async () => unimplemented('WorkflowInstance.terminate')),
    restart:
      impl.restart ?? (async () => unimplemented('WorkflowInstance.restart')),
    delete:
      impl.delete ?? (async () => unimplemented('WorkflowInstance.delete')),
    status:
      impl.status ?? (async () => unimplemented('WorkflowInstance.status')),
    sendEvent:
      impl.sendEvent ??
      (async () => unimplemented('WorkflowInstance.sendEvent')),
  };
}

/** A `Workflow` binding whose unimplemented methods throw. */
export function workflowBinding<Params = unknown>(
  impl: Partial<Workflow<Params>> = {}
): Workflow<Params> {
  return {
    get: impl.get ?? ((id) => unimplemented(`Workflow.get("${id}")`)),
    create: impl.create ?? (() => unimplemented('Workflow.create')),
    createBatch:
      impl.createBatch ?? (() => unimplemented('Workflow.createBatch')),
    deleteBatch:
      impl.deleteBatch ?? (() => unimplemented('Workflow.deleteBatch')),
  };
}
