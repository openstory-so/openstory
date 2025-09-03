import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateStyleInput } from "@/app/actions/styles";

// Import the actions (will resolve to mock in Storybook)
const actions = import("@/app/actions/styles");

// Query keys
export const styleKeys = {
  all: ["styles"] as const,
  lists: () => [...styleKeys.all, "list"] as const,
  list: (teamId?: string) => [...styleKeys.lists(), teamId] as const,
  details: () => [...styleKeys.all, "detail"] as const,
  detail: (id: string) => [...styleKeys.details(), id] as const,
};

// Hook for listing styles
export function useStyles(teamId?: string) {
  return useQuery({
    queryKey: styleKeys.list(teamId),
    queryFn: async () => {
      const { listStyles } = await actions;
      return listStyles(teamId);
    },
    staleTime: 10 * 60 * 1000, // 10 minutes (styles change less frequently)
  });
}

// Hook for getting single style
export function useStyle(id: string) {
  return useQuery({
    queryKey: styleKeys.detail(id),
    queryFn: async () => {
      const { getStyle } = await actions;
      return getStyle(id);
    },
    staleTime: 10 * 60 * 1000,
    enabled: !!id,
  });
}

// Hook for creating style
export function useCreateStyle() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateStyleInput) => {
      const { createStyle } = await actions;
      return createStyle(input);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: styleKeys.lists() });
    },
  });
}

// Hook for updating style
export function useUpdateStyle() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      input,
    }: {
      id: string;
      input: Partial<CreateStyleInput>;
    }) => {
      const { updateStyle } = await actions;
      return updateStyle(id, input);
    },
    onSuccess: (data, _variables) => {
      const result = data as unknown;
      if (
        result &&
        typeof result === "object" &&
        result !== null &&
        "id" in result &&
        typeof result.id === "string"
      ) {
        queryClient.setQueryData(styleKeys.detail(result.id), result);
      }
      queryClient.invalidateQueries({ queryKey: styleKeys.lists() });
    },
  });
}

// Hook for deleting style
export function useDeleteStyle() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { deleteStyle } = await actions;
      return deleteStyle(id);
    },
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: styleKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: styleKeys.lists() });
    },
  });
}
