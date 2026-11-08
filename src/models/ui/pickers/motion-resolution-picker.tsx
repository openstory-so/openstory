import { IMAGE_TO_VIDEO_MODELS } from '@/models/models';
import type { ImageToVideoModel } from '@/models/models';
import { clampResolution, type Resolution } from '@/models/resolutions';
import { motionResolutionTiers } from '@/motion/model-capabilities';
import { ResolutionPills } from '@/ui/settings/resolution-pills';
import { useId, type FC } from 'react';

type MotionResolutionPickerProps = {
  model: ImageToVideoModel;
  /** The sequence's tier; shown clamped to what `model` can render. */
  value: Resolution;
  onChange: (value: Resolution) => void;
  /** Draft first renders 480p then 1080p finals, so there is nothing to pick. */
  draft?: boolean;
  disabled?: boolean;
};

/** The sequence's resolution, offered where a motion run starts. */
export const MotionResolutionPicker: FC<MotionResolutionPickerProps> = ({
  model,
  value,
  onChange,
  draft = false,
  disabled = false,
}) => {
  const labelId = useId();
  const tiers = draft ? [] : motionResolutionTiers(model);
  const note = draft
    ? 'Drafts render at 480p, finals at 1080p.'
    : tiers.length < 2
      ? `${IMAGE_TO_VIDEO_MODELS[model].name} renders at a fixed size.`
      : 'Applies to the next generation.';

  return (
    <fieldset className="flex min-w-0 flex-col gap-2" aria-labelledby={labelId}>
      <span id={labelId} className="text-sm font-medium">
        Resolution
      </span>
      <ResolutionPills
        value={clampResolution(value, tiers)}
        onChange={onChange}
        available={tiers}
        disabled={disabled}
        note={note}
      />
    </fieldset>
  );
};
