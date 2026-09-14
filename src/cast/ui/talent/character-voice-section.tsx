import { VOICE_DESIGN_COST } from '@/billing/elevenlabs-pricing';
import { ActionCost } from '@/billing/ui/action-cost';
import {
  catalogVoiceBrief,
  designedTakeIsInUse,
  recommendVoiceFilters,
  usesVoice,
  type CatalogVoice,
} from '@/cast/voice';
import {
  elevenLabsVoiceKeys,
  useSavedVoiceMeta,
} from '@/cast/ui/use-elevenlabs-voices';
import {
  sequenceCharacterKeys,
  useAssignCharacterVoice,
  useChooseCharacterVoiceTake,
  useGenerateCharacterVoice,
  useSetCharacterVoiceEnabled,
} from '@/cast/ui/use-sequence-characters';
import { VoiceLibraryDialog } from '@/cast/ui/talent/voice-library-dialog';
import { errorMessage } from '@/platform/errors';
import type { CharacterWithSheet } from '@/platform/server/db/schema';
import { useRealtime } from '@/platform/ui/realtime/client';
import { Badge } from '@/ui/shadcn/badge';
import { Button } from '@/ui/shadcn/button';
import { Label } from '@/ui/shadcn/label';
import { Switch } from '@/ui/shadcn/switch';
import { cn } from '@/ui/utils';
import { useQueryClient } from '@tanstack/react-query';
import { Library, Loader2, Mic } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

/**
 * Voice on the character card (#1553 / #1629): the per-character switch,
 * the in-use take vs alternates, Browse voices, and Generate / Regenerate.
 * The description itself is a bible field.
 */
export const CharacterVoiceSection: React.FC<{
  sequenceId: string;
  character: CharacterWithSheet;
  generateVoices: boolean;
}> = ({ sequenceId, character, generateVoices }) => {
  const queryClient = useQueryClient();
  const generate = useGenerateCharacterVoice();
  const setEnabled = useSetCharacterVoiceEnabled();
  const chooseTake = useChooseCharacterVoiceTake();
  const assignVoice = useAssignCharacterVoice();
  const [isDesigning, setIsDesigning] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const enabled = usesVoice(character, { generateVoices });
  const { data: savedVoice } = useSavedVoiceMeta(
    character.id,
    character.voiceId,
    enabled
  );

  useRealtime({
    channels: [sequenceId],
    events: ['generation.character-voice:progress'] as const,
    enabled: true,
    onData: useCallback(
      (event: { data: unknown }) => {
        const data = event.data;
        if (
          !data ||
          typeof data !== 'object' ||
          !('characterId' in data) ||
          data.characterId !== character.id ||
          !('status' in data)
        ) {
          return;
        }
        setIsDesigning(data.status === 'generating');
        if (data.status === 'failed') {
          toast.error('Voice design failed', {
            description:
              'error' in data && typeof data.error === 'string'
                ? data.error
                : undefined,
          });
        }
        if (data.status !== 'generating') {
          void queryClient.invalidateQueries({
            queryKey: sequenceCharacterKeys.list(sequenceId),
          });
          void queryClient.invalidateQueries({
            queryKey: elevenLabsVoiceKeys.saved(character.id),
          });
        }
      },
      [character.id, queryClient, sequenceId]
    ),
  });

  const busy = isDesigning || generate.isPending || assignVoice.isPending;
  const previews = character.voicePreviews ?? [];
  const inUseTake = previews.find((_, index) =>
    designedTakeIsInUse(index, character.voiceId, savedVoice?.category)
  );
  const otherTakes = previews.filter(
    (preview) => preview.generatedVoiceId !== inUseTake?.generatedVoiceId
  );
  const catalogVoice =
    savedVoice && savedVoice.category !== 'generated' ? savedVoice : null;

  const handleChooseTake = (generatedVoiceId: string) => {
    chooseTake.mutate(
      {
        sequenceId,
        characterId: character.id,
        generatedVoiceId,
      },
      {
        onError: (error) =>
          toast.error('Failed to save take', {
            description: errorMessage(error),
          }),
      }
    );
  };

  const handleAssign = (voice: CatalogVoice) => {
    assignVoice.mutate(
      {
        sequenceId,
        characterId: character.id,
        source: voice.source,
        voiceId: voice.voiceId,
        publicOwnerId: voice.publicOwnerId,
        name: voice.name,
        description: catalogVoiceBrief(voice),
      },
      {
        onSuccess: () => setLibraryOpen(false),
        onError: (error) =>
          toast.error('Failed to use voice', {
            description: errorMessage(error),
          }),
      }
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Switch
          id="character-voice"
          checked={enabled}
          disabled={setEnabled.isPending || busy}
          onCheckedChange={(next) =>
            setEnabled.mutate(
              { sequenceId, characterId: character.id, enabled: next },
              {
                onError: (error) =>
                  toast.error('Failed to update voice', {
                    description: errorMessage(error),
                  }),
              }
            )
          }
        />
        <Label htmlFor="character-voice" className="text-sm font-medium">
          Voice
        </Label>
      </div>
      {enabled && (
        <>
          {character.voiceId || previews.length > 0 ? (
            <div className="flex flex-col gap-3">
              {(inUseTake || catalogVoice || character.voiceId) && (
                <section className="flex flex-col gap-2" aria-label="In use">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    In use
                  </p>
                  {catalogVoice ? (
                    <VoiceTakeCard
                      src={catalogVoice.previewUrl}
                      label={catalogVoice.name}
                      inUse
                      isPremade={catalogVoice.isPremade}
                    />
                  ) : inUseTake ? (
                    <VoiceTakeCard
                      src={inUseTake.url}
                      label="Designed take"
                      inUse
                    />
                  ) : (
                    <VoiceTakeCard src={null} label="Saved voice" inUse />
                  )}
                </section>
              )}
              {otherTakes.length > 0 && (
                <section
                  className="flex flex-col gap-2"
                  aria-label="Other takes"
                >
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Other takes
                  </p>
                  <ul className="flex flex-col gap-2">
                    {otherTakes.map((preview, index) => (
                      <li key={preview.generatedVoiceId}>
                        <VoiceTakeCard
                          src={preview.url}
                          label={`Take ${index + 1}`}
                          disabled={busy || chooseTake.isPending}
                          onUse={() =>
                            handleChooseTake(preview.generatedVoiceId)
                          }
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {busy
                ? 'Designing voice…'
                : 'No voice yet. Browse the library or generate one.'}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setLibraryOpen(true)}
            >
              <Library className="mr-2 h-4 w-4" />
              Browse voices
            </Button>
            <div className="flex w-fit flex-col gap-1">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  generate.mutate(
                    { sequenceId, characterId: character.id },
                    {
                      onSuccess: () => setIsDesigning(true),
                      onError: (error) =>
                        toast.error('Failed to design voice', {
                          description: errorMessage(error),
                        }),
                    }
                  )
                }
              >
                {isDesigning || generate.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Mic className="mr-2 h-4 w-4" />
                )}
                {isDesigning || generate.isPending
                  ? 'Designing…'
                  : character.voiceId
                    ? 'Regenerate voice'
                    : 'Generate voice'}
              </Button>
              <ActionCost estimate={VOICE_DESIGN_COST} />
            </div>
          </div>
          <VoiceLibraryDialog
            open={libraryOpen}
            onOpenChange={setLibraryOpen}
            selectedVoiceId={character.voiceId}
            pending={assignVoice.isPending}
            onSelect={handleAssign}
            characterName={character.name}
            recommended={recommendVoiceFilters(character)}
          />
        </>
      )}
    </div>
  );
};

const VoiceTakeCard: React.FC<{
  src: string | null;
  label: string;
  inUse?: boolean;
  isPremade?: boolean;
  disabled?: boolean;
  onUse?: () => void;
}> = ({ src, label, inUse = false, isPremade, disabled, onUse }) => (
  <div
    className={cn(
      'flex flex-col gap-2 rounded-lg border p-3',
      inUse ? 'border-primary ring-2 ring-primary/40' : 'border-border'
    )}
    aria-current={inUse ? 'true' : undefined}
  >
    <div className="flex items-center justify-between gap-2">
      <p className="truncate text-sm font-medium">{label}</p>
      {inUse ? (
        <Badge variant="default">{isPremade ? 'Default' : 'In use'}</Badge>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={`Use ${label}`}
          onClick={onUse}
        >
          Use this take
        </Button>
      )}
    </div>
    {src ? (
      // oxlint-disable-next-line jsx-a11y/media-has-caption -- a voice audition has no words to caption
      <audio controls preload="none" src={src} className="w-full" />
    ) : (
      <p className="text-xs text-muted-foreground">No preview</p>
    )}
  </div>
);
