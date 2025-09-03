import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateFrameInput, UpdateFrameInput } from "#actions/frames";
import {
  bulkCreateFrames,
  createFrame,
  deleteFrame,
  deleteFramesBySequence,
  getFrame,
  getFramesBySequence,
  reorderFrames,
  updateFrame,
} from "#actions/frames";
import type { Frame } from "@/types/database";

// Query keys
export const frameKeys = {
  all: ["frames"] as const,
  lists: () => [...frameKeys.all, "list"] as const,
  list: (sequenceId: string) => [...frameKeys.lists(), sequenceId] as const,
  details: () => [...frameKeys.all, "detail"] as const,
  detail: (id: string) => [...frameKeys.details(), id] as const,
};

// Hook for listing frames by sequence
export function useFramesBySequence(sequenceId: string) {
  return useQuery<Frame[]>({
    queryKey: frameKeys.list(sequenceId),
    queryFn: async () => {
      const result = await getFramesBySequence(sequenceId);
      if (result.success && result.frames) {
        return result.frames;
      }
      throw new Error(result.error || "Failed to load frames");
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    enabled: !!sequenceId,
  });
}

// Hook for getting single frame
export function useFrame(frameId: string) {
  return useQuery<Frame>({
    queryKey: frameKeys.detail(frameId),
    queryFn: async () => {
      const result = await getFrame(frameId);
      if (result.success && result.frame) {
        return result.frame;
      }
      throw new Error(result.error || "Failed to load frame");
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!frameId,
  });
}

// Hook for creating frame
export function useCreateFrame() {
  const queryClient = useQueryClient();

  return useMutation<Frame, Error, CreateFrameInput>({
    mutationFn: async (input: CreateFrameInput) => {
      const result = await createFrame(input);
      if (result.success && result.frame) {
        return result.frame;
      }
      throw new Error(result.error || "Failed to create frame");
    },
    onSuccess: (data) => {
      // Invalidate frames list for the sequence
      if (data?.sequence_id) {
        queryClient.invalidateQueries({
          queryKey: frameKeys.list(data.sequence_id),
        });
      }
    },
  });
}

// Hook for updating frame
export function useUpdateFrame() {
  const queryClient = useQueryClient();

  return useMutation<Frame, Error, UpdateFrameInput>({
    mutationFn: async (input: UpdateFrameInput) => {
      const result = await updateFrame(input);
      if (result.success && result.frame) {
        return result.frame;
      }
      throw new Error(result.error || "Failed to update frame");
    },
    onSuccess: (data) => {
      // Update the specific frame in cache
      if (data?.id) {
        queryClient.setQueryData(frameKeys.detail(data.id), data);
      }
      // Invalidate frames list for the sequence
      if (data?.sequence_id) {
        queryClient.invalidateQueries({
          queryKey: frameKeys.list(data.sequence_id),
        });
      }
    },
  });
}

// Hook for deleting frame
export function useDeleteFrame() {
  const queryClient = useQueryClient();

  return useMutation<{ frameId: string; sequenceId?: string }, Error, string>({
    mutationFn: async (frameId: string) => {
      // First get the frame to know its sequence_id
      const frameData = queryClient.getQueryData<Frame>(
        frameKeys.detail(frameId),
      );
      const result = await deleteFrame({ id: frameId });
      if (result.success) {
        return { frameId, sequenceId: frameData?.sequence_id };
      }
      throw new Error(result.error || "Failed to delete frame");
    },
    onSuccess: ({ frameId, sequenceId }) => {
      // Remove from cache
      queryClient.removeQueries({ queryKey: frameKeys.detail(frameId) });
      // Invalidate sequence frames list
      if (sequenceId) {
        queryClient.invalidateQueries({
          queryKey: frameKeys.list(sequenceId),
        });
      }
    },
  });
}

// Hook for reordering frames
export function useReorderFrames() {
  const queryClient = useQueryClient();

  return useMutation<
    { sequenceId: string },
    Error,
    {
      sequenceId: string;
      frameOrders: Array<{ id: string; order_index: number }>;
    },
    { previousFrames: Frame[] | undefined; sequenceId: string }
  >({
    mutationFn: async ({
      sequenceId,
      frameOrders,
    }: {
      sequenceId: string;
      frameOrders: Array<{ id: string; order_index: number }>;
    }) => {
      const result = await reorderFrames(sequenceId, frameOrders);
      if (result.success) {
        return { sequenceId };
      }
      throw new Error(result.error || "Failed to reorder frames");
    },
    onMutate: async ({ sequenceId, frameOrders }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({
        queryKey: frameKeys.list(sequenceId),
      });

      // Snapshot previous value
      const previousFrames = queryClient.getQueryData<Frame[]>(
        frameKeys.list(sequenceId),
      );

      // Optimistically update frames order
      if (previousFrames) {
        const reorderedFrames = previousFrames
          .map((frame) => {
            const newOrder = frameOrders.find((o) => o.id === frame.id);
            return newOrder
              ? { ...frame, order_index: newOrder.order_index }
              : frame;
          })
          .sort((a, b) => a.order_index - b.order_index);

        queryClient.setQueryData(frameKeys.list(sequenceId), reorderedFrames);
      }

      return { previousFrames, sequenceId };
    },
    onError: (_, __, context) => {
      // Rollback to previous value on error
      if (context?.previousFrames && context.sequenceId) {
        queryClient.setQueryData(
          frameKeys.list(context.sequenceId),
          context.previousFrames,
        );
      }
    },
    onSettled: (_, __, { sequenceId }) => {
      // Always refetch after error or success
      queryClient.invalidateQueries({
        queryKey: frameKeys.list(sequenceId),
      });
    },
  });
}

// Hook for bulk creating frames
export function useBulkCreateFrames() {
  const queryClient = useQueryClient();

  return useMutation<
    Frame[],
    Error,
    {
      sequenceId: string;
      frames: Omit<CreateFrameInput, "sequence_id">[];
    }
  >({
    mutationFn: async ({
      sequenceId,
      frames,
    }: {
      sequenceId: string;
      frames: Omit<CreateFrameInput, "sequence_id">[];
    }) => {
      const result = await bulkCreateFrames(sequenceId, frames);
      if (result.success && result.frames) {
        return result.frames;
      }
      throw new Error(result.error || "Failed to create frames");
    },
    onSuccess: (_, { sequenceId }) => {
      // Invalidate frames list for the sequence
      queryClient.invalidateQueries({
        queryKey: frameKeys.list(sequenceId),
      });
    },
  });
}

// Hook for deleting all frames in a sequence
export function useDeleteFramesBySequence() {
  const queryClient = useQueryClient();

  return useMutation<string, Error, string>({
    mutationFn: async (sequenceId: string) => {
      const result = await deleteFramesBySequence(sequenceId);
      if (result.success) {
        return sequenceId;
      }
      throw new Error(result.error || "Failed to delete frames");
    },
    onSuccess: (sequenceId) => {
      // Clear frames list for the sequence
      queryClient.setQueryData(frameKeys.list(sequenceId), []);
      // Invalidate to ensure fresh data
      queryClient.invalidateQueries({
        queryKey: frameKeys.list(sequenceId),
      });
    },
  });
}
