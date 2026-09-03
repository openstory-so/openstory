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
import { Label } from '@/components/ui/label';
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
  IMAGE_TO_VIDEO_MODELS,
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
import { useMemo, useState, type FC } from 'react';
import { useViaAvailability } from '@/hooks/use-via-availability';
import { AspectRatioPills } from './aspect-ratio-pills';
import { ResolutionPills } from './resolution-pills';
import { GenerationSettingsTrigger } from './generation-settings-trigger';

type AutoToggleProps = {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
};

const AutoToggle: FC<AutoToggleProps> = ({
  id,
  label,
  checked,
  onChange,
  disabled,
}) => (
  <div className="flex items-center gap-2">
    <input
      type="checkbox"
      id={id}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      disabled={disabled}
      className="h-4 w-4 rounded border-border text-primary focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
    />
    <Label htmlFor={id} className="text-sm font-normal cursor-pointer">
      {label}
    </Label>
  </div>
);

type GenerationSettingsProps = {
  aspectRatio: AspectRatio;
  resolution: Resolution;
  analysisModels: AnalysisModelId[];
  imageModels: TextToImageModel[];
  videoModels: ImageToVideoModel[];
  autoGenerateMotion?: boolean;
  /**
   * Generate a still per shot before motion (the frame-based workflow). Off,
   * the default, renders each shot straight to video from the cast / location
   * / element sheets. Omit the change handler to hide the control (contexts
   * that cannot switch mode).
   */
  generateStartFrames?: boolean;
  audioModels?: AudioModel[];
  autoGenerateMusic?: boolean;
  onAspectRatioChange: (value: AspectRatio) => void;
  onResolutionChange: (value: Resolution) => void;
  onAnalysisModelsChange: (value: AnalysisModelId[]) => void;
  onImageModelsChange: (value: TextToImageModel[]) => void;
  onVideoModelsChange: (value: ImageToVideoModel[]) => void;
  onAutoGenerateMotionChange?: (value: boolean) => void;
  onGenerateStartFramesChange?: (value: boolean) => void;
  onAudioModelsChange?: (value: AudioModel[]) => void;
  onAutoGenerateMusicChange?: (value: boolean) => void;
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
  /** Current style name, used in recommendation tooltips */
  styleName?: string;
  /** Style-recommended image model — drives the "Recommended" badge */
  recommendedImageModel?: string | null;
  /** Style-recommended video model — drives the "Recommended" badge */
  recommendedVideoModel?: string | null;
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
  autoGenerateMotion = true,
  generateStartFrames = false,
  audioModels,
  autoGenerateMusic = true,
  onAspectRatioChange,
  onResolutionChange,
  onAnalysisModelsChange,
  onImageModelsChange,
  onVideoModelsChange,
  onAutoGenerateMotionChange,
  onGenerateStartFramesChange,
  onAudioModelsChange,
  onAutoGenerateMusicChange,
  disabled = false,
  singleSelectAnalysis = false,
  singleSelectImage = false,
  singleSelectMotion = false,
  singleSelectMusic = false,
  styleCategory,
  styleName,
  recommendedImageModel,
  recommendedVideoModel,
  recommendedAspectRatio,
  appliedFromStyle,
  onResetStyleDefaults,
}) => {
  const [open, setOpen] = useState(false);
  // Motion off → the video models render nothing, so they neither widen the
  // tier choice nor cap it.
  const modelSelection = {
    imageModels,
    videoModels: autoGenerateMotion ? videoModels : [],
    aspectRatio,
  };

  // Per-team list from the `_app` loader, so the copy names the models this
  // team can actually pick — Grok Imagine included when xAI is reachable.
  const { referenceOnlyModels } = useViaAvailability();
  const referenceOnlyModelNames = useMemo(
    () =>
      new Intl.ListFormat('en', { style: 'long', type: 'disjunction' }).format(
        referenceOnlyModels.map((m) => IMAGE_TO_VIDEO_MODELS[m].name)
      ),
    [referenceOnlyModels]
  );

  /**
   * Reference-only renders nothing without motion, and the server rejects
   * that pair. Turning motion off only *disables* the start-frame toggle,
   * leaving its value to be submitted — so switch start frames on here instead.
   */
  const handleAutoGenerateMotionChange = (next: boolean) => {
    onAutoGenerateMotionChange?.(next);
    if (!next && !generateStartFrames) onGenerateStartFramesChange?.(true);
  };

  /**
   * Turning start frames OFF narrows the motion list, which can strand a selection
   * the server would then reject at submit. Drop the models that cannot render
   * without a start frame here, falling back to the first capable one so the
   * selection is never empty — the user sees the change while the panel is
   * open, rather than an error after pressing Generate.
   */
  const handleGenerateStartFramesChange = (next: boolean) => {
    onGenerateStartFramesChange?.(next);
    if (next) return;
    const capable = videoModels.filter((m) => referenceOnlyModels.includes(m));
    if (capable.length === videoModels.length) return;
    const fallback = referenceOnlyModels[0];
    onVideoModelsChange(
      capable.length > 0 ? capable : fallback ? [fallback] : videoModels
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-2 flex-wrap">
        <PopoverTrigger asChild disabled={disabled}>
          <GenerationSettingsTrigger
            aspectRatio={aspectRatio}
            resolution={resolution}
            autoGenerateMotion={autoGenerateMotion}
            autoGenerateMusic={autoGenerateMusic}
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
                recommendedImageModel={recommendedImageModel}
                styleName={styleName}
              />
            ) : (
              <ImageModelMultiSelector
                selectedModels={imageModels}
                onModelsChange={onImageModelsChange}
                disabled={disabled}
                recommendedImageModel={recommendedImageModel}
                styleName={styleName}
              />
            )}
          </section>

          <Separator />

          {/* Motion Model Section */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-foreground">
              {singleSelectMotion ? 'Motion Model' : 'Motion Models'}
            </h3>
            {onAutoGenerateMotionChange && (
              <AutoToggle
                id="auto-generate-motion"
                label="Auto-generate motion"
                checked={autoGenerateMotion}
                onChange={handleAutoGenerateMotionChange}
                disabled={disabled}
              />
            )}
            {onGenerateStartFramesChange && (
              <AutoToggle
                id="generate-start-frames"
                label="Generate start frames"
                checked={generateStartFrames}
                onChange={handleGenerateStartFramesChange}
                disabled={disabled || !autoGenerateMotion}
              />
            )}
            {onGenerateStartFramesChange && !generateStartFrames && (
              <p className="text-xs text-muted-foreground">
                Each shot renders straight to video from the character, location
                and element references — no still is generated first. Faster and
                cheaper, with looser control over composition. Only{' '}
                {referenceOnlyModelNames} can do this.
              </p>
            )}
            {singleSelectMotion ? (
              <MotionModelSelector
                selectedModel={videoModels[0] ?? DEFAULT_VIDEO_MODEL}
                onModelChange={(model) => onVideoModelsChange([model])}
                disabled={disabled || !autoGenerateMotion}
                aspectRatio={aspectRatio}
                styleCategory={styleCategory}
                recommendedVideoModel={recommendedVideoModel}
                styleName={styleName}
                referenceOnly={!generateStartFrames}
              />
            ) : (
              <MotionModelMultiSelector
                selectedModels={videoModels}
                onModelsChange={onVideoModelsChange}
                disabled={disabled || !autoGenerateMotion}
                aspectRatio={aspectRatio}
                styleCategory={styleCategory}
                recommendedVideoModel={recommendedVideoModel}
                styleName={styleName}
                referenceOnly={!generateStartFrames}
              />
            )}
          </section>

          {onAutoGenerateMusicChange && onAudioModelsChange && audioModels && (
            <>
              <Separator />

              {/* Music Model Section */}
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium text-foreground">
                  {singleSelectMusic ? 'Music Model' : 'Music Models'}
                </h3>
                <AutoToggle
                  id="auto-generate-music"
                  label="Auto-generate music"
                  checked={autoGenerateMusic}
                  onChange={onAutoGenerateMusicChange}
                  disabled={disabled}
                />
                {singleSelectMusic ? (
                  <MusicModelSelector
                    selectedModel={audioModels[0] ?? DEFAULT_MUSIC_MODEL}
                    onModelChange={(model) => onAudioModelsChange([model])}
                    disabled={disabled || !autoGenerateMusic}
                  />
                ) : (
                  <MusicModelMultiSelector
                    selectedModels={audioModels}
                    onModelsChange={onAudioModelsChange}
                    disabled={disabled || !autoGenerateMusic}
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
