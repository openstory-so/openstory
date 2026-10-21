import { describe, expect, it } from 'vitest';

import { realtimeSchema } from './index';

describe('realtime event shapes', () => {
  it('generation.shot:updated carries ids only — never the Scene (#1811)', () => {
    // Every emit is persisted to the channel DO, and a replay reads the tail
    // back into one isolate: a Scene per shot per prompt type OOMed it.
    expect(
      Object.keys(realtimeSchema.generation['shot:updated'].shape).sort()
    ).toEqual(['shotId', 'updateType']);
  });
});
