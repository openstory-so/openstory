import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { generateFrames, getSequence, saveSequence } from "#actions/sequence";
import type { Frame, Sequence } from "@/types/database";

// Query keys
export const sequenceKeys = {
  all: ["sequences"] as const,
  lists: () => [...sequenceKeys.all, "list"] as const,
  list: (teamId?: string) => [...sequenceKeys.lists(), teamId] as const,
  details: () => [...sequenceKeys.all, "detail"] as const,
  detail: (id: string) => [...sequenceKeys.details(), id] as const,
};

// Hook for listing sequences
export function useSequences(teamId?: string) {
  return useQuery<Sequence[]>({
    queryKey: sequenceKeys.list(teamId),
    queryFn: async () => {
      // For now, return empty array as we don't have a list endpoint yet
      // This would be implemented when we have a list sequences API
      return [] as Sequence[];
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

// Hook for getting single sequence
export function useSequence(id: string) {
  return useQuery<Sequence>({
    queryKey: sequenceKeys.detail(id),
    queryFn: async () => {
      const result = await getSequence(id);
      if (result.success && result.sequence) {
        // Note: getSequence returns sequence with frames, but we only want the sequence data
        // The frames should be fetched separately using useFramesBySequence
        return result.sequence as unknown as Sequence;
      }
      throw new Error(result.error || "Failed to load sequence");
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!id,
  });
}

// Hook for creating sequence
export function useCreateSequence() {
  const queryClient = useQueryClient();

  return useMutation<
    Sequence,
    Error,
    {
      script: string;
      styleId: string | null;
      name?: string;
    }
  >({
    mutationFn: async (input: {
      script: string;
      styleId: string | null;
      name?: string;
    }) => {
      const result = await saveSequence(
        input.script,
        input.styleId,
        undefined,
        input.name,
      );
      if (result.success && result.sequence) {
        return result.sequence;
      }
      throw new Error(result.error || "Failed to create sequence");
    },
    onSuccess: () => {
      // Invalidate and refetch sequences list
      queryClient.invalidateQueries({ queryKey: sequenceKeys.lists() });
    },
  });
}

// Hook for updating sequence
export function useUpdateSequence() {
  const queryClient = useQueryClient();

  return useMutation<
    Sequence,
    Error,
    {
      id: string;
      name?: string;
      script?: string;
      styleId?: string | null;
    }
  >({
    mutationFn: async (input: {
      id: string;
      name?: string;
      script?: string;
      styleId?: string | null;
    }) => {
      const result = await saveSequence(
        input.script || "",
        input.styleId !== undefined ? input.styleId : null,
        input.id,
        input.name,
      );
      if (result.success && result.sequence) {
        return result.sequence;
      }
      throw new Error(result.error || "Failed to update sequence");
    },
    onSuccess: (data) => {
      // Update the specific sequence in cache
      if (data?.id) {
        queryClient.setQueryData(sequenceKeys.detail(data.id), data);
      }
      // Invalidate lists to ensure consistency
      queryClient.invalidateQueries({ queryKey: sequenceKeys.lists() });
    },
  });
}

// Hook for deleting sequence
export function useDeleteSequence() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: async (_id: string) => {
      // Delete sequence API to be implemented
      throw new Error("Delete sequence not yet implemented");
    },
    onSuccess: (_, id) => {
      // Remove from cache
      queryClient.removeQueries({ queryKey: sequenceKeys.detail(id) });
      // Invalidate lists
      queryClient.invalidateQueries({ queryKey: sequenceKeys.lists() });
    },
  });
}

// Hook for generating storyboard
export function useGenerateStoryboard() {
  const queryClient = useQueryClient();

  return useMutation<
    Frame[],
    Error,
    {
      sequenceId: string;
      script: string;
      styleId: string;
    }
  >({
    mutationFn: async ({
      sequenceId,
      script,
      styleId,
    }: {
      sequenceId: string;
      script: string;
      styleId: string;
    }) => {
      const result = await generateFrames(script, styleId, sequenceId);
      if (result.success && result.frames) {
        return result.frames;
      }
      throw new Error(result.error || "Failed to generate storyboard");
    },
    onSuccess: (_, { sequenceId }) => {
      // Invalidate the sequence to get updated status
      queryClient.invalidateQueries({
        queryKey: sequenceKeys.detail(sequenceId),
      });
    },
  });
}
