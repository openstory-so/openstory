/**
 * Counts the sidebar balance up when a gift lands (#1668) — the welcome grant
 * after a card is saved.
 *
 * The gain is announced, not inferred from the balance moving: available
 * balance also rises whenever a reservation is released, and the grant can
 * reach the cache before or after the claim call returns (webhook, realtime
 * push, refetch). Counting up TO the live balance is right in every order.
 */

import { triggerBalanceFlash } from '@/billing/ui/use-balance-flash';
import { useEffect, useState } from 'react';

const GAIN_EVENT = 'openstory:balance-gain';
const DURATION_MS = 1800;

/** Turns the pill green and counts `gainUsd` up into the balance. */
export function celebrateBalanceGain(gainUsd: number) {
  triggerBalanceFlash();
  window.dispatchEvent(new CustomEvent(GAIN_EVENT, { detail: gainUsd }));
}

/** The amount on show `progress` (0–1) of the way through a count-up. */
export function shownDuringGain(
  balance: number,
  gain: number,
  progress: number
): number {
  const eased = 1 - (1 - progress) ** 3;
  return Math.max(0, balance - gain * (1 - eased));
}

export function useBalanceCountUp(balance: number | null): {
  shown: number;
  gain: number | null;
} {
  const [tween, setTween] = useState<{ gain: number; progress: number } | null>(
    null
  );

  useEffect(() => {
    let frame = 0;
    const handler = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== 'number') {
        return;
      }
      const gain = event.detail;
      // Reduced motion: the "+$20.00" still shows, the digits do not tick.
      const still = window.matchMedia(
        '(prefers-reduced-motion: reduce)'
      ).matches;
      const start = performance.now();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(function tick(now) {
        const progress = Math.min(1, (now - start) / DURATION_MS);
        if (progress === 1) {
          setTween(null);
          return;
        }
        setTween({ gain, progress: still ? 1 : progress });
        frame = requestAnimationFrame(tick);
      });
    };
    window.addEventListener(GAIN_EVENT, handler);
    return () => {
      window.removeEventListener(GAIN_EVENT, handler);
      cancelAnimationFrame(frame);
    };
  }, []);

  const settled = balance ?? 0;
  return {
    shown: tween
      ? shownDuringGain(settled, tween.gain, tween.progress)
      : settled,
    gain: tween?.gain ?? null,
  };
}
