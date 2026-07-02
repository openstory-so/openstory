/**
 * Sticky "Generate N/M shots" batch-motion footer, shared by the desktop
 * spine (#986) and the legacy scene list used in the mobile drawer.
 */

import { MusicModelSelector } from '@/components/model/music-model-selector';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DEFAULT_MUSIC_MODEL, type AudioModel } from '@/lib/ai/models';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import { Loader2, Video } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

export type BatchGenerateMotionArgs = {
  includeMusic: boolean;
  musicModel: AudioModel;
  /** Lets the user suppress model-emitted audio (sfx/dialogue/ambient) for the
   *  batch. The flag is honored only by models that produce audio — non-audio
   *  models ignore it downstream during motion-prompt assembly. */
  generateAudio: boolean;
};

type BatchMotionFooterProps = {
  shots?: ShotWithImage[] | undefined;
  regeneratingMotion: Set<string>;
  onBatchGenerateMotion?: (args: BatchGenerateMotionArgs) => Promise<void>;
  musicPromptsReady: boolean;
  /** Hide the batch motion button (e.g. while auto-generate motion is in flight). */
  hideBatchButton?: boolean;
  /** Initial music model for the batch selector (from `sequence.musicModel`). */
  initialMusicModel?: AudioModel;
};

export const BatchMotionFooter: React.FC<BatchMotionFooterProps> = ({
  shots,
  regeneratingMotion,
  onBatchGenerateMotion,
  musicPromptsReady,
  hideBatchButton = false,
  initialMusicModel,
}) => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [includeMusic, setIncludeMusic] = useState(true);
  const [generateAudio, setGenerateAudio] = useState(true);
  const [musicModel, setMusicModel] = useState<AudioModel>(
    initialMusicModel ?? DEFAULT_MUSIC_MODEL
  );

  // Sync local selection when the sequence's saved model changes from outside
  // (e.g. after generation completes and the workflow persists the new model).
  const prevInitialMusicRef = useRef(initialMusicModel);
  if (initialMusicModel && initialMusicModel !== prevInitialMusicRef.current) {
    prevInitialMusicRef.current = initialMusicModel;
    setMusicModel(initialMusicModel);
  }

  const totalShots = shots?.length ?? 0;

  // Shots that need to be kicked off (not already generating)
  const notStartedShots = useMemo(() => {
    if (!shots) return [];
    return shots.filter(
      (f) =>
        (f.videoStatus === 'pending' || f.videoStatus === 'failed') &&
        f.thumbnailStatus === 'completed'
    );
  }, [shots]);

  const hasGeneratingShots = useMemo(() => {
    if (!shots) return false;
    return shots.some(
      (f) => f.videoStatus === 'generating' && f.thumbnailStatus === 'completed'
    );
  }, [shots]);

  // Check if all eligible shots have motion prompts ready
  const motionPromptsReady = useMemo(() => {
    if (!notStartedShots.length) return true;
    return notStartedShots.every(
      (f) => f.motionPrompt || f.motionPromptData?.fullPrompt
    );
  }, [notStartedShots]);

  const handleGenerateMotion = async () => {
    if (!onBatchGenerateMotion || notStartedShots.length === 0) return;

    setIsGenerating(true);
    try {
      await onBatchGenerateMotion({
        includeMusic,
        musicModel,
        generateAudio,
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const isMotionInProgress = regeneratingMotion.size > 0 || hasGeneratingShots;
  const showButton =
    !hideBatchButton && notStartedShots.length > 0 && !isMotionInProgress;
  const isButtonDisabled =
    isGenerating ||
    notStartedShots.length === 0 ||
    !motionPromptsReady ||
    (includeMusic && !musicPromptsReady);

  if (!showButton) return null;

  return (
    <div className="sticky bottom-0 border-t bg-background p-4 flex flex-col gap-3">
      {includeMusic && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Music model</span>
          <MusicModelSelector
            selectedModel={musicModel}
            onModelChange={setMusicModel}
            disabled={isGenerating || isMotionInProgress}
          />
        </div>
      )}
      <Button
        variant="default"
        className="w-full"
        onClick={() => void handleGenerateMotion()}
        disabled={isButtonDisabled}
      >
        {isGenerating ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Generating…
          </>
        ) : !motionPromptsReady ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Writing motion prompts…
          </>
        ) : includeMusic && !musicPromptsReady ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Composing music…
          </>
        ) : (
          <>
            <Video className="mr-2 h-4 w-4" />
            Generate {notStartedShots.length} / {totalShots}{' '}
            {totalShots === 1 ? 'shot' : 'shots'}
          </>
        )}
      </Button>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox
          checked={includeMusic}
          onCheckedChange={(checked) => setIncludeMusic(checked === true)}
          disabled={!musicPromptsReady}
        />
        <span>
          Also generate music
          {!musicPromptsReady && (
            <span className="text-xs ml-1">(preparing…)</span>
          )}
        </span>
      </label>
      <label
        htmlFor="batch-generate-audio"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Checkbox
          id="batch-generate-audio"
          checked={generateAudio}
          onCheckedChange={(checked) => setGenerateAudio(checked === true)}
        />
        <span>Include SFX &amp; dialogue (when the model supports it)</span>
      </label>
    </div>
  );
};
