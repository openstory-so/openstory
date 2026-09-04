import { ActionCost } from '@/components/billing/action-cost';
import { type ModelGenerationStatus } from '@/components/model/base-model-selector';
import { MusicModelSelector } from '@/components/model/music-model-selector';
import { PromptHistorySheet } from '@/components/prompts/prompt-history-sheet';
import { StalenessIndicator } from '@/components/staleness/staleness-indicator';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { VoiceInputButton } from '@/components/voice/voice-input-button';
import { useFalPricing } from '@/hooks/use-fal-pricing';
import { getAudioModelDurationLimits, type AudioModel } from '@/lib/ai/models';
import { estimateAudioCost } from '@/lib/billing/cost-estimation';
import { useTextDictation } from '@/hooks/use-dictation';
import type { Sequence } from '@/types/database';
import {
  AlertCircle,
  AlertTriangle,
  History,
  Loader2,
  Music,
  Volume2,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

type GenerateMusicArgs = {
  prompt?: string;
  tags?: string;
  model?: string;
  duration?: number;
};

type MusicViewProps = {
  sequence: Sequence;
  videoDuration?: number;
  onGenerateMusic: (args?: GenerateMusicArgs) => void;
  isGeneratingMusic: boolean;
  /**
   * Per-model generation status for this sequence (#546), mirroring the
   * video/image scene-detail selector: ⊙ `set` (the live primary track) /
   * ✓ `completed` (a generated alternate) / ⟳ `generating` / ! `failed`.
   * Drives the model markers and the Set/Regenerate/Generate action button.
   */
  audioModelStatuses?: Map<string, ModelGenerationStatus>;
  /**
   * The viewer's active audio model, owned by `useActiveAudioModel` in the
   * route (#546). Controlled here (not local state) so the music-tab selector
   * and the sequence-header dropdown stay in sync — switching either one moves
   * both, and the player remaps to the picked model's track.
   */
  selectedModel: AudioModel;
  onModelChange: (model: AudioModel) => void;
  /** Promote the selected model's track to the sequence primary ("Set Music"). */
  onSetModel: (model: AudioModel) => void;
  isSettingModel?: boolean;
  /** Banner rendered above the audio player while `musicStatus === 'completed'`. */
  divergentBanner?: React.ReactNode;
  isMusicPromptStale?: boolean;
  onRegenerateMusicPrompt?: () => void;
  isRegeneratingMusicPrompt?: boolean;
  /**
   * Toggle whether this sequence's music plays in the theatre and is bundled
   * into MP4 exports (#834). Bound to `sequence.includeMusic`; persisted by the
   * route via `useSetSequenceMusic`.
   */
  onIncludeMusicChange?: (includeMusic: boolean) => void;
  /**
   * Persist a hand-edited music prompt after a track exists (#1108 Phase 4)
   * WITHOUT regenerating; absent = the completed view stays read-only.
   */
  onSaveMusicPrompt?: (prompt: string) => void;
  isSavingMusicPrompt?: boolean;
  /** The saved prompt differs from the one the playing track was made with. */
  promptEditedSinceTrack?: boolean;
};

type LoadingButtonProps = React.ComponentProps<typeof Button> & {
  isLoading: boolean;
  loadingText: string;
  children: React.ReactNode;
};

const LoadingButton: React.FC<LoadingButtonProps> = ({
  isLoading,
  loadingText,
  children,
  ...props
}) => (
  <Button disabled={isLoading || props.disabled} {...props}>
    {isLoading ? (
      <>
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {loadingText}
      </>
    ) : (
      children
    )}
  </Button>
);

type StatusPanelProps = {
  icon: React.ReactNode;
  message?: string;
  children?: React.ReactNode;
  contentWidth?: 'sm' | 'lg';
};

const StatusPanel: React.FC<StatusPanelProps> = ({
  icon,
  message,
  children,
  contentWidth = 'lg',
}) => {
  const maxWidth = contentWidth === 'sm' ? 'max-w-xs' : 'max-w-lg';
  return (
    <div className="flex flex-col items-center gap-6 py-12">
      {icon}
      {message && <p className="text-muted-foreground">{message}</p>}
      {children && (
        <div className={`w-full ${maxWidth} flex flex-col gap-4`}>
          {children}
        </div>
      )}
    </div>
  );
};

type FormFieldProps = {
  label: string;
  htmlFor?: string;
  muted?: boolean;
  /** Trailing control on the label row (e.g. the dictation mic). */
  action?: React.ReactNode;
  children: React.ReactNode;
};

const FormField: React.FC<FormFieldProps> = ({
  label,
  htmlFor,
  muted,
  action,
  children,
}) => (
  <div className="flex flex-col gap-2">
    <div className="flex items-center justify-between gap-2">
      <Label
        htmlFor={htmlFor}
        className={muted ? 'text-xs text-muted-foreground' : undefined}
      >
        {label}
      </Label>
      {action}
    </div>
    {children}
  </div>
);

const ReadOnlyField: React.FC<{ label: string; value: string }> = ({
  label,
  value,
}) => (
  <FormField label={label} muted>
    <p className="text-sm text-muted-foreground bg-muted/50 rounded-md p-3">
      {value}
    </p>
  </FormField>
);

export const MusicView: React.FC<MusicViewProps> = ({
  sequence,
  videoDuration,
  onGenerateMusic,
  isGeneratingMusic,
  audioModelStatuses,
  selectedModel,
  onModelChange,
  onSetModel,
  isSettingModel = false,
  divergentBanner,
  isMusicPromptStale,
  onRegenerateMusicPrompt,
  isRegeneratingMusicPrompt,
  onIncludeMusicChange,
  onSaveMusicPrompt,
  isSavingMusicPrompt = false,
  promptEditedSinceTrack = false,
}) => {
  const { musicStatus, musicUrl, musicError, musicPrompt, musicTags } =
    sequence;

  const [editPrompt, setEditPrompt] = useState(musicPrompt ?? '');
  const promptVoice = useTextDictation(editPrompt, setEditPrompt);
  const [editDuration, setEditDuration] = useState<number | undefined>(
    () => videoDuration
  );
  const [historyOpen, setHistoryOpen] = useState(false);

  // Resync the textarea when the source-of-truth musicPrompt changes from
  // outside (regenerate, restore, realtime update). Without this, a successful
  // regenerate updates `sequence.musicPrompt` but the textarea keeps showing
  // the user's stale value.
  const prevMusicPromptRef = useRef(musicPrompt);
  if (musicPrompt !== prevMusicPromptRef.current) {
    prevMusicPromptRef.current = musicPrompt;
    setEditPrompt(musicPrompt ?? '');
  }

  const stalenessBanner =
    isMusicPromptStale && onRegenerateMusicPrompt ? (
      <StalenessIndicator
        artifact="music-prompt"
        entityType="sequence"
        density="inline"
        onRegenerate={onRegenerateMusicPrompt}
        isRegenerating={isRegeneratingMusicPrompt}
      />
    ) : null;

  const historyButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => setHistoryOpen(true)}
      aria-label="Show music prompt history"
    >
      <History className="mr-2 h-4 w-4" />
      History
    </Button>
  );

  const historySheet = (
    <PromptHistorySheet
      open={historyOpen}
      onOpenChange={setHistoryOpen}
      mode="music"
      sequenceId={sequence.id}
      currentText={musicPrompt ?? ''}
    />
  );

  const prevVideoDurationRef = useRef(videoDuration);
  if (videoDuration !== prevVideoDurationRef.current) {
    prevVideoDurationRef.current = videoDuration;
    setEditDuration(videoDuration);
  }

  const durationLimits = getAudioModelDurationLimits(selectedModel);
  const effectiveDuration =
    editDuration ?? videoDuration ?? durationLimits.default;
  const durationExceedsMax = effectiveDuration > durationLimits.max;

  const { pricing: falPricing } = useFalPricing();
  const musicCostEstimate = useMemo(() => {
    if (!falPricing) return null;
    return estimateAudioCost(selectedModel, effectiveDuration, {
      pricing: falPricing,
    });
  }, [falPricing, selectedModel, effectiveDuration]);

  function handleGenerate(): void {
    onGenerateMusic({
      prompt: editPrompt || undefined,
      tags: musicTags || undefined,
      model: selectedModel,
      duration: editDuration,
    });
  }

  // Action for the selected model, mirroring the video/image scene-detail
  // button: a completed alternate promotes ("Set Music"); the live primary
  // regenerates; anything without a track generates for the first time.
  const selectedStatus = audioModelStatuses?.get(selectedModel);
  const selectedIsSet = selectedStatus === 'set';
  const selectedIsCompletedAlternate = selectedStatus === 'completed';

  const actionButton = selectedIsCompletedAlternate ? (
    <LoadingButton
      onClick={() => onSetModel(selectedModel)}
      isLoading={isSettingModel}
      loadingText="Setting…"
    >
      Set Music
    </LoadingButton>
  ) : (
    <div className="flex flex-col gap-1">
      <LoadingButton
        variant={selectedIsSet ? 'outline' : 'default'}
        onClick={handleGenerate}
        disabled={!editPrompt}
        isLoading={isGeneratingMusic}
        loadingText={selectedIsSet ? 'Regenerating…' : 'Generating…'}
      >
        {selectedIsSet ? 'Regenerate Music' : 'Generate Music'}
      </LoadingButton>
      <ActionCost estimate={musicCostEstimate} />
    </div>
  );

  if (musicStatus === 'completed' && musicUrl) {
    const promptDirty = editPrompt.trim() !== (musicPrompt ?? '').trim();
    return (
      <StatusPanel
        icon={<Volume2 className="h-10 w-10 text-muted-foreground" />}
      >
        {divergentBanner}
        {stalenessBanner}
        <audio
          controls
          src={musicUrl}
          className="h-10 w-full"
          preload="metadata"
        >
          <track kind="captions" />
        </audio>

        <FormField label="Model" muted>
          <MusicModelSelector
            selectedModel={selectedModel}
            onModelChange={onModelChange}
            generatedStatuses={audioModelStatuses}
          />
        </FormField>

        {/* Editable after the track exists (#1108 Phase 4): Save persists a
            user-edit prompt version WITHOUT regenerating — the Regenerate
            button below stays the explicit re-render path. */}
        {onSaveMusicPrompt ? (
          <FormField
            label="Prompt"
            htmlFor="music-prompt-completed"
            action={<VoiceInputButton label="music prompt" {...promptVoice} />}
          >
            <Textarea
              id="music-prompt-completed"
              value={editPrompt}
              onChange={(e) => setEditPrompt(e.target.value)}
              rows={4}
              placeholder="Descriptive music prompt…"
            />
            {promptEditedSinceTrack && !promptDirty && (
              <p className="text-xs text-muted-foreground">
                Edited since this track was generated — Regenerate Music to hear
                the new prompt.
              </p>
            )}
            {promptDirty && (
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setEditPrompt(musicPrompt ?? '')}
                  disabled={isSavingMusicPrompt}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onSaveMusicPrompt(editPrompt.trim())}
                  disabled={
                    isSavingMusicPrompt || editPrompt.trim().length === 0
                  }
                >
                  {isSavingMusicPrompt ? 'Saving…' : 'Save'}
                </Button>
              </div>
            )}
          </FormField>
        ) : (
          <ReadOnlyField
            label="Prompt"
            value={musicPrompt ?? 'Missing prompt'}
          />
        )}
        <ReadOnlyField label="Tags" value={musicTags ?? 'Missing tags'} />

        {onIncludeMusicChange && (
          <label
            htmlFor="include-music"
            className="flex items-center gap-2 self-center text-sm text-muted-foreground"
          >
            <Checkbox
              id="include-music"
              checked={sequence.includeMusic}
              onCheckedChange={(checked) =>
                onIncludeMusicChange(checked === true)
              }
            />
            <span>Include music in playback &amp; export</span>
          </label>
        )}

        <div className="flex justify-center gap-3">
          {historyButton}
          {actionButton}
        </div>
        {historySheet}
      </StatusPanel>
    );
  }

  if (musicStatus === 'generating') {
    return (
      <StatusPanel
        icon={
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        }
        message="Generating music…"
      />
    );
  }

  if (musicStatus === 'failed') {
    return (
      <StatusPanel
        icon={<AlertCircle className="h-8 w-8 text-destructive" />}
        contentWidth="sm"
      >
        <p className="text-destructive text-center">Music generation failed</p>
        {musicError && (
          <p className="text-sm text-muted-foreground text-center">
            {musicError}
          </p>
        )}

        <FormField label="Model" muted>
          <MusicModelSelector
            selectedModel={selectedModel}
            onModelChange={onModelChange}
            generatedStatuses={audioModelStatuses}
          />
        </FormField>

        <div className="flex justify-center">{actionButton}</div>
      </StatusPanel>
    );
  }

  const promptPending = !musicPrompt;

  return (
    <StatusPanel
      icon={<Music className="h-8 w-8 text-muted-foreground" />}
      message={promptPending ? 'Preparing music…' : 'Music prompt ready'}
    >
      {stalenessBanner}
      <FormField
        label="Prompt"
        htmlFor="music-prompt"
        action={
          <VoiceInputButton
            label="music prompt"
            disabled={promptPending}
            {...promptVoice}
          />
        }
      >
        <Textarea
          id="music-prompt"
          value={editPrompt}
          onChange={(e) => setEditPrompt(e.target.value)}
          rows={4}
          disabled={promptPending}
          placeholder={
            promptPending
              ? 'Generating music prompt…'
              : 'Descriptive music prompt…'
          }
        />
      </FormField>

      <FormField label="Tags" muted>
        {musicTags ? (
          <p className="text-sm text-muted-foreground">{musicTags}</p>
        ) : (
          <p className="text-sm text-muted-foreground/60">Generating…</p>
        )}
      </FormField>

      <FormField label="Model">
        <MusicModelSelector
          selectedModel={selectedModel}
          onModelChange={onModelChange}
          generatedStatuses={audioModelStatuses}
        />
      </FormField>

      <FormField label="Duration (seconds)" htmlFor="music-duration">
        <Input
          id="music-duration"
          type="number"
          min={1}
          max={durationLimits.max}
          value={effectiveDuration}
          onChange={(e) => setEditDuration(Number(e.target.value))}
        />
        {durationExceedsMax && (
          <p className="flex items-center gap-1.5 text-xs text-warning">
            <AlertTriangle className="h-3.5 w-3.5" />
            Video is {Math.round(effectiveDuration)}s but {selectedModel} max is{' '}
            {durationLimits.max}s — music will be clamped.
          </p>
        )}
      </FormField>

      <div className="flex justify-center gap-3">
        {historyButton}
        {actionButton}
      </div>
      {historySheet}
    </StatusPanel>
  );
};

export const MusicViewSkeleton: React.FC = () => (
  <StatusPanel icon={<Skeleton className="h-10 w-10 rounded-full" />}>
    <Skeleton className="h-10 w-full" />
  </StatusPanel>
);
