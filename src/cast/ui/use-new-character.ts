import type { NewCharacterFields } from '@/cast/ui/new-character-form';
import {
  organizationCharacterKeys,
  useCreateOrganizationCharacter,
} from '@/cast/ui/use-organization-characters';
import { useCreateSequenceCharacter } from '@/cast/ui/use-sequence-characters';
import { errorMessage } from '@/platform/errors';
import { setCharacterSheetFromUploadFn } from '@/shots/media-upload.fn';
import { invalidateCharacterSheets } from '@/shots/ui/use-media-upload';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

/** In a sequence, or from none: then the caller says what it is rendered as. */
type NewCharacterTarget =
  | { sequenceId: string }
  | { sequenceId: null; rendering: () => string };

/**
 * Create the character, then attach its checked upload as the default
 * look's sheet (#2254). A failed attach keeps the character and says so; the
 * caller shows a failed create.
 */
export function useNewCharacter(target: NewCharacterTarget) {
  const queryClient = useQueryClient();
  const createInSequence = useCreateSequenceCharacter();
  const createInOrganization = useCreateOrganizationCharacter();
  return useMutation({
    mutationFn: async ({ sheetUrl, ...bible }: NewCharacterFields) => {
      const character =
        target.sequenceId === null
          ? await createInOrganization.mutateAsync({
              ...bible,
              rendering: target.rendering(),
            })
          : await createInSequence.mutateAsync({
              ...bible,
              sequenceId: target.sequenceId,
            });
      let sheetError: unknown = null;
      if (sheetUrl) {
        await setCharacterSheetFromUploadFn({
          data: {
            sequenceId: target.sequenceId,
            characterId: character.id,
            publicUrl: sheetUrl,
          },
        })
          .then(() => invalidateCharacterSheets(queryClient))
          .catch((error: unknown) => {
            sheetError = error;
          });
      }
      // The Cast picker selects it next: it must be in the list, with its sheet.
      await queryClient.invalidateQueries({
        queryKey: organizationCharacterKeys.all,
      });
      return { character, sheetError };
    },
    onSuccess: ({ character, sheetError }) => {
      if (sheetError !== null) {
        toast.error(`${character.name} created, image not added`, {
          description: errorMessage(sheetError),
        });
      }
    },
  });
}
