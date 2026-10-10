import type { TeamCharacter } from '@/cast/server/db/characters';
import { talentSquareImageClassName } from '@/cast/talent-preview';
import { AppImage } from '@/ui/shadcn/app-image';
import { Card } from '@/ui/shadcn/card';
import { Link } from '@tanstack/react-router';
import { User } from 'lucide-react';
import type React from 'react';

/** Which sequences cast a character, in a line. */
function castLine(sequences: TeamCharacter['sequences']): string {
  const [latest] = sequences;
  if (!latest) return 'Not in a sequence';
  if (sequences.length === 1) return latest.title;
  return `${sequences.length} sequences · latest ${latest.title}`;
}

/**
 * One of the team's characters (#2017), laid out as a talent card is. The
 * picture is its default look's sheet.
 */
export const TeamCharacterCard: React.FC<{ character: TeamCharacter }> = ({
  character,
}) => {
  // The portrait drawn from the sheet; a sheet from before portraits is cropped.
  const portraitUrl = character.sheetPortraitUrl;
  const sheetUrl = portraitUrl ?? character.sheetImageUrl;

  return (
    <Card className="group relative overflow-hidden hover:shadow-lg transition-shadow">
      <Link
        to="/characters/$id"
        params={{ id: character.id }}
        aria-label={character.name}
        className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className="aspect-square bg-muted relative overflow-hidden">
          {sheetUrl ? (
            <AppImage
              src={sheetUrl}
              alt={character.name}
              // The whole four-panel sheet: one panel is a quarter of it.
              width={portraitUrl ? 240 : 960}
              height={240}
              className={talentSquareImageClassName(!portraitUrl)}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <User className="h-16 w-16 text-muted-foreground/30" />
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1 p-4">
          <h3 className="font-semibold text-base line-clamp-1">
            {character.name}
          </h3>
          <p className="text-xs text-muted-foreground line-clamp-1">
            {castLine(character.sequences)}
          </p>
          {character.physicalDescription && (
            <p className="text-sm text-muted-foreground line-clamp-2">
              {character.physicalDescription}
            </p>
          )}
        </div>
      </Link>
    </Card>
  );
};
