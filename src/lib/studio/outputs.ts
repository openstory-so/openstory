import type { GeneratedAsset, GeneratedAssetOutput } from '@/lib/db/schema';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { aspectRatioSchema } from '@/lib/constants/aspect-ratios';

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
