import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSequence, listSequences, saveSequence } from "#actions/sequence";
import type { Sequence } from "@/types/database";

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
      const result = await listSequences();
      if (result.success && result.sequences) {
        return result.sequences;
      }
      throw new Error(result.error || "Failed to load sequences");
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

// Hook for getting single sequence
export function useSequence(
  id: string,
  options?: {
    refetchInterval?: number | false;
    staleTime?: number;
  },
) {
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
    staleTime: options?.staleTime ?? 1000, // Default to 1 second for better responsiveness
    enabled: !!id,
    refetchInterval: options?.refetchInterval,
    refetchOnMount: "always", // Always refetch on mount to ensure fresh data
    refetchOnWindowFocus: true, // Refetch when window regains focus
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
