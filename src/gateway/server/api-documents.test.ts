import { describe, expect, it } from 'vitest';
import { micros } from '@/billing/money';
import { generateId } from '@/platform/id';
import type { GatewayJob } from '@/platform/server/db/schema';
import { gatewayJobDocument } from './api-documents';

const job: GatewayJob = {
  id: generateId(),
  organizationId: generateId(),
  userId: generateId(),
  kind: 'image',
  modelKey: 'grok-imagine-image',
  input: {
    model: 'grok-imagine-image',
    prompt:
      'Mara, a ferry mechanic, wipes her hands on a rag in the engine room',
  },
  status: 'running',
  via: 'xai',
  providerJobId: null,
  outputs: [{ url: '/r2/a.png', path: 'a.png', contentType: 'image/png' }],
  error: null,
  data: null,
  costMicros: null,
  reservationId: null,
  workflowRunId: null,
  idempotencyKey: null,
  oauthClientId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  completedAt: null,
};

describe('gatewayJobDocument', () => {
  it('shows outputs recorded before the charge only once the job succeeded', () => {
    const origin = 'https://openstory.test';
    expect(gatewayJobDocument(job, [], origin).outputs).toEqual([]);
    expect(
      gatewayJobDocument(
        {
          ...job,
          status: 'failed',
          error: { code: 'GENERATION_FAILED', message: 'x' },
        },
        [],
        origin
      ).outputs
    ).toEqual([]);
    const done = gatewayJobDocument(
      { ...job, status: 'succeeded', costMicros: 5 },
      [{ kind: 'provider_cost', amountMicros: micros(5) }],
      origin
    );
    expect(done).toMatchObject({
      provider: 'grok',
      model: 'grok-imagine-image',
    });
    expect(done.outputs).toHaveLength(1);
    expect(done.charge).toEqual({
      totalMicros: 5,
      lines: [{ kind: 'provider_cost', amountMicros: 5 }],
    });
  });

  it("gives a failed job's code a fixed message, never the provider's text", () => {
    const failed = gatewayJobDocument(
      {
        ...job,
        status: 'failed',
        error: {
          code: 'GENERATION_FAILED',
          message:
            'Provider refused the request (401): {"error":"Incorrect API key sk-…"}',
        },
      },
      [],
      'https://openstory.test'
    );
    expect(failed.error).toEqual({
      code: 'GENERATION_FAILED',
      message: 'The provider could not complete this job.',
    });
  });
});
