import { estimateDraftGenerationFn } from '@/billing/pricing.fn';
import { micros, type Microdollars } from '@/billing/money';
import type { AspectRatio } from '@/models/aspect-ratios';
import type { Resolution } from '@/models/resolutions';
import { useAuthSession } from '@/platform/ui/auth/session-query';
import type { GenerationStage } from '@/sequences/pipeline';
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
  // Composer is anonymous-browsable; the fn is not. Don't fire (and
  // error-log AUTHENTICATION_ERROR) without a session — same gate as
  // useSequences (#1333, #1575).
  const { data: session } = useAuthSession();
  const [debouncedScript, setDebouncedScript] = useState(input?.script ?? '');
  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedScript(input?.script ?? ''),
      300
    );
    return () => window.clearTimeout(timeout);
  }, [input?.script]);

  const enabled = Boolean(session && input && debouncedScript.trim());
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
