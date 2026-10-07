import type React from 'react';
import { toast } from 'sonner';
import { Button } from '@/ui/shadcn/button';
import { useSetCharacterInLibrary } from '@/cast/ui/use-team-characters';
import { useHydrated } from '@/ui/use-hydrated';

/**
 * The library flag of one character (#2017). Nothing is copied: the
 * character itself is in the library or it is not.
 */
export const CharacterLibraryButton: React.FC<{
  characterId: string;
  inLibrary: boolean;
}> = ({ characterId, inLibrary }) => {
  const setInLibrary = useSetCharacterInLibrary();
  // Server-rendered before its handler exists: a click then does nothing.
  const hydrated = useHydrated();
  const idle = inLibrary ? 'Remove from Library' : 'Add to Library';
  const busy = inLibrary ? 'Removing…' : 'Adding…';

  return (
    <Button
      variant="outline"
      disabled={!hydrated || setInLibrary.isPending}
      onClick={() =>
        setInLibrary.mutate(
          { characterId, inLibrary: !inLibrary },
          {
            onSuccess: () =>
              toast.success(
                inLibrary ? 'Removed from Library' : 'Added to Library',
                {
                  // Long enough to act on, like the cast Remove toast.
                  duration: 60_000,
                  action: {
                    label: 'Undo',
                    onClick: () =>
                      setInLibrary.mutate({ characterId, inLibrary }),
                  },
                }
              ),
          }
        )
      }
    >
      {setInLibrary.isPending ? busy : idle}
    </Button>
  );
};
