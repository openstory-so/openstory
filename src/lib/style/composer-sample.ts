/**
 * Composer sample-script helpers (issue #1187, revised in #1255 and #1393).
 *
 * The bare composer starts empty (placeholder visible, Automatic selected).
 * Shuffle and the style-detail "Try" still swap in a style's sample brief so
 * visitors who want a starting point can tour looks. The content is the same
 * style-keyed brief corpus that seeds the showcase "Try" links, so a shuffled
 * sample and a "Try this style" click read identically.
 *
 * Each style has six samples (#1393): the canonical brief — the one the
 * rendered sample video was made from, and the only one the `?style=` seed
 * uses, since that has to stay deterministic — plus five alternatives in
 * `STYLE_BRIEF_VARIANTS`. Shuffle picks among all of them, so touring the same
 * style twice doesn't show the same script twice. They are code, not data:
 * resolved by style-name slug, so a team's own style still falls back to its
 * category brief.
 */
import { briefForStyle } from '@/lib/style/brief-for-style';
import { STYLE_BRIEF_VARIANTS } from '@/lib/style/style-brief-variants.generated';
import { styleSlug } from '@/lib/style/style-slug';

type SampleStyle = { name: string; category: string | null };

/**
 * Every sample script available for a style — canonical first — or an empty
 * array when the style has no resolvable brief (a new style whose category
 * isn't mapped yet), in which case the composer stays blank rather than
 * seeding nothing useful.
 */
export function sampleScriptsForStyle(style: SampleStyle): string[] {
  let canonical: string;
  try {
    canonical = briefForStyle(style);
  } catch {
    return [];
  }
  const variants = STYLE_BRIEF_VARIANTS[styleSlug(style.name)] ?? [];
  return [canonical, ...variants.filter((v) => v !== canonical)];
}

/** Whether a style has any sample to show. */
function hasSampleScript(style: SampleStyle): boolean {
  return sampleScriptsForStyle(style).length > 0;
}

/**
 * One sample script for a style, or null when it has none. `random` is
 * injected (Math.random in the app) so tests stay deterministic.
 */
export function sampleScriptForStyle(
  style: SampleStyle,
  random: () => number = Math.random
): string | null {
  const samples = sampleScriptsForStyle(style);
  if (samples.length === 0) return null;
  return samples[Math.floor(random() * samples.length)] ?? null;
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
    (s) => s.id !== currentStyleId && hasSampleScript(s)
  );
  if (candidates.length === 0) return null;
  return candidates[Math.floor(random() * candidates.length)] ?? null;
}
