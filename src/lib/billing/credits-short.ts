/**
 * Scene-split found more stills/motion than the click envelope could grow to
 * cover (#1310 / #1328). That is a top-up prompt, not a generation failure.
 *
 * The persisted `sequence.statusError` is the classification source (same
 * pattern as content-checker warnings): match a stable phrase so a child-
 * workflow prefix cannot hide it, and keep old copy ("Add credits and retry")
 * working for sequences that already failed.
 */

import { microsToDisplayUsd, type Microdollars } from '@/lib/billing/money';

export const CREDITS_SHORT_TITLE = 'Add credits to continue';

const CREDITS_SHORT_PATTERN = /not enough credits to generate/i;
const SCENE_COUNT_PATTERN = /images for (\d+) scenes/i;
const AMOUNT_PATTERN = /add (\$[\d.]+) more/i;

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return '';
}

export function isCreditsShortError(error: unknown): boolean {
  return CREDITS_SHORT_PATTERN.test(messageOf(error));
}

export function creditsShortStatusError(opts: {
  sceneCount: number;
  neededMicros: Microdollars;
}): string {
  const amountBit =
    opts.neededMicros > 0
      ? `Add ${microsToDisplayUsd(opts.neededMicros)} more, then continue.`
      : 'Add credits, then continue.';
  return `Not enough credits to generate images for ${opts.sceneCount} scenes. ${amountBit}`;
}

export function creditsShortHint(error: string | null | undefined): string {
  const message = error ?? '';
  const scenes = message.match(SCENE_COUNT_PATTERN)?.[1];
  const amount = message.match(AMOUNT_PATTERN)?.[1];
  const sceneBit = scenes
    ? `This sequence has ${scenes} scenes — more than the first estimate.`
    : 'Scene split found more work than the first estimate.';
  const amountBit = amount
    ? `Add ${amount} more, then continue generation.`
    : 'Add credits, then continue generation.';
  return `${sceneBit} ${amountBit}`;
}
