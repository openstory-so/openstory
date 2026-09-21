import { VOICE_DESIGN_COST } from '@/billing/elevenlabs-pricing';
import { ActionCost } from '@/billing/ui/action-cost';
import {
  catalogVoiceBrief,
  designedTakesForDisplay,
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
  useCharacterVoiceVersions,
  useChooseCharacterVoiceTake,
  useGenerateCharacterVoice,
  useSelectCharacterVoiceVersion,
  useSetCharacterVoiceEnabled,
} from '@/cast/ui/use-sequence-characters';
import { VoiceLibraryDialog } from '@/cast/ui/talent/voice-library-dialog';
import { errorMessage } from '@/platform/errors';
import type {
  CharacterVoiceVersionSource,
  CharacterWithSheet,
} from '@/platform/server/db/schema';
import { useRealtime } from '@/platform/ui/realtime/client';
import { Badge } from '@/ui/shadcn/badge';
import { Button } from '@/ui/shadcn/button';
import { Label } from '@/ui/shadcn/label';
import { Switch } from '@/ui/shadcn/switch';
import { cn } from '@/ui/utils';
import { useQueryClient } from '@tanstack/react-query';
import { Library, Loader2, Mic } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [libraryOpen, setLibraryOpen] = useState(false);
  const enabled = usesVoice(character, { generateVoices });
  const { data: savedVoice } = useSavedVoiceMeta(
    character.id,
    character.voiceId,
    enabled
  );
  const { data: versions } = useCharacterVoiceVersions(
    sequenceId,
    character.id
  );
  const pendingHusk = versions?.find(
    (version) => version.status === 'generating' || version.status === 'pending'
  );
  const hadLiveHusk = useRef(false);

  useEffect(() => {
    if (pendingHusk) {
      hadLiveHusk.current = true;
      return;
    }
    if (!hadLiveHusk.current) return;
    hadLiveHusk.current = false;
    void queryClient.invalidateQueries({
      queryKey: sequenceCharacterKeys.list(sequenceId),
    });
    void queryClient.invalidateQueries({
      queryKey: elevenLabsVoiceKeys.saved(character.id),
    });
  }, [pendingHusk, character.id, queryClient, sequenceId]);

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
        void queryClient.invalidateQueries({
          queryKey: sequenceCharacterKeys.voiceVersions(
            sequenceId,
            character.id
          ),
        });
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

  const designing = Boolean(pendingHusk) || generate.isPending;
  const busy = designing || assignVoice.isPending;
  const takes = designedTakesForDisplay(
    character.voicePreviews ?? [],
    character.voiceId,
    savedVoice?.category
  );
  const inUseTake = takes.find((take) => take.inUse);
  const otherTakes = takes.filter((take) => !take.inUse);
  const choosingId = chooseTake.isPending
    ? chooseTake.variables?.generatedVoiceId
    : undefined;
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
        onSuccess: () => toast.success('Voice take in use'),
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
          {character.voiceId || takes.length > 0 || designing ? (
            <div className="flex flex-col gap-3">
              {pendingHusk && (
                <section className="flex flex-col gap-2" aria-label="Pending">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Pending
                  </p>
                  <VoiceTakeCard src={null} label="Designing voice" pending />
                </section>
              )}
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
                      src={inUseTake.preview.url}
                      label={inUseTake.label}
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
                    {otherTakes.map((take) => (
                      <li key={take.preview.generatedVoiceId}>
                        <VoiceTakeCard
                          src={take.preview.url}
                          label={take.label}
                          disabled={busy || chooseTake.isPending}
                          choosing={
                            choosingId === take.preview.generatedVoiceId
                          }
                          unusable={take.unusable}
                          onUse={
                            take.canUse
                              ? () =>
                                  handleChooseTake(
                                    take.preview.generatedVoiceId
                                  )
                              : undefined
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
              No voice yet. Browse the library or generate one.
            </p>
          )}
          <VoiceHistory sequenceId={sequenceId} character={character} />
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
                      onError: (error) =>
                        toast.error('Failed to design voice', {
                          description: errorMessage(error),
                        }),
                    }
                  )
                }
              >
                {designing ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Mic className="mr-2 h-4 w-4" />
                )}
                {generateVoiceButtonLabel(
                  designing,
                  Boolean(character.voiceId || takes.length > 0)
                )}
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

function generateVoiceButtonLabel(
  designing: boolean,
  hasVoice: boolean
): string {
  if (designing) return 'Designing…';
  if (hasVoice) return 'Regenerate voice';
  return 'Generate voice';
}

/** What put this voice on the character — the history row's own label. */
const VOICE_SOURCE_LABELS: Record<CharacterVoiceVersionSource, string> = {
  analysis: 'From the script',
  generated: 'Designed',
  library: 'From the library',
  'user-edit': 'Description edited',
  disabled: 'Voice turned off',
  removed: 'Voice removed',
};

/**
 * Voice history (#1657): every voice this character has held. A released row
 * names an id ElevenLabs no longer has, so it is shown but cannot be used.
 * Hidden until there is something to go back to.
 */
const VoiceHistory: React.FC<{
  sequenceId: string;
  character: CharacterWithSheet;
}> = ({ sequenceId, character }) => {
  const { data: versions, isError } = useCharacterVoiceVersions(
    sequenceId,
    character.id
  );
  const select = useSelectCharacterVoiceVersion();
  if (isError) {
    return (
      <p className="text-xs text-destructive" role="alert">
        Voice history failed to load.
      </p>
    );
  }
  const completed = versions?.filter(
    (version) => version.status === 'completed' && version.voiceId
  );
  if (!completed || completed.length < 2) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="Voice history">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        History
      </p>
      <ul className="flex flex-col gap-1">
        {completed.map((version) => {
          const current = version.id === character.selectedVoiceVersionId;
          const released = Boolean(version.releasedAt);
          const created = new Date(version.createdAt);
          return (
            <li
              key={version.id}
              className="flex items-center justify-between gap-2 rounded-md border p-2"
              aria-current={current ? 'true' : undefined}
            >
              <div className="flex min-w-0 flex-col">
                <p className="text-xs font-medium">
                  {VOICE_SOURCE_LABELS[version.source]}{' '}
                  <time
                    dateTime={created.toISOString()}
                    className="font-normal text-muted-foreground"
                  >
                    {created.toLocaleDateString()}
                  </time>
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {released
                    ? 'Deleted when it stopped being used'
                    : (version.description ?? 'No description')}
                </p>
              </div>
              {current ? (
                <Badge variant="secondary">Current</Badge>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={released || !version.voiceId || select.isPending}
                  aria-label={`Use the ${VOICE_SOURCE_LABELS[
                    version.source
                  ].toLowerCase()} voice from ${created.toLocaleDateString()}`}
                  onClick={() =>
                    select.mutate(
                      {
                        sequenceId,
                        characterId: character.id,
                        versionId: version.id,
                      },
                      {
                        onError: (error) =>
                          toast.error('Failed to switch voice', {
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
          );
        })}
      </ul>
    </section>
  );
};

const VoiceTakeCard: React.FC<{
  src: string | null;
  label: string;
  inUse?: boolean;
  isPremade?: boolean;
  pending?: boolean;
  disabled?: boolean;
  choosing?: boolean;
  unusable?: 'saved' | 'expired';
  onUse?: () => void;
}> = ({
  src,
  label,
  inUse = false,
  isPremade,
  pending = false,
  disabled,
  choosing,
  unusable,
  onUse,
}) => (
  <div
    className={cn(
      'flex flex-col gap-2 rounded-lg border p-3',
      inUse ? 'border-primary ring-2 ring-primary/40' : 'border-border'
    )}
    aria-current={inUse ? 'true' : undefined}
    aria-busy={pending || undefined}
  >
    <div className="flex items-center justify-between gap-2">
      <p className="truncate text-sm font-medium">{label}</p>
      <VoiceTakeCardAction
        pending={pending}
        inUse={inUse}
        isPremade={isPremade}
        unusable={unusable}
        disabled={disabled}
        choosing={choosing}
        label={label}
        onUse={onUse}
      />
    </div>
    <VoiceTakeCardPreview pending={pending} src={src} />
  </div>
);

const VoiceTakeCardAction: React.FC<{
  pending: boolean;
  inUse: boolean;
  isPremade?: boolean;
  unusable?: 'saved' | 'expired';
  disabled?: boolean;
  choosing?: boolean;
  label: string;
  onUse?: () => void;
}> = ({
  pending,
  inUse,
  isPremade,
  unusable,
  disabled,
  choosing,
  label,
  onUse,
}) => {
  if (pending) return <Badge variant="secondary">Generating…</Badge>;
  if (inUse) {
    return <Badge variant="default">{isPremade ? 'Default' : 'In use'}</Badge>;
  }
  if (unusable) {
    return (
      <p className="text-xs text-muted-foreground">
        {unusable === 'expired' ? 'Expired' : 'Already used'}
      </p>
    );
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      aria-label={choosing ? `Using ${label}` : `Use ${label}`}
      onClick={onUse}
    >
      {choosing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
      {choosing ? 'Using…' : 'Use this take'}
    </Button>
  );
};

const VoiceTakeCardPreview: React.FC<{
  pending: boolean;
  src: string | null;
}> = ({ pending, src }) => {
  if (pending) {
    return (
      <div className="flex min-h-8 items-center gap-2 text-xs text-muted-foreground">
        <Loader2
          className="h-4 w-4 animate-spin motion-reduce:animate-none"
          aria-hidden
        />
        Designing…
      </div>
    );
  }
  if (src) {
    return (
      // oxlint-disable-next-line jsx-a11y/media-has-caption -- a voice audition has no words to caption
      <audio controls preload="none" src={src} className="w-full" />
    );
  }
  return <p className="text-xs text-muted-foreground">No preview</p>;
};
