import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CreateStyleInput,
  createStyle,
  deleteStyle,
  getStyle,
  listStyles,
  updateStyle,
} from "#actions/styles";
import type { Style } from "@/types/database";

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
  return useQuery<Style[]>({
    queryKey: styleKeys.list(teamId),
    queryFn: async () => {
      const result = await listStyles();
      if (result.success && result.styles) {
        return result.styles;
      }
      throw new Error(result.error || "Failed to list styles");
    },
    staleTime: 10 * 60 * 1000, // 10 minutes (styles change less frequently)
  });
}

// Hook for getting single style
export function useStyle(id: string) {
  return useQuery<Style>({
    queryKey: styleKeys.detail(id),
    queryFn: async () => {
      const result = await getStyle(id);
      if (result.success && result.style) {
        return result.style;
      }
      throw new Error(result.error || "Failed to get style");
    },
    staleTime: 10 * 60 * 1000,
    enabled: !!id,
  });
}

// Hook for creating style
export function useCreateStyle() {
  const queryClient = useQueryClient();

  return useMutation<unknown, Error, CreateStyleInput>({
    mutationFn: async (input: CreateStyleInput) => {
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

  return useMutation<
    unknown,
    Error,
    {
      id: string;
      input: Partial<CreateStyleInput>;
    }
  >({
    mutationFn: async ({
      id,
      input,
    }: {
      id: string;
      input: Partial<CreateStyleInput>;
    }) => {
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

  return useMutation<void, Error, string>({
    mutationFn: async (id: string) => {
      await deleteStyle(id);
    },
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: styleKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: styleKeys.lists() });
    },
  });
}
