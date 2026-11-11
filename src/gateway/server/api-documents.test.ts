import { describe, expect, it } from 'vitest';
import { micros } from '@/billing/money';
import type { GatewayJob } from '@/platform/server/db/schema';
import { gatewayJobDocument } from './api-documents';

const job: GatewayJob = {
  id: 'job-1',
  organizationId: 'org-1',
  userId: 'user-1',
  kind: 'image',
  modelKey: 'gpt_image_2',
  input: {
    kind: 'image',
    model: 'gpt_image_2',
    prompt: 'a fox',
    aspectRatio: '16:9',
    referenceImageUrls: [],
  },
  status: 'running',
  via: 'fal',
  providerJobId: null,
  outputs: [{ url: '/r2/a.png', path: 'a.png', contentType: 'image/png' }],
  error: null,
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
    expect(done.outputs).toHaveLength(1);
    expect(done.charge).toEqual({
      totalMicros: 5,
      lines: [{ kind: 'provider_cost', amountMicros: 5 }],
    });
  });
});
