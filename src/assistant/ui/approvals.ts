/**
 * The paused approval behind a tool card (#2155). A server tool is not
 * registered on the client, so its approval arrives as a generic interrupt;
 * the tool call id is on the binding the server stamped in its metadata.
 */

import type { ChatInterrupt, ToolApprovalInterrupt } from '@tanstack/ai-client';

export type PendingInterrupt = ChatInterrupt | ToolApprovalInterrupt;

/** `open` takes an answer; `busy` waits on the run; `gone` has no interrupt to answer. */
export type ApprovalState = 'open' | 'busy' | 'gone';

/** `INTERRUPT_BINDING_METADATA_KEY`, spelled out: `@tanstack/ai` stays off the client. */
const BINDING_KEY = 'tanstack:interruptBinding';

function toolCallIdOf(interrupt: PendingInterrupt): string | undefined {
  if (interrupt.kind === 'tool-approval') return interrupt.toolCallId;
  const binding = interrupt.metadata?.[BINDING_KEY];
  if (
    typeof binding === 'object' &&
    binding !== null &&
    'kind' in binding &&
    binding.kind === 'tool-approval' &&
    'toolCallId' in binding &&
    typeof binding.toolCallId === 'string'
  ) {
    return binding.toolCallId;
  }
  return undefined;
}

export function approvalFor(
  interrupts: ReadonlyArray<PendingInterrupt>,
  toolCallId: string
): PendingInterrupt | undefined {
  return interrupts.find((i) => toolCallIdOf(i) === toolCallId);
}

export function approvalState(
  interrupt: PendingInterrupt | undefined,
  busy: boolean
): ApprovalState {
  if (busy) return 'busy';
  if (!interrupt?.canResolve) return 'gone';
  return interrupt.status === 'pending' || interrupt.status === 'error'
    ? 'open'
    : 'busy';
}

/** The server takes `{ approved }` for a generic interrupt over an approval binding. */
export function answerApproval(
  interrupt: PendingInterrupt,
  approved: boolean
): void {
  if (interrupt.kind === 'tool-approval') interrupt.resolveInterrupt(approved);
  else if (interrupt.kind === 'generic') {
    interrupt.resolveInterrupt({ approved });
  }
}
