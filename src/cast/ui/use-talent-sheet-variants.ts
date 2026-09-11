import {
  discardTalentSheetVariantFn,
  getTalentDivergentVariantsFn,
  getTeamTalentDivergentVariantsFn,
  promoteTalentSheetVariantFn,
  undiscardTalentSheetVariantFn,
} from '@/cast/talent-sheet-variants.fn';
import { talentKeys } from './use-talent';
import { useUser } from '@/platform/ui/use-user';
import type { TalentSheetVariant } from '@/platform/server/db/schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const talentSheetVariantKeys = {
  all: ['talent-sheet-variants'] as const,
  divergentTeam: () => [...talentSheetVariantKeys.all, 'team'] as const,
  divergentByTalent: (talentId: string) =>
    [...talentSheetVariantKeys.all, 'talent', talentId] as const,
};

/**
 * Active divergent variants across every talent the team can see. Drives the
 * corner-dot indicator on `talent-library-card`.
 */
export function useTeamTalentDivergentVariants(options?: {
  refetchInterval?: number | false;
}) {
  const { data: user } = useUser();

  return useQuery<TalentSheetVariant[]>({
    queryKey: talentSheetVariantKeys.divergentTeam(),
    queryFn: () => getTeamTalentDivergentVariantsFn(),
    staleTime: 30_000,
    refetchInterval: options?.refetchInterval ?? false,
    enabled: !!user,
  });
}

/**
 * Active divergent variants for a single talent's sheets. Drives the banner
 * inside `edit-talent-dialog`.
 */
export function useTalentDivergentVariants(talentId: string | undefined) {
  return useQuery<TalentSheetVariant[]>({
    queryKey: talentSheetVariantKeys.divergentByTalent(talentId ?? ''),
    queryFn: async () => {
      if (!talentId) throw new Error('talentId is required');
      return getTalentDivergentVariantsFn({ data: { talentId } });
    },
    enabled: !!talentId,
    staleTime: 30_000,
  });
}

type VariantInput = { variantId: string; talentId?: string };

export function usePromoteTalentSheetVariant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: VariantInput) =>
      promoteTalentSheetVariantFn({ data: { variantId: input.variantId } }),
    onSuccess: async (_data, input) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: talentSheetVariantKeys.divergentTeam(),
        }),
        input.talentId
          ? queryClient.invalidateQueries({
              queryKey: talentSheetVariantKeys.divergentByTalent(
                input.talentId
              ),
            })
          : Promise.resolve(),
        // The promoted url overwrites talent_sheets.imageUrl — invalidate the
        // talent list so the new sheet image appears.
        queryClient.invalidateQueries({ queryKey: talentKeys.all }),
      ]);
    },
  });
}

export function useDiscardTalentSheetVariant() {
  const queryClient = useQueryClient();
  return useMutation<
    { variantId: string; discardedAt: Date },
    Error,
    VariantInput
  >({
    mutationFn: async (input) =>
      discardTalentSheetVariantFn({ data: { variantId: input.variantId } }),
    onSuccess: async (_data, input) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: talentSheetVariantKeys.divergentTeam(),
        }),
        input.talentId
          ? queryClient.invalidateQueries({
              queryKey: talentSheetVariantKeys.divergentByTalent(
                input.talentId
              ),
            })
          : Promise.resolve(),
      ]);
    },
  });
}

export function useUndiscardTalentSheetVariant() {
  const queryClient = useQueryClient();
  return useMutation<{ variantId: string }, Error, VariantInput>({
    mutationFn: async (input) =>
      undiscardTalentSheetVariantFn({ data: { variantId: input.variantId } }),
    onSuccess: async (_data, input) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: talentSheetVariantKeys.divergentTeam(),
        }),
        input.talentId
          ? queryClient.invalidateQueries({
              queryKey: talentSheetVariantKeys.divergentByTalent(
                input.talentId
              ),
            })
          : Promise.resolve(),
      ]);
    },
  });
}
