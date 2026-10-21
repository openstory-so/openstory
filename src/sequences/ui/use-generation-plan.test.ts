import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { sequenceCharacterKeys } from '@/cast/ui/use-sequence-characters';
import { sequenceKeys } from '@/sequences/ui/use-sequences';
import { shotKeys } from '@/shots/ui/use-shots';
import {
  generationPlanKeys,
  refetchAfterRefusedContinue,
} from './use-generation-plan';

describe('refetchAfterRefusedContinue (#1822)', () => {
  it('marks everything the footer reads stale, so the next click is not the same click', () => {
    const queryClient = new QueryClient();
    const keys = [
      generationPlanKeys.detail('seq-1'),
      generationPlanKeys.detail('seq-1', {
        generateStartFrames: true,
        generateVoices: true,
      }),
      sequenceKeys.detail('seq-1'),
      sequenceCharacterKeys.list('seq-1'),
      shotKeys.list('seq-1'),
    ];
    for (const key of keys) queryClient.setQueryData(key, []);
    const other = generationPlanKeys.detail('seq-2');
    queryClient.setQueryData(other, []);

    refetchAfterRefusedContinue(queryClient, 'seq-1');

    for (const key of keys) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
    expect(queryClient.getQueryState(other)?.isInvalidated).toBe(false);
  });
});
