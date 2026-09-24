import {
  ImageModelMultiSelector,
  ImageModelSelector,
} from '@/models/ui/pickers/image-model-selector';
import { ModelSelector } from '@/models/ui/pickers/model-selector';
import {
  MotionModelMultiSelector,
  MotionModelSelector,
} from '@/models/ui/pickers/motion-model-selector';
import {
  MusicModelMultiSelector,
  MusicModelSelector,
} from '@/models/ui/pickers/music-model-selector';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/shadcn/popover';
import { Separator } from '@/ui/shadcn/separator';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  type AudioModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/models/models';
import type { AnalysisModelId } from '@/models/models.config';
import type { AspectRatio } from '@/models/aspect-ratios';
import type { Resolution } from '@/models/resolutions';
import {
  availableResolutions,
  resolutionCeilingNote,
} from '@/models/ui/resolution-support';
import { useState, type FC } from 'react';
import { AspectRatioPills } from './aspect-ratio-pills';
import { ResolutionPills } from './resolution-pills';
import { GenerationSettingsTrigger } from './generation-settings-trigger';

type GenerationSettingsProps = {
  aspectRatio: AspectRatio;
  resolution: Resolution;
  analysisModels: AnalysisModelId[];
  imageModels: TextToImageModel[];
  videoModels: ImageToVideoModel[];
  /**
   * Generate a still per shot before motion (the frame-based workflow). Off,
   * the default, renders each shot straight to video from the cast / location
   * / element sheets. Chosen on the Generate dialog (#1408); here it only
   * narrows the motion models to the ones that can render without a still.
   */
  generateStartFrames?: boolean;
  audioModels?: AudioModel[];
  /**
   * Draft first (#1756) pins the tier: drafts are 480p and Ark renders the
   * final at 1080p only. The pills go read-only and this note says why.
   */
  resolutionLockNote?: string | null;
  onAspectRatioChange: (value: AspectRatio) => void;
  onResolutionChange: (value: Resolution) => void;
  onAnalysisModelsChange: (value: AnalysisModelId[]) => void;
  onImageModelsChange: (value: TextToImageModel[]) => void;
  onVideoModelsChange: (value: ImageToVideoModel[]) => void;
  onAudioModelsChange?: (value: AudioModel[]) => void;
  disabled?: boolean;
  singleSelectAnalysis?: boolean;
  /** Use single-select for image model (e.g. in regeneration context) */
  singleSelectImage?: boolean;
  /** Use single-select for motion model (e.g. in regeneration context) */
  singleSelectMotion?: boolean;
  /** Use single-select for music model (e.g. in regeneration context) */
  singleSelectMusic?: boolean;
  /** Current style category, used to show/hide style-restricted motion models */
  styleCategory?: string;
};

export const GenerationSettings: FC<GenerationSettingsProps> = ({
  aspectRatio,
  resolution,
  analysisModels,
  imageModels,
  videoModels,
  generateStartFrames = false,
  audioModels,
  resolutionLockNote = null,
  onAspectRatioChange,
  onResolutionChange,
  onAnalysisModelsChange,
  onImageModelsChange,
  onVideoModelsChange,
  onAudioModelsChange,
  disabled = false,
  singleSelectAnalysis = false,
  singleSelectImage = false,
  singleSelectMotion = false,
  singleSelectMusic = false,
  styleCategory,
}) => {
  const [open, setOpen] = useState(false);
  // How far the run goes is picked at Generate (#1408), so the video models
  // always count toward the tier choice here.
  const modelSelection = {
    imageModels,
    videoModels,
    aspectRatio,
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <GenerationSettingsTrigger aspectRatio={aspectRatio} />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={12}
        className="w-[min(22rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-x-hidden p-4"
      >
        <div className="flex min-w-0 flex-col gap-4">
          {/* Aspect Ratio Section */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-foreground">
              Aspect Ratio
            </h3>
            <AspectRatioPills
              value={aspectRatio}
              onChange={onAspectRatioChange}
            />
          </section>

          <Separator />

          {/* Analysis Model Section */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-foreground">
              Analysis Model
            </h3>
            <ModelSelector
              selectedModels={analysisModels}
              onModelsChange={onAnalysisModelsChange}
              disabled={disabled}
              singleSelect={singleSelectAnalysis}
            />
          </section>

          <Separator />

          {/* Image Model Section */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-foreground">
              {singleSelectImage ? 'Image Model' : 'Image Models'}
            </h3>
            {singleSelectImage ? (
              <ImageModelSelector
                selectedModel={imageModels[0] ?? DEFAULT_IMAGE_MODEL}
                onModelChange={(model) => onImageModelsChange([model])}
                disabled={disabled}
              />
            ) : (
              <ImageModelMultiSelector
                selectedModels={imageModels}
                onModelsChange={onImageModelsChange}
                disabled={disabled}
              />
            )}
          </section>

          <Separator />

          {/* Motion Model Section */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-foreground">
              {singleSelectMotion ? 'Motion Model' : 'Motion Models'}
            </h3>
            {singleSelectMotion ? (
              <MotionModelSelector
                selectedModel={videoModels[0] ?? DEFAULT_VIDEO_MODEL}
                onModelChange={(model) => onVideoModelsChange([model])}
                disabled={disabled}
                size="sm"
                aspectRatio={aspectRatio}
                styleCategory={styleCategory}
                referenceOnly={!generateStartFrames}
              />
            ) : (
              <MotionModelMultiSelector
                selectedModels={videoModels}
                onModelsChange={onVideoModelsChange}
                disabled={disabled}
                size="sm"
                aspectRatio={aspectRatio}
                styleCategory={styleCategory}
                referenceOnly={!generateStartFrames}
              />
            )}
            <h3 className="text-sm font-medium text-foreground">Resolution</h3>
            <ResolutionPills
              value={resolution}
              onChange={onResolutionChange}
              available={availableResolutions(modelSelection)}
              disabled={disabled || Boolean(resolutionLockNote)}
              note={
                resolutionLockNote ??
                resolutionCeilingNote(resolution, modelSelection)
              }
            />
          </section>

          {onAudioModelsChange && audioModels && (
            <>
              <Separator />

              {/* Music Model Section */}
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium text-foreground">
                  {singleSelectMusic ? 'Music Model' : 'Music Models'}
                </h3>
                {singleSelectMusic ? (
                  <MusicModelSelector
                    selectedModel={audioModels[0] ?? DEFAULT_MUSIC_MODEL}
                    onModelChange={(model) => onAudioModelsChange([model])}
                    disabled={disabled}
                  />
                ) : (
                  <MusicModelMultiSelector
                    selectedModels={audioModels}
                    onModelsChange={onAudioModelsChange}
                    disabled={disabled}
                  />
                )}
              </section>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};
