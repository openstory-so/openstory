import { MotionModelSelector } from '@/components/model/motion-model-selector';
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
import type { SceneWithScript } from '@/hooks/use-scenes';
import {
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  type AudioModel,
  type ImageToVideoModel,
} from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { cn } from '@/lib/utils';
import type { ShotView } from '@/lib/shots/shot-view';
import { ChevronUp, Loader2, Video } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { BatchGenerateMotionArgs } from './scene-list';
import { SceneListItem } from './scene-list-item';
import { SceneThumbnail } from './scene-thumbnail';

type MobileSceneDrawerProps = {
  shots?: ShotView[];
  /** Scenes the shots belong to — they carry the number, title and script. */
  scenes?: SceneWithScript[];
  selectedShotId?: string;
  aspectRatio: AspectRatio;
  regeneratingImages: Set<string>;
  regeneratingMotion: Set<string>;
  onBatchGenerateMotion?: (args: BatchGenerateMotionArgs) => Promise<void>;
  musicPromptsReady: boolean;
  /** Hide the batch motion button (e.g. while auto-generate motion is in flight). */
  hideBatchButton?: boolean;
  /** Initial music model for the batch selector (from `sequence.musicModel`). */
  initialMusicModel?: AudioModel;
  /** Initial video model for the batch selector (from `sequence.videoModel`). */
  initialVideoModel?: ImageToVideoModel;
  styleCategory?: string;
  recommendedVideoModel?: string | null;
  styleName?: string;
};

export const MobileSceneDrawer: React.FC<MobileSceneDrawerProps> = ({
  shots,
  scenes,
  selectedShotId,
  aspectRatio,
  regeneratingImages,
  regeneratingMotion,
  onBatchGenerateMotion,
  musicPromptsReady,
  hideBatchButton = false,
  initialMusicModel,
  initialVideoModel,
  styleCategory,
  recommendedVideoModel,
  styleName,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [includeMusic, setIncludeMusic] = useState(false);
  const [generateAudio, setGenerateAudio] = useState(true);
  const [musicModel, setMusicModel] = useState<AudioModel>(
    initialMusicModel ?? DEFAULT_MUSIC_MODEL
  );
  const [videoModel, setVideoModel] = useState<ImageToVideoModel>(
    initialVideoModel ?? DEFAULT_VIDEO_MODEL
  );

  const prevInitialMusicRef = useRef(initialMusicModel);
  if (initialMusicModel && initialMusicModel !== prevInitialMusicRef.current) {
    prevInitialMusicRef.current = initialMusicModel;
    setMusicModel(initialMusicModel);
  }
  const prevInitialVideoRef = useRef(initialVideoModel);
  if (initialVideoModel && initialVideoModel !== prevInitialVideoRef.current) {
    prevInitialVideoRef.current = initialVideoModel;
    setVideoModel(initialVideoModel);
  }

  const totalShots = shots?.length ?? 0;

  const scenesById = useMemo(() => {
    const map = new Map<string, SceneWithScript>();
    for (const scene of scenes ?? []) map.set(scene.id, scene);
    return map;
  }, [scenes]);

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
        f.frame.imageStatus === 'completed'
    );
  }, [shots]);

  // The list item is a link; the drawer only has to get out of the way.
  const handleSelectShot = () => setIsOpen(false);

  // Check if all eligible shots have motion prompts ready
  const motionPromptsReady = useMemo(() => {
    if (!eligibleShots.length) return true;
    return eligibleShots.every((f) => f.motionPrompt?.fullPrompt);
  }, [eligibleShots]);

  const handleGenerateMotion = async () => {
    if (!onBatchGenerateMotion || eligibleShots.length === 0) return;

    setIsGenerating(true);
    try {
      await onBatchGenerateMotion({
        includeMusic,
        musicModel,
        videoModel,
        generateAudio,
      });
    } finally {
      setIsGenerating(false);
    }
  };

  // Extract scene info for the collapsed bar
  const selectedScene = selectedShot?.sceneId
    ? scenesById.get(selectedShot.sceneId)
    : undefined;
  const sceneNumber = (selectedScene?.orderIndex ?? 0) + 1;
  const sceneTitle = selectedScene?.title?.trim() || `Scene ${sceneNumber}`;

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
          thumbnailUrl={selectedShot?.image?.url}
          previewThumbnailUrl={selectedShot?.previewThumbnailUrl}
          thumbnailStatus={selectedShot?.frame.imageStatus || undefined}
          gridSheetUrl={selectedShot?.gridSheet?.url}
          pendingUpscaleIndex={selectedShot?.pendingUpscaleIndex}
          pendingUpscaleUrl={selectedShot?.pendingUpscaleUrl}
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
                  scene={
                    shot.sceneId ? scenesById.get(shot.sceneId) : undefined
                  }
                  aspectRatio={aspectRatio}
                  isActive={shot.id === selectedShotId}
                  onSelect={handleSelectShot}
                  isRegeneratingImage={regeneratingImages.has(shot.id)}
                  isRegeneratingMotion={regeneratingMotion.has(shot.id)}
                />
              ))}
            </div>
          </ScrollArea>

          {showFooter && (
            <SheetFooter className="border-t pt-4 px-4 flex-col items-stretch gap-3">
              <MotionModelSelector
                selectedModel={videoModel}
                onModelChange={setVideoModel}
                aspectRatio={aspectRatio}
                styleCategory={styleCategory}
                recommendedVideoModel={recommendedVideoModel}
                styleName={styleName}
                disabled={isGenerating || isMotionInProgress}
              />
              {includeMusic && (
                <MusicModelSelector
                  selectedModel={musicModel}
                  onModelChange={setMusicModel}
                  disabled={isGenerating || isMotionInProgress}
                />
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
