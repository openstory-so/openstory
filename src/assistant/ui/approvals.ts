/** The paused approval behind a tool card (#2155); see docs/architecture/assistant.md. */

import type { ChatInterrupt, InterruptItemStatus } from '@tanstack/ai-client';

/** `open` takes an answer; `staged` waits on another card; `busy` waits on the run; `stuck` cannot be answered here; `gone` has no interrupt. */
export type ApprovalState = 'open' | 'staged' | 'busy' | 'stuck' | 'gone';

/** What holds the composer: nothing, a card's answer, or an interrupt no card here can answer. */
export type ComposerHold = 'none' | 'approval' | 'stuck';

/** `INTERRUPT_BINDING_METADATA_KEY`, spelled out: `@tanstack/ai` stays off the client. */
const BINDING_KEY = 'tanstack:interruptBinding';

function toolCallIdOf(interrupt: ChatInterrupt): string | undefined {
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
  interrupts: ReadonlyArray<ChatInterrupt>,
  toolCallId: string
): ChatInterrupt | undefined {
  return interrupts.find((i) => toolCallIdOf(i) === toolCallId);
}

function stateOfStatus(status: InterruptItemStatus): ApprovalState {
  switch (status) {
    case 'pending':
    case 'error':
      return 'open';
    case 'staged':
      return 'staged';
    case 'validating':
    case 'submitting':
      return 'busy';
    default: {
      const unknown: never = status;
      throw new Error(`Unknown interrupt status: ${String(unknown)}`);
    }
  }
}

export function approvalState(
  interrupt: ChatInterrupt | undefined,
  busy: boolean
): ApprovalState {
  if (busy) return 'busy';
  if (!interrupt) return 'gone';
  if (!interrupt.canResolve) return 'stuck';
  return stateOfStatus(interrupt.status);
}

export function composerHold(
  interrupts: ReadonlyArray<ChatInterrupt>,
  resuming: boolean
): ComposerHold {
  if (interrupts.some((i) => !i.canResolve || !toolCallIdOf(i))) return 'stuck';
  return interrupts.length > 0 || resuming ? 'approval' : 'none';
}

/** Answers the card's approval with `{ approved }`; false when it is not open, so a second click sends nothing. */
export function answerOpenApproval(
  interrupts: ReadonlyArray<ChatInterrupt>,
  toolCallId: string,
  busy: boolean,
  approved: boolean
): boolean {
  const interrupt = approvalFor(interrupts, toolCallId);
  if (!interrupt || approvalState(interrupt, busy) !== 'open') return false;
  if (interrupt.kind !== 'generic') {
    throw new Error(
      `Approval for ${toolCallId} arrived as a ${interrupt.kind} interrupt`
    );
  }
  interrupt.resolveInterrupt({ approved });
  return true;
}
