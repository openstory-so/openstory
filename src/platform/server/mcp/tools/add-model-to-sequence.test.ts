import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { addModelSummary, generationUploadTools } from './generation-uploads';

const result = {
  workflowRunId: 'wf_1',
  variantType: 'image' as const,
  model: 'seedream_v5',
  count: 3,
  failed: 0,
  skipped: 2,
};

describe('add_model_to_sequence reports skipped shots (#2291)', () => {
  it('keeps `skipped` through its output schema', () => {
    const tool = generationUploadTools.find(
      (t) => t.name === 'openstory.add_model_to_sequence'
    );
    const schema = tool?.outputSchema as z.ZodType | undefined;
    expect(schema?.parse(result)).toMatchObject({ skipped: 2 });
  });

  it('names the skipped shots in the summary, only when there are some', () => {
    expect(addModelSummary(result)).toBe(
      'Started seedream_v5 on 3 units. Skipped 2 shots with no image prompt.'
    );
    expect(addModelSummary({ ...result, skipped: 0 })).toBe(
      'Started seedream_v5 on 3 units.'
    );
  });
});
