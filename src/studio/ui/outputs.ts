import type {
  GeneratedAsset,
  GeneratedAssetOutput,
} from '@/platform/server/db/schema';
import type { AspectRatio } from '@/models/aspect-ratios';
import { aspectRatioSchema } from '@/models/aspect-ratios';

export function studioPrimaryOutput(
  asset: GeneratedAsset
): GeneratedAssetOutput | undefined {
  const outputs = asset.outputs ?? [];
  const prefix = asset.activity === 'video' ? 'video/' : 'image/';
  return (
    outputs.find((output) => output.contentType.startsWith(prefix)) ??
    outputs[0]
  );
}

export function studioPosterOutput(
  asset: GeneratedAsset
): GeneratedAssetOutput | undefined {
  return (asset.outputs ?? []).find((output) =>
    output.contentType.startsWith('image/')
  );
}

export function studioAspectRatio(asset: GeneratedAsset): AspectRatio {
  const value = asset.input.aspectRatio;
  const parsed = aspectRatioSchema.safeParse(value);
  return parsed.success ? parsed.data : '16:9';
}

export function studioPrompt(asset: GeneratedAsset): string {
  const value = asset.input.prompt;
  return typeof value === 'string' ? value : '';
}

/**
 * Absolute URL to paste. Stored media is origin-relative (`/r2/<key>`), and
 * the public `/r2/$` route serves it (redirecting to the CDN in production).
 */
export function studioShareUrl(url: string, origin: string): string {
  return new URL(url, origin).href;
}

/**
 * Same-origin download. `?download` makes the worker stream the object with
 * `content-disposition: attachment` instead of redirecting to the CDN, where
 * `<a download>` is ignored and the tab plays the file inline.
 */
export function studioDownloadHref(url: string): string {
  const hashAt = url.indexOf('#');
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  return `${base}${base.includes('?') ? '&' : '?'}download${hash}`;
}

export function studioDownloadFilename(
  id: string,
  contentType: string
): string {
  const ext = contentType.split('/')[1]?.split(';')[0]?.trim() || 'bin';
  return `openstory-${id}.${ext}`;
}
