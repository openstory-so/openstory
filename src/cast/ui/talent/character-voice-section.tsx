import { VOICE_DESIGN_COST } from '@/billing/elevenlabs-pricing';
import { ActionCost } from '@/billing/ui/action-cost';
import { usesVoice } from '@/cast/voice';
import {
  sequenceCharacterKeys,
  useChooseCharacterVoiceTake,
  useGenerateCharacterVoice,
  useSetCharacterVoiceEnabled,
} from '@/cast/ui/use-sequence-characters';
import { errorMessage } from '@/platform/errors';
import type { CharacterWithSheet } from '@/platform/server/db/schema';
import { useRealtime } from '@/platform/ui/realtime/client';
import { Button } from '@/ui/shadcn/button';
import { Label } from '@/ui/shadcn/label';
import { Switch } from '@/ui/shadcn/switch';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Mic } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

/**
 * Voice on the character card (#1553): the per-character switch, the
 * auditions Voice Design returned (the first is the saved voice), and
 * Generate / Regenerate. The description itself is a bible field.
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
  const [isDesigning, setIsDesigning] = useState(false);
  const enabled = usesVoice(character, { generateVoices });

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
        }
      },
      [character.id, queryClient, sequenceId]
    ),
  });

  const busy = isDesigning || generate.isPending;
  const previews = character.voicePreviews ?? [];

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
          {previews.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {previews.map((preview, index) => (
                <li
                  key={preview.generatedVoiceId}
                  className="flex items-center gap-2"
                >
                  {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- a voice audition has no words to caption */}
                  <audio
                    controls
                    preload="none"
                    src={preview.url}
                    className="min-w-0 flex-1"
                  />
                  {index === 0 && character.voiceId ? (
                    <span className="w-12 text-xs text-muted-foreground">
                      Saved
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-12"
                      aria-label={`Use take ${index + 1}`}
                      disabled={busy || chooseTake.isPending}
                      onClick={() =>
                        chooseTake.mutate(
                          {
                            sequenceId,
                            characterId: character.id,
                            generatedVoiceId: preview.generatedVoiceId,
                          },
                          {
                            onError: (error) =>
                              toast.error('Failed to save take', {
                                description: errorMessage(error),
                              }),
                          }
                        )
                      }
                    >
                      Use
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              {busy ? 'Designing voice…' : 'No voice yet.'}
            </p>
          )}
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
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Mic className="mr-2 h-4 w-4" />
              )}
              {busy
                ? 'Designing…'
                : character.voiceId
                  ? 'Regenerate voice'
                  : 'Generate voice'}
            </Button>
            <ActionCost estimate={VOICE_DESIGN_COST} />
          </div>
        </>
      )}
    </div>
  );
};
