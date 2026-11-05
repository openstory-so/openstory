import type {
  CharacterImage,
  NewCharacterFields,
} from '@/cast/ui/new-character-form';
import { updateOrganizationCharacterFn } from '@/cast/organization-characters.fn';
import {
  organizationCharacterKeys,
  useCreateOrganizationCharacter,
} from '@/cast/ui/use-organization-characters';
import { useCreateSequenceCharacter } from '@/cast/ui/use-sequence-characters';
import { errorMessage } from '@/platform/errors';
import {
  setCharacterReferencePhotoFromUploadFn,
  setCharacterSheetFromUploadFn,
} from '@/shots/media-upload.fn';
import { invalidateCharacterSheets } from '@/shots/ui/use-media-upload';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { toast } from 'sonner';

/** In a sequence, or from none: then the caller says what it is rendered as. */
type NewCharacterTarget =
  | { sequenceId: string }
  | { sequenceId: null; rendering: () => string };

/**
 * Create the character at once; its image finishes after (#2254). Once the
 * upload is checked and described, a blank description takes the image's,
 * then a sheet is attached as the default look's sheet or a photo becomes
 * the reference photo that sheet is drawn from. A failure there keeps the
 * character and says so; the caller shows a failed create.
 */
export function useNewCharacter(
  target: NewCharacterTarget,
  /** Whether any image is still finishing; null when the caller does not wait. */
  onImagesPendingChange: ((pending: boolean) => void) | null
) {
  const queryClient = useQueryClient();
  const pendingImages = useRef(0);
  const countPending = (delta: 1 | -1) => {
    pendingImages.current += delta;
    onImagesPendingChange?.(pendingImages.current > 0);
  };
  const createInSequence = useCreateSequenceCharacter();
  const createInOrganization = useCreateOrganizationCharacter();

  const finishImage = async (
    character: { id: string; name: string },
    pending: Promise<CharacterImage>,
    hasDescription: boolean
  ) => {
    countPending(1);
    try {
      const image = await pending;
      // Before the attach: a bible edit revokes the sheet run it starts.
      if (!hasDescription) {
        await updateOrganizationCharacterFn({
          data: {
            characterId: character.id,
            physicalDescription: image.description,
            voiceOnly: false,
          },
        });
      }
      const data = {
        sequenceId: target.sequenceId,
        characterId: character.id,
        publicUrl: image.url,
      };
      await (image.isCharacterSheet
        ? setCharacterSheetFromUploadFn({ data })
        : setCharacterReferencePhotoFromUploadFn({ data }));
    } catch (error) {
      toast.error(`${character.name} created, image not added`, {
        description: errorMessage(error),
      });
    } finally {
      countPending(-1);
      await invalidateCharacterSheets(queryClient);
      await queryClient.invalidateQueries({
        queryKey: organizationCharacterKeys.all,
      });
    }
  };

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
      if (image) {
        void finishImage(character, image, Boolean(bible.physicalDescription));
      }
      // The Cast picker selects it next: it must be in the list.
      await queryClient.invalidateQueries({
        queryKey: organizationCharacterKeys.all,
      });
      return { character };
    },
  });
}
