/**
 * Composer sample-script helpers (issue #1187, revised in #1255).
 *
 * The bare composer starts empty (placeholder visible, Automatic selected).
 * Shuffle and the style-detail "Try" still swap in a style's sample brief so
 * visitors who want a starting point can tour looks. The content is the same
 * style-keyed brief corpus that seeds the showcase "Try" links, so a shuffled
 * sample and a "Try this style" click read identically.
 */
import { briefForStyle } from '@/lib/style/brief-for-style';

type SampleStyle = { name: string; category: string | null };

/**
 * The sample script shown for a style, or null when the style has no
 * resolvable brief (a new style whose category isn't mapped yet) — the
 * composer then simply stays blank rather than seeding nothing useful.
 */
export function sampleScriptForStyle(style: SampleStyle): string | null {
  try {
    return briefForStyle(style);
  } catch {
    return null;
  }
}

/**
 * Pick the style whose sample the Shuffle button swaps in: uniformly random
 * among styles that have a sample, never the current one. `random` is
 * injected (Math.random in the app) so tests stay deterministic.
 */
export function pickShuffleStyle<T extends SampleStyle & { id: string }>(
  styles: T[],
  currentStyleId: string | null,
  random: () => number
): T | null {
  const candidates = styles.filter(
    (s) => s.id !== currentStyleId && sampleScriptForStyle(s) !== null
  );
  if (candidates.length === 0) return null;
  return candidates[Math.floor(random() * candidates.length)] ?? null;
}
