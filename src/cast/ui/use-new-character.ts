import type { NewCharacterFields } from '@/cast/ui/new-character-form';
import {
  organizationCharacterKeys,
  useCreateOrganizationCharacter,
} from '@/cast/ui/use-organization-characters';
import { useCreateSequenceCharacter } from '@/cast/ui/use-sequence-characters';
import { errorMessage } from '@/platform/errors';
import { useUploadCharacterSheet } from '@/shots/ui/use-media-upload';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

/** In a sequence, or from none: then the caller says what it is rendered as. */
type NewCharacterTarget =
  | { sequenceId: string }
  | { sequenceId: null; rendering: () => string };

/**
 * Create the character, then upload its image as the default look's sheet
 * (#2254). A failed upload keeps the character and says so; the caller
 * shows a failed create.
 */
export function useNewCharacter(target: NewCharacterTarget) {
  const queryClient = useQueryClient();
  const createInSequence = useCreateSequenceCharacter();
  const createInOrganization = useCreateOrganizationCharacter();
  const uploadSheet = useUploadCharacterSheet();
  return useMutation({
    mutationFn: async ({ image, ...bible }: NewCharacterFields) => {
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
      if (image) {
        await uploadSheet
          .mutateAsync({
            file: image,
            sequenceId: target.sequenceId,
            characterId: character.id,
          })
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
        toast.error(`${character.name} created, image not uploaded`, {
          description: errorMessage(sheetError),
        });
      }
    },
  });
}
