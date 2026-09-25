import type { QueryClient } from '@tanstack/react-query';
import { errorCode } from '@/platform/errors';
import { sequenceCharacterKeys } from '@/cast/ui/use-sequence-characters';
import { sequenceKeys } from '@/sequences/ui/use-sequences';
import { shotKeys } from './use-shots';

export async function refreshAfterContinueValidationError(
  queryClient: QueryClient,
  sequenceId: string,
  error: unknown
): Promise<void> {
  if (errorCode(error) !== 'VALIDATION_ERROR') return;

  // Keep the original validation toast if one of the refreshes also fails.
  await Promise.allSettled([
    queryClient.invalidateQueries({
      queryKey: sequenceKeys.detail(sequenceId),
    }),
    queryClient.invalidateQueries({
      queryKey: sequenceCharacterKeys.list(sequenceId),
    }),
    queryClient.invalidateQueries({ queryKey: shotKeys.list(sequenceId) }),
  ]);
}
