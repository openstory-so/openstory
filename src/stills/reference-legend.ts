/**
 * Shared helpers for binding reference images into a generation prompt (#873).
 *
 * The preferred binding is INLINE: prompts name entities by canonical token
 * (a character's bible name, an element's UPPERCASE token), and
 * `substituteReferenceTags` rewrites those occurrences into the target
 * model's reference syntax — a video model's tag (`@Image2`, `@Element1`) or
 * an image model's positional binding (`SCARLETT (Image 2)`) — matching how
 * vendor examples weave tags into the narrative ("the fruit tea from
 * @Image2"). A trailing legend line is the fallback for references never
 * mentioned in the prompt; the legend is load-bearing — dropping it orphans
 * the reference images — so when the combined text exceeds the model's prompt
 * limit we truncate the BASE prompt and always keep the legend intact.
 */

import type { ReferenceImageDescription } from './reference-image-prompt';

/**
 * Replace whole-token mentions in `prompt` with each entry's rendering.
 * Matching is case-insensitive and word-bounded, so "SCARLETT"/"Scarlett"
 * match a `Scarlett` token but "jacket" never matches `jack`. Returns which
 * entries were found so callers can fall back to a legend for the rest.
 * Reserved machine markers can opt into case-sensitive matching to avoid
 * binding ordinary prose such as "dialogue" to the DIALOGUE recording.
 *
 * Spoken or written words are never touched: a name inside a line of dialogue
 * is something a person SAYS, and a video model voiced `"Hello Steve."` as
 * "hello image 4" once STEVE had a sheet bound (#1657). A mention inside one
 * does not count as `mentioned` either, so the legend still binds the sheet.
 */
export function substituteReferenceTags(
  prompt: string,
  entries: Array<{ token?: string; render: string; caseSensitive?: boolean }>
): { prompt: string; mentioned: boolean[] } {
  // Odd indexes are the quoted spans (`split` with a capture group).
  const segments = prompt.split(QUOTED_SPAN);
  const mentioned = entries.map(() => false);
  entries.forEach((entry, index) => {
    if (!entry.token) return;
    const pattern = new RegExp(
      `(?<=^|[^A-Za-z0-9_])${escapeRegex(entry.token)}(?=[^A-Za-z0-9_]|$)`,
      entry.caseSensitive ? 'g' : 'gi'
    );
    for (let at = 0; at < segments.length; at += 2) {
      segments[at] = (segments[at] ?? '').replace(pattern, () => {
        mentioned[index] = true;
        return entry.render;
      });
    }
  });
  return { prompt: segments.join(''), mentioned };
}

/**
 * Every shape the motion assemblers wrap spoken words in — `"…"` (narrative,
 * Kling), `{…}` (Seedance), `<d>…</d>` — plus typographic quotes from prose.
 */
const QUOTED_SPAN = /("[^"\n]*"|“[^”\n]*”|\{[^{}\n]*\}|<d>[\s\S]*?<\/d>)/;

/**
 * Render a reference description for inline prose substitution on models with
 * no reference-image support: `"Scarlett - Athletic build"` becomes
 * `"Scarlett (Athletic build)"` so the sentence still reads naturally.
 */
export function inlineReferenceDescription(
  ref: ReferenceImageDescription
): string {
  const match = ref.description.match(/^(.+?) - (.+)$/);
  if (!match?.[1] || !match[2]) return ref.description;
  return `${match[1]} (${match[2]})`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function appendLegendWithinLimit(
  basePrompt: string,
  legend: string,
  maxLength?: number
): string {
  const joiner = '\n\n';
  const combined = `${basePrompt}${joiner}${legend}`;
  if (!maxLength || combined.length <= maxLength) return combined;

  const available = maxLength - legend.length - joiner.length - 3; // 3 for '...'
  if (available <= 0) {
    // Legend alone exceeds the limit (only with absurdly long descriptions) —
    // hand it back whole and let the downstream transform clamp it.
    return legend;
  }
  return `${basePrompt.slice(0, available)}...${joiner}${legend}`;
}
