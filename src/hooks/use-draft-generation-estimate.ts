import { estimateDraftGenerationFn } from '@/functions/pricing';
import { micros, type Microdollars } from '@/shared/billing/money';
import type { AspectRatio } from '@/shared/constants/aspect-ratios';
import type { Resolution } from '@/shared/constants/resolutions';
import type { GenerationStage } from '@/shared/generation/pipeline';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

export type DraftGenerationEstimateInput = {
  script: string;
  imageModels: readonly string[];
  videoModels: readonly string[];
  audioModels: readonly string[];
  aspectRatio: AspectRatio;
  resolution?: Resolution;
  stopAt: GenerationStage;
  generateStartFrames: boolean;
  targetDurationSeconds?: number;
};

export function useDraftGenerationEstimate(
  input: DraftGenerationEstimateInput | null
): Microdollars | null | undefined {
  const [debouncedScript, setDebouncedScript] = useState(input?.script ?? '');
  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedScript(input?.script ?? ''),
      300
    );
    return () => window.clearTimeout(timeout);
  }, [input?.script]);

  const enabled = Boolean(input && debouncedScript.trim());
  const { data } = useQuery({
    queryKey: [
      'draft-generation-estimate',
      debouncedScript,
      input?.imageModels,
      input?.videoModels,
      input?.audioModels,
      input?.aspectRatio,
      input?.resolution,
      input?.stopAt,
      input?.generateStartFrames,
      input?.targetDurationSeconds,
    ],
    queryFn: async () => {
      if (!input) return { estimateMicros: null };
      return estimateDraftGenerationFn({
        data: {
          script: debouncedScript,
          imageModels: [...input.imageModels],
          videoModels: [...input.videoModels],
          audioModels: [...input.audioModels],
          aspectRatio: input.aspectRatio,
          resolution: input.resolution,
          stopAt: input.stopAt,
          generateStartFrames: input.generateStartFrames,
          targetDurationSeconds: input.targetDurationSeconds,
        },
      });
    },
    enabled,
    staleTime: 30_000,
  });
  if (!input || !debouncedScript.trim()) return null;
  if (data === undefined) return undefined;
  return data.estimateMicros === null ? null : micros(data.estimateMicros);
}
