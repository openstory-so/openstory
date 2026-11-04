/**
 * Authentication utilities for workflows
 */

import { AuthenticationError } from '@/platform/errors';
import type { SequenceWorkflowContext } from './types';

/**
 * Type guard to check if an object has the SequenceWorkflowContext shape
 */
function isPartialSequenceContext(
  context: unknown
): context is Partial<SequenceWorkflowContext> {
  return typeof context === 'object' && context !== null;
}

export function validateSequenceAuth(
  context: unknown
): asserts context is SequenceWorkflowContext {
  if (!isPartialSequenceContext(context)) {
    throw new AuthenticationError('Sequence context is not an object');
  }

  if (!context.userId) {
    throw new AuthenticationError('Workflow context missing userId');
  }

  if (!context.organizationId) {
    throw new AuthenticationError('Workflow context missing organizationId');
  }

  if (!context.sequenceId) {
    throw new AuthenticationError('Sequence context missing sequenceId');
  }
}
