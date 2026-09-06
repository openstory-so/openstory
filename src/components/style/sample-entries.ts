/**
 * Pure builders for the style sample-video gallery/showcase (#956).
 *
 * Flattens public styles into displayable sample entries. Kept free of React so
 * it can be unit-tested directly and shared by the logged-out showcase and the
 * gallery page.
 */
import {
  DEFAULT_ASPECT_RATIO,
  type AspectRatio,
} from '@/shared/constants/aspect-ratios';
import type { StyleSampleVideo } from '@/lib/db/schema/libraries';
import { briefForStyle } from '@/shared/style/brief-for-style';
import { styleCanonicalVideoUrl } from '@/components/style/style-assets';
import { styleSlug } from '@/shared/style/style-slug';
import type { Style } from '@/lib/db/schema';

export type SampleEntry = {
  /** Stable list key — a style can contribute more than one sample (kinds). */
  key: string;
  styleId: string;
  styleName: string;
  /** Human-readable slug (`cinematic-noir`) — the composer prefill link uses it
   *  as `?style=<slug>` instead of the opaque id. */
  slug: string;
  video: StyleSampleVideo;
  aspectRatio: AspectRatio;
  /** True when this style resolves a brief, so the composer can be seeded. */
  hasBrief: boolean;
};

function aspectRatioOf(style: Style): AspectRatio {
  switch (style.defaultAspectRatio) {
    case '9:16':
      return '9:16';
    case '1:1':
      return '1:1';
    default:
      return DEFAULT_ASPECT_RATIO;
  }
}

/** Whether a style resolves a brief (a future unmapped style would throw). */
function styleHasBrief(style: Style): boolean {
  try {
    return briefForStyle({ name: style.name, category: style.category }) !== '';
  } catch {
    return false;
  }
}

/**
 * Prefer persisted `sampleVideos` (bespoke → canonical → first by order). When
 * the column is empty — PR-preview / fresh D1 seeds skip that column — fall
 * back to the derived `…/canonical.mp4` next to the style thumbnail so the
 * logged-out showcase still has clips to show (#1104).
 */
function pickSampleVideo(style: Style): StyleSampleVideo | null {
  const samples = style.sampleVideos ?? [];
  if (samples.length > 0) {
    const ordered = [...samples].sort((a, b) => a.order - b.order);
    return (
      ordered.find((s) => s.kind === 'bespoke') ??
      ordered.find((s) => s.kind === 'canonical') ??
      ordered[0] ??
      null
    );
  }
  const derived = styleCanonicalVideoUrl(style);
  if (!derived) return null;
  return {
    url: derived,
    kind: 'canonical',
    label: 'canonical',
    durationSeconds: 15,
    order: 0,
  };
}

/**
 * Flatten styles into one displayable sample entry per style — the style's
 * bespoke showcase clip when it has one, otherwise its canonical sample (else
 * the lowest-order clip). Used by both the gallery and the logged-out showcase.
 *
 * Styles arrive already ordered by the query (`sortOrder`, then name), so the
 * gallery/showcase order is the styles' own order. Styles with no sample video
 * and no derivable `canonical.mp4` are skipped.
 */
export function buildSampleEntries(styles: Style[]): SampleEntry[] {
  const entries: SampleEntry[] = [];
  for (const style of styles) {
    const video = pickSampleVideo(style);
    if (!video) continue;

    entries.push({
      key: `${style.id}:${video.kind}`,
      styleId: style.id,
      styleName: style.name,
      slug: styleSlug(style.name),
      video,
      aspectRatio: aspectRatioOf(style),
      hasBrief: styleHasBrief(style),
    });
  }
  return entries;
}
