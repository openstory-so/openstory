import {
  analyzeDraftElementFn,
  deleteSequenceElementFn,
  finalizeElementUploadFn,
  getShotCountsByElementFn,
  listSequenceElementsFn,
  presignDraftElementUploadFn,
  presignElementUploadFn,
  renameSequenceElementTokenFn,
  replaceSequenceElementFn,
  restoreSequenceElementFn,
} from '@/functions/sequence-elements';
import { putToR2 } from '@/lib/utils/upload';
import { sceneKeys } from '@/hooks/use-scenes';
import { shotStalenessNamespace } from '@/hooks/use-shot-staleness';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

export const sequenceElementKeys = {
  all: ['sequence-elements'] as const,
  bySequence: (sequenceId: string) =>
    ['sequence-elements', sequenceId] as const,
  shotsForElement: (sequenceId: string, elementId: string) =>
    ['sequence-elements', sequenceId, 'shots', elementId] as const,
  shotCountsBySequence: (sequenceId: string) =>
    ['sequence-elements', sequenceId, 'shot-counts'] as const,
};

export function useSequenceElements(sequenceId: string | undefined) {
  return useQuery({
    queryKey: sequenceId
      ? sequenceElementKeys.bySequence(sequenceId)
      : ['sequence-elements', 'none'],
    queryFn: () =>
      listSequenceElementsFn({ data: { sequenceId: sequenceId ?? '' } }),
    enabled: Boolean(sequenceId),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const hasPending = data.some(
        (el) => el.visionStatus === 'pending' || el.visionStatus === 'analyzing'
      );
      return hasPending ? 2000 : false;
    },
  });
}

/**
 * Upload an element file into an existing sequence: presign → R2 → finalize.
 */
export function useUploadElementToSequence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      file: File;
      sequenceId: string;
      onProgress?: (percent: number) => void;
    }) => {
      const presign = await presignElementUploadFn({
        data: { filename: data.file.name, sequenceId: data.sequenceId },
      });
      await putToR2(
        presign.uploadUrl,
        data.file,
        presign.contentType,
        data.onProgress
      );
      const element = await finalizeElementUploadFn({
        data: {
          sequenceId: data.sequenceId,
          publicUrl: presign.publicUrl,
          path: presign.path,
          filename: data.file.name,
        },
      });
      return element;
    },
    onSuccess: (_element, variables) => {
      void queryClient.invalidateQueries({
        queryKey: sequenceElementKeys.bySequence(variables.sequenceId),
      });
    },
  });
}

export type DraftElementUpload = {
  tempPath: string;
  tempPublicUrl: string;
  filename: string;
  token: string;
  /**
   * Vision-LLM description, populated during draft upload. `useUploadDraftElement`
   * rejects if vision fails, so successful uploads always carry both fields —
   * but `promoteTempElements` still accepts nullable values for backwards-compat
   * with E2E fixture paths and falls back to the async vision workflow there.
   */
  description: string | null;
  consistencyTag: string | null;
};

/**
 * Upload an element file as a *draft* (before a sequence exists). Returns the
 * temp storage path + public URL so the caller can persist it in local state
 * and pass it to the createSequence mutation for promotion.
 *
 * Runs vision analysis inline after the upload resolves so promoteTempElements
 * can write the row in `completed` state with description + consistencyTag
 * already populated. The mutation rejects on vision failure — the element
 * selector surfaces this as an error entry and the user must retry or remove
 * the upload before Generate can proceed. (This is what stops a `pending`
 * element from reaching the analyze workflow and poisoning prompt hashes.)
 */
export function useUploadDraftElement() {
  return useMutation({
    mutationFn: async (data: {
      file: File;
      onProgress?: (percent: number) => void;
      onAnalyzingChange?: (analyzing: boolean) => void;
    }): Promise<DraftElementUpload> => {
      const presign = await presignDraftElementUploadFn({
        data: { filename: data.file.name },
      });
      await putToR2(
        presign.uploadUrl,
        data.file,
        presign.contentType,
        data.onProgress
      );
      data.onAnalyzingChange?.(true);
      let result: {
        description: string;
        consistencyTag: string;
        suggestedToken: string;
      };
      try {
        result = await analyzeDraftElementFn({
          data: {
            publicUrl: presign.publicUrl,
            filename: data.file.name,
          },
        });
      } finally {
        data.onAnalyzingChange?.(false);
      }

      return {
        tempPath: presign.path,
        tempPublicUrl: presign.publicUrl,
        filename: data.file.name,
        token: result.suggestedToken,
        description: result.description,
        consistencyTag: result.consistencyTag,
      };
    },
  });
}

/**
 * Soft-delete (#1108 Phase 2) — the server sets `deletedAt`; undo via
 * `restoreSequenceElement` from the toast. A removed element drops out of the
 * prompt-reference context, so facet membership and staleness refresh too.
 */
export function useDeleteSequenceElement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { elementId: string; sequenceId: string }) =>
      deleteSequenceElementFn({ data }),
    onSuccess: (_res, variables) =>
      invalidateElementMembership(queryClient, variables.sequenceId),
  });
}

/**
 * Restore is a plain async, not a hook: it runs from undo-toast closures that
 * outlive the removing component (see `restoreSequenceCharacter` for the full
 * rationale). The app-level QueryClient stays valid.
 */
export async function restoreSequenceElement(
  queryClient: QueryClient,
  data: { sequenceId: string; elementId: string }
): Promise<void> {
  await restoreSequenceElementFn({ data });
  invalidateElementMembership(queryClient, data.sequenceId);
}

function invalidateElementMembership(
  queryClient: QueryClient,
  sequenceId: string
): void {
  void queryClient.invalidateQueries({
    queryKey: sequenceElementKeys.bySequence(sequenceId),
  });
  void queryClient.invalidateQueries({
    queryKey: sequenceElementKeys.shotCountsBySequence(sequenceId),
  });
  void queryClient.invalidateQueries({ queryKey: ['scene-facets'] });
  void queryClient.invalidateQueries({ queryKey: shotStalenessNamespace });
}

export function useRenameSequenceElementToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      elementId: string;
      sequenceId: string;
      token: string;
    }) => renameSequenceElementTokenFn({ data }),
    onSuccess: (result, variables) => {
      void queryClient.invalidateQueries({
        queryKey: sequenceElementKeys.bySequence(variables.sequenceId),
      });
      // cascadeRename rewrites the sequence script and selected scene-script
      // versions — refresh the composed script so editors showing it update.
      void queryClient.invalidateQueries({
        queryKey: sceneKeys.composedScript(variables.sequenceId),
      });
      // Shots now contain the new token in metadata / prompts. Refresh
      // anything that renders shot text or counts.
      if (result.shotsUpdated > 0) {
        void queryClient.invalidateQueries({ queryKey: ['shots'] });
        void queryClient.invalidateQueries({
          queryKey: sequenceElementKeys.shotCountsBySequence(
            variables.sequenceId
          ),
        });
      }
    },
  });
}

/**
 * Shot counts for *all* elements in a sequence, fetched in one query.
 * Use this from the elements grid to avoid the per-card N+1.
 */
export function useShotCountsForAllElements(sequenceId: string | undefined) {
  return useQuery({
    queryKey: sequenceId
      ? sequenceElementKeys.shotCountsBySequence(sequenceId)
      : ['sequence-elements', 'shot-counts', 'none'],
    queryFn: () =>
      getShotCountsByElementFn({ data: { sequenceId: sequenceId ?? '' } }),
    enabled: Boolean(sequenceId),
    staleTime: 60 * 1000,
  });
}

/**
 * Replace an element image: presign → R2 → persist + vision.
 * Affected shots are left stale for the user to update.
 */
export function useReplaceSequenceElement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      file: File;
      sequenceId: string;
      elementId: string;
      onProgress?: (percent: number) => void;
    }) => {
      const presign = await presignElementUploadFn({
        data: { filename: data.file.name, sequenceId: data.sequenceId },
      });
      await putToR2(
        presign.uploadUrl,
        data.file,
        presign.contentType,
        data.onProgress
      );
      return await replaceSequenceElementFn({
        data: {
          sequenceId: data.sequenceId,
          elementId: data.elementId,
          publicUrl: presign.publicUrl,
          path: presign.path,
          filename: data.file.name,
        },
      });
    },
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({
        queryKey: sequenceElementKeys.bySequence(variables.sequenceId),
      });
      void queryClient.invalidateQueries({
        queryKey: sequenceElementKeys.shotsForElement(
          variables.sequenceId,
          variables.elementId
        ),
      });
      void queryClient.invalidateQueries({
        queryKey: sequenceElementKeys.shotCountsBySequence(
          variables.sequenceId
        ),
      });
      void queryClient.invalidateQueries({ queryKey: ['shots'] });
      void queryClient.invalidateQueries({ queryKey: shotStalenessNamespace });
    },
  });
}
