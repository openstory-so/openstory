import {
  ImageModelMultiSelector,
  ImageModelSelector,
} from '@/components/model/image-model-selector';
import { ModelSelector } from '@/components/model/model-selector';
import {
  MotionModelMultiSelector,
  MotionModelSelector,
} from '@/components/model/motion-model-selector';
import {
  MusicModelMultiSelector,
  MusicModelSelector,
} from '@/components/model/music-model-selector';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  type AudioModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import type { AnalysisModelId } from '@/lib/ai/models.config';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { Resolution } from '@/lib/constants/resolutions';
import {
  availableResolutions,
  resolutionCeilingNote,
} from '@/lib/ai/resolution-support';
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
  audioModels?: AudioModel[];
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
  /** Current style name, used in aspect-ratio recommendation tooltips */
  styleName?: string;
  /** Style-recommended aspect ratio — drives the "Recommended" badge */
  recommendedAspectRatio?: string | null;
  /**
   * Active style-applied-defaults marker. When set, the trigger renders a
   * sibling pill saying "From style · Reset" (fixed text — style names vary in
   * length and would wrap the control row). Cleared on user reset.
   */
  appliedFromStyle?: { styleId: string; styleName: string } | null;
  /** Restore the pre-apply snapshot. Required when `appliedFromStyle` is set. */
  onResetStyleDefaults?: () => void;
};

export const GenerationSettings: FC<GenerationSettingsProps> = ({
  aspectRatio,
  resolution,
  analysisModels,
  imageModels,
  videoModels,
  audioModels,
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
  styleName,
  recommendedAspectRatio,
  appliedFromStyle,
  onResetStyleDefaults,
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
      <div className="flex items-center gap-2 flex-wrap">
        <PopoverTrigger asChild disabled={disabled}>
          <GenerationSettingsTrigger
            aspectRatio={aspectRatio}
            resolution={resolution}
          />
        </PopoverTrigger>
        {appliedFromStyle && onResetStyleDefaults && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-xs">
            {/* Mobile: just "Reset" — the label + trigger don't fit one row. */}
            <span className="hidden sm:inline">From style</span>
            <span
              aria-hidden="true"
              className="hidden text-primary/40 sm:inline"
            >
              ·
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto px-1 py-0 text-xs font-medium text-primary hover:bg-primary/15"
              onClick={onResetStyleDefaults}
              disabled={disabled}
            >
              Reset
            </Button>
          </span>
        )}
      </div>
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
              recommendedAspectRatio={recommendedAspectRatio}
              styleName={styleName}
            />
          </section>

          <Separator />

          {/* Resolution Section */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-foreground">Resolution</h3>
            <ResolutionPills
              value={resolution}
              onChange={onResolutionChange}
              available={availableResolutions(modelSelection)}
              disabled={disabled}
              note={resolutionCeilingNote(resolution, modelSelection)}
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
                aspectRatio={aspectRatio}
                styleCategory={styleCategory}
              />
            ) : (
              <MotionModelMultiSelector
                selectedModels={videoModels}
                onModelsChange={onVideoModelsChange}
                disabled={disabled}
                aspectRatio={aspectRatio}
                styleCategory={styleCategory}
              />
            )}
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
