/** AssetGenerationWorkflow: the own-key route never spends the platform key, and a failed gateway run lets its hold go. */

import { describe, expect, it, vi } from 'vitest';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { AssetGenerationWorkflowInput } from '@/platform/server/workflow/types';
import { asStub } from '@/test/as-stub';
import { NonRetryableError } from 'cloudflare:workflows';

const falStart = vi.fn();
vi.doMock('#db-client', () => ({ getDb: vi.fn() }));
vi.doMock('@/gateway/server/providers', () => ({
  GATEWAY_DRIVERS: { fal: { start: falStart, poll: vi.fn() } },
}));
const releaseGatewayRun = vi.fn(async () => undefined);
vi.doMock('@/gateway/server/phases', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/gateway/server/phases')>()),
  releaseGatewayRun,
}));

const { AssetGenerationWorkflow } = await import('./asset-generation-workflow');

type Event = Readonly<WorkflowEvent<AssetGenerationWorkflowInput>>;

class Probe extends AssetGenerationWorkflow {
  runBody(event: Event, step: WorkflowStep, scopedDb: WorkflowScopedDb) {
    return this.runImpl(event, step, scopedDb);
  }
  fail(event: Event, scopedDb: WorkflowScopedDb) {
    return this.onFailure({ event, error: 'boom', scopedDb });
  }
}

function makeWorkflow(): Probe {
  type Ctor = ConstructorParameters<typeof Probe>;
  return new Probe(asStub<Ctor[0]>(undefined), asStub<Ctor[1]>({}));
}

const step = asStub<WorkflowStep>({
  do: async (_name: string, fn: () => Promise<unknown>) => fn(),
  sleep: async () => {},
});

function event(route: AssetGenerationWorkflowInput['route']): Event {
  return {
    payload: {
      userId: 'u1',
      organizationId: 'org-1',
      assetId: 'asset-1',
      activity: 'image',
      input: { prompt: 'Mara signs the log' },
      route,
    },
    instanceId: 'run-1',
    workflowName: 'asset',
    timestamp: new Date(0),
  };
}

function scopedDb(keySource: 'organization' | 'platform') {
  return asStub<WorkflowScopedDb>({
    organizationId: 'org-1',
    userId: 'u1',
    generatedAssets: {
      markRunning: async () => undefined,
      markFailed: async () => undefined,
    },
    credentials: {
      resolveKey: async () => ({ key: 'k', source: keySource }),
      resolveOptionalKey: async () => null,
    },
  });
}

describe('AssetGenerationWorkflow', () => {
  it('refuses to run an own-key route on the platform key', async () => {
    falStart.mockImplementation(
      async (
        _target: unknown,
        _body: unknown,
        credentials: { resolveKey: (provider: 'fal') => Promise<unknown> }
      ) => credentials.resolveKey('fal')
    );
    await expect(
      makeWorkflow().runBody(
        event({ via: 'fal', endpointId: 'fal-ai/flux-1/dev' }),
        step,
        scopedDb('platform')
      )
    ).rejects.toThrow(NonRetryableError);
    // The driver resolves the key before it sends, so nothing reached fal.
    await expect(falStart.mock.results[0]?.value).rejects.toThrow(
      'Your own fal key is no longer usable'
    );
  });

  it('lets the click hold go when a gateway run fails', async () => {
    const hold = { jobId: 'job-1', reservationId: 'res-1' };
    const db = scopedDb('platform');
    await makeWorkflow().fail(
      event({
        via: 'openstory',
        model: asStub<
          Extract<
            AssetGenerationWorkflowInput['route'],
            { via: 'openstory' }
          >['model']
        >({}),
        hold,
      }),
      db
    );
    expect(releaseGatewayRun).toHaveBeenCalledWith(db, hold, 'boom');
  });
});
