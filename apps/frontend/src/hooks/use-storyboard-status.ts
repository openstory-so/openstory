import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  getActiveFrameGenerationJob,
  getFramesBySequence,
} from "#actions/frames";
import { getSequence } from "#actions/sequence";
import type { Frame, Sequence } from "@/types/database";
import { frameKeys } from "./use-frames";
import { sequenceKeys } from "./use-sequences";

export interface FrameGenerationMetadata {
  frameGeneration?: {
    status?: string;
    expectedFrameCount?: number;
    completedFrameCount?: number;
    error?: string;
    failedAt?: string;
  };
}

export interface Job {
  id: string;
  type: string;
  status: string;
  progress?: number;
  result?: unknown;
  error?: string;
  created_at: string;
  updated_at: string;
  framesProgress?: {
    total: number;
    completed: number;
    frames: Array<{
      id: string;
      order_index: number;
      thumbnail_url?: string | null;
    }>;
  };
}

interface StoryboardStatus {
  sequence: Sequence | null;
  frames: Frame[];
  activeJob?: Job | null;
  isGenerating: boolean;
  hasFrames: boolean;
  canGenerate: boolean;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Unified hook for managing storyboard status and polling
 * Consolidates sequence, frames, and job status into a single coordinated query
 * Follows React rules: minimal React, externalized logic, TanStack Query for data fetching
 */
export function useStoryboardStatus(sequenceId: string): StoryboardStatus {
  const queryClient = useQueryClient();

  const {
    data,
    isLoading,
    error,
    refetch: refetchQuery,
  } = useQuery({
    queryKey: ["storyboard-status", sequenceId],
    queryFn: async () => {
      const [sequenceResult, framesResult, activeJobResult] = await Promise.all(
        [
          getSequence(sequenceId),
          getFramesBySequence(sequenceId),
          getActiveFrameGenerationJob(sequenceId),
        ],
      );

      // Extract data from results
      const sequence = sequenceResult.success ? sequenceResult.sequence : null;
      const frames = framesResult.success ? framesResult.frames || [] : [];
      const activeJob = activeJobResult.success ? activeJobResult.job : null;

      return {
        sequence: sequence as Sequence | null,
        frames,
        activeJob,
      };
    },
    enabled: !!sequenceId,
    staleTime: 1000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      if (!query.state.data) return false;

      const { sequence, activeJob } = query.state.data;

      const metadata = sequence?.metadata as FrameGenerationMetadata | null;
      const sequenceGenerating =
        sequence?.status === "processing" ||
        metadata?.frameGeneration?.status === "processing" ||
        metadata?.frameGeneration?.status === "generating_thumbnails";

      const jobGenerating =
        activeJob?.status === "running" || activeJob?.status === "pending";

      const isGenerating = sequenceGenerating || jobGenerating;
      return isGenerating ? 2000 : false;
    },
  });

  const refetch = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: sequenceKeys.detail(sequenceId),
      }),
      queryClient.invalidateQueries({ queryKey: frameKeys.list(sequenceId) }),
      queryClient.invalidateQueries({ queryKey: ["active-job", sequenceId] }),
    ]);

    await refetchQuery();
  };

  const derivedState = useMemo(() => {
    if (!data) {
      return {
        sequence: null,
        frames: [],
        activeJob: null,
        isGenerating: false,
        hasFrames: false,
        canGenerate: false,
      };
    }

    const { sequence, frames, activeJob } = data;

    // Check if generation is in progress
    const metadata = sequence?.metadata as FrameGenerationMetadata | null;
    const sequenceGenerating =
      sequence?.status === "processing" ||
      metadata?.frameGeneration?.status === "processing" ||
      metadata?.frameGeneration?.status === "generating_thumbnails";

    const jobGenerating =
      activeJob?.status === "running" || activeJob?.status === "pending";

    const isGenerating = sequenceGenerating || jobGenerating;
    const hasFrames = frames.length > 0;
    const styleId = sequence?.style_id;

    // Can generate if we have script, style, and not currently generating
    const canGenerate = Boolean(
      sequence?.script &&
        sequence.script.trim().length >= 10 &&
        styleId &&
        !isGenerating,
    );

    return {
      sequence,
      frames,
      activeJob,
      isGenerating,
      hasFrames,
      canGenerate,
    };
  }, [data]);

  return {
    ...derivedState,
    isLoading,
    error: error as Error | null,
    refetch,
  };
}

export function useIsGenerating(sequenceId: string): boolean {
  const { isGenerating } = useStoryboardStatus(sequenceId);
  return isGenerating;
}

export function useStoryboardFrames(sequenceId: string): {
  frames: Frame[];
  isLoading: boolean;
  refetch: () => Promise<void>;
} {
  const { frames, isLoading, refetch } = useStoryboardStatus(sequenceId);
  return { frames, isLoading, refetch };
}
