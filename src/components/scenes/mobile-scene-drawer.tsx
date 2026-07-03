import { MusicModelSelector } from '@/components/model/music-model-selector';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { DEFAULT_MUSIC_MODEL, type AudioModel } from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { cn } from '@/lib/utils';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import { ChevronUp, Loader2, Video } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { BatchGenerateMotionArgs } from './scene-list';
import { SceneListItem } from './scene-list-item';
import { SceneThumbnail } from './scene-thumbnail';

type MobileSceneDrawerProps = {
  shots?: ShotWithImage[];
  selectedShotId?: string;
  aspectRatio: AspectRatio;
  onSelectShot: (shotId: string) => void;
  regeneratingImages: Set<string>;
  regeneratingMotion: Set<string>;
  onBatchGenerateMotion?: (args: BatchGenerateMotionArgs) => Promise<void>;
  musicPromptsReady: boolean;
  /** Hide the batch motion button (e.g. while auto-generate motion is in flight). */
  hideBatchButton?: boolean;
  /** Initial music model for the batch selector (from `sequence.musicModel`). */
  initialMusicModel?: AudioModel;
};

export const MobileSceneDrawer: React.FC<MobileSceneDrawerProps> = ({
  shots,
  selectedShotId,
  aspectRatio,
  onSelectShot,
  regeneratingImages,
  regeneratingMotion,
  onBatchGenerateMotion,
  musicPromptsReady,
  hideBatchButton = false,
  initialMusicModel,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [includeMusic, setIncludeMusic] = useState(false);
  const [generateAudio, setGenerateAudio] = useState(true);
  const [musicModel, setMusicModel] = useState<AudioModel>(
    initialMusicModel ?? DEFAULT_MUSIC_MODEL
  );

  const prevInitialMusicRef = useRef(initialMusicModel);
  if (initialMusicModel && initialMusicModel !== prevInitialMusicRef.current) {
    prevInitialMusicRef.current = initialMusicModel;
    setMusicModel(initialMusicModel);
  }

  const totalShots = shots?.length ?? 0;

  // Get the currently selected shot
  const selectedShot = useMemo(
    () => shots?.find((f) => f.id === selectedShotId),
    [shots, selectedShotId]
  );

  // Calculate eligible shots for motion generation
  // Include 'generating' status to allow retrying stuck jobs
  const eligibleShots = useMemo(() => {
    if (!shots) return [];
    return shots.filter(
      (f) =>
        (f.videoStatus === 'pending' ||
          f.videoStatus === 'failed' ||
          f.videoStatus === 'generating') &&
        f.thumbnailStatus === 'completed'
    );
  }, [shots]);

  const handleSelectShot = (shotId: string) => {
    onSelectShot(shotId);
    setIsOpen(false);
  };

  // Check if all eligible shots have motion prompts ready
  const motionPromptsReady = useMemo(() => {
    if (!eligibleShots.length) return true;
    return eligibleShots.every(
      (f) => f.motionPrompt || f.motionPromptData?.fullPrompt
    );
  }, [eligibleShots]);

  const handleGenerateMotion = async () => {
    if (!onBatchGenerateMotion || eligibleShots.length === 0) return;

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

  // Extract scene info for the collapsed bar
  const sceneNumber =
    selectedShot?.metadata?.sceneNumber ?? (selectedShot?.orderIndex ?? 0) + 1;
  const sceneTitle =
    selectedShot?.metadata?.metadata?.title ?? `Scene ${sceneNumber}`;

  const hasEligibleShots = eligibleShots.length > 0;
  const isMotionInProgress = regeneratingMotion.size > 0;
  const showFooter =
    !hideBatchButton && hasEligibleShots && !isMotionInProgress;
  const isButtonDisabled =
    isGenerating ||
    isMotionInProgress ||
    eligibleShots.length === 0 ||
    !motionPromptsReady ||
    (includeMusic && !musicPromptsReady);

  return (
    <>
      {/* Collapsed bar - fixed at bottom */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={cn(
          'fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t bg-background px-4 py-3',
          'pb-[calc(0.75rem+env(safe-area-inset-bottom))]',
          'active:bg-muted/50 transition-colors'
        )}
      >
        <SceneThumbnail
          thumbnailUrl={selectedShot?.thumbnailUrl}
          previewThumbnailUrl={selectedShot?.previewThumbnailUrl}
          thumbnailStatus={selectedShot?.thumbnailStatus || undefined}
          alt={sceneTitle}
          aspectRatio={aspectRatio}
          className="h-10 w-10 shrink-0 rounded object-cover"
        />
        <span className="flex-1 truncate text-left text-sm font-medium">
          {selectedShot ? sceneTitle : 'Select a scene'}
        </span>
        <ChevronUp className="h-5 w-5 shrink-0 text-muted-foreground" />
      </button>

      {/* Expanded sheet */}
      <Sheet open={isOpen} onOpenChange={setIsOpen}>
        <SheetContent
          side="bottom"
          className="flex h-[70vh] flex-col pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHeader>
            <SheetTitle>
              {shots?.length ?? 0} {shots?.length === 1 ? 'Scene' : 'Scenes'}
            </SheetTitle>
          </SheetHeader>

          <ScrollArea className="flex-1 min-h-0 -mx-4">
            <div className="flex flex-col gap-3 px-4 py-2">
              {(shots === undefined || shots.length === 0) &&
                [1, 2, 3].map((i) => (
                  <SceneListItem
                    key={`shot-skeleton-${i}`}
                    shot={undefined}
                    aspectRatio={aspectRatio}
                    isActive={false}
                    onSelect={() => {}}
                  />
                ))}

              {shots?.map((shot) => (
                <SceneListItem
                  key={shot.id}
                  shot={shot}
                  aspectRatio={aspectRatio}
                  isActive={shot.id === selectedShotId}
                  onSelect={() => handleSelectShot(shot.id)}
                  isRegeneratingImage={regeneratingImages.has(shot.id)}
                  isRegeneratingMotion={regeneratingMotion.has(shot.id)}
                />
              ))}
            </div>
          </ScrollArea>

          {showFooter && (
            <SheetFooter className="border-t pt-4 px-4 flex-col items-stretch gap-3">
              {includeMusic && (
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">
                    Music model
                  </span>
                  <MusicModelSelector
                    selectedModel={musicModel}
                    onModelChange={setMusicModel}
                    disabled={isGenerating || isMotionInProgress}
                  />
                </div>
              )}
              <Button
                variant="default"
                onClick={() => void handleGenerateMotion()}
                disabled={isButtonDisabled}
              >
                {isGenerating || isMotionInProgress ? (
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
                    Generate {eligibleShots.length} / {totalShots}{' '}
                    {totalShots === 1 ? 'shot' : 'shots'}
                  </>
                )}
              </Button>
              <label className="flex items-center gap-2 text-sm text-muted-foreground justify-center">
                <Checkbox
                  checked={includeMusic}
                  onCheckedChange={(checked) =>
                    setIncludeMusic(checked === true)
                  }
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
                htmlFor="mobile-batch-generate-audio"
                className="flex items-center gap-2 text-sm text-muted-foreground justify-center"
              >
                <Checkbox
                  id="mobile-batch-generate-audio"
                  checked={generateAudio}
                  onCheckedChange={(checked) =>
                    setGenerateAudio(checked === true)
                  }
                />
                <span>Include SFX &amp; dialogue (when supported)</span>
              </label>
            </SheetFooter>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
};
