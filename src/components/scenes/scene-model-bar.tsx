import { AspectRatioIcon } from '@/components/icons/aspect-ratio-icon';
import { ModelBadge } from '@/components/model/model-badge';
import { Button } from '@/components/ui/button';
import { SequenceImageModelSelector } from '@/components/model/sequence-image-model-selector';
import { SequenceVideoModelSelector } from '@/components/model/sequence-video-model-selector';
import { StyleBadge } from '@/components/style/style-badge';
import { Kbd } from '@/components/ui/kbd';
import type { ImageToVideoModel, TextToImageModel } from '@/lib/ai/models';
import {
  getAspectRatioData,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import type { SelectionScope } from '@/lib/scenes/scene-selection';
import { usePostHog } from '@posthog/react';
import { Link } from '@tanstack/react-router';
import { CopyPlus } from 'lucide-react';

/**
 * Scope header for the inspector, plus — at sequence scope — the settings that
 * apply to the whole sequence.
 *
 * Sequence scope is the only home for these now: style, aspect ratio and the
 * script model are fixed at generation time (changing them means re-running the
 * script from the Script tab), while the image and video rows switch which
 * model's output the canvas shows. Every row is one badge, so the block reads
 * as a settings summary rather than a second set of pickers. It replaced the
 * pill bar that used to sit above the Script/Scenes tabs.
 *
 * Scene scope deliberately shows no model UI: a scene has no model identity
 * (#1066 moved it onto `frame_variants` / `video_variants`), so a selector here
 * would re-create the scene-level setting the schema just dropped.
 *
 * Shot scope shows none either — the Image and Video tabs own their own model
 * picker, next to the prompt and preview it affects. Music model likewise lives
 * on the sequence-scope Music tab.
 */
type SceneModelBarProps = {
  scope: SelectionScope;
  sequenceId?: string;
  resolvedSequenceImageModel: TextToImageModel;
  resolvedSequenceVideoModel: ImageToVideoModel;
  styleId?: string;
  stylePending?: boolean;
  aspectRatio?: AspectRatio;
  /** The LLM that analysed the script into scenes. Fixed post-analysis. */
  analysisModel?: string;
};

export const scopeLabel: Record<SelectionScope, string> = {
  sequence: 'Sequence settings',
  scenes: 'Scene assets',
  shot: 'Shot assets',
};

const SettingRow: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div className="flex items-center justify-between gap-2">
    <span className="text-sm text-muted-foreground">{label}</span>
    {children}
  </div>
);

export const SceneModelBar: React.FC<SceneModelBarProps> = ({
  scope,
  sequenceId,
  resolvedSequenceImageModel,
  resolvedSequenceVideoModel,
  styleId,
  stylePending,
  aspectRatio,
  analysisModel,
}) => {
  const posthog = usePostHog();
  const showSequenceSettings = scope === 'sequence';
  const ratio = aspectRatio ? getAspectRatioData(aspectRatio) : undefined;

  return (
    <div className="space-y-3 px-4 py-3">
      {/* Hidden on phones — the collapse bar already names the scope. */}
      <div className="hidden items-center justify-between gap-2 md:flex">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {scopeLabel[scope]}
        </span>
        {/* Scope zoom-out affordance — Esc walks shot → scene → sequence. */}
        {scope !== 'sequence' && (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            <Kbd>esc</Kbd> up
          </span>
        )}
      </div>
      {showSequenceSettings && (
        <div className="space-y-2">
          <SettingRow label="Style">
            <StyleBadge
              styleId={styleId}
              sequenceId={sequenceId}
              stylePending={stylePending}
            />
          </SettingRow>
          <SettingRow label="Aspect ratio">
            <span className="flex items-center gap-1.5">
              {ratio && (
                <AspectRatioIcon
                  width={ratio.width}
                  height={ratio.height}
                  size="sm"
                />
              )}
              <span className="font-mono text-sm">{aspectRatio}</span>
            </span>
          </SettingRow>
          <SettingRow label="Script">
            <ModelBadge model={analysisModel} />
          </SettingRow>
          {/* Both degrade to a plain badge until something has generated, so
                every row here reads the same; the dropdown adds switching,
                add-a-model and the sequence-wide Set once there is output. */}
          {sequenceId && (
            <>
              <SequenceImageModelSelector
                sequenceId={sequenceId}
                sequenceImageModel={resolvedSequenceImageModel}
                label="Image"
              />
              <SequenceVideoModelSelector
                sequenceId={sequenceId}
                sequenceVideoModel={resolvedSequenceVideoModel}
                label="Video"
              />
            </>
          )}

          {/* The escape hatch for the three fixed rows above: they can only
              change by re-running analysis, which produces a new sequence
              (#1037, formerly on the script page). A plain Link, not a dialog —
              it lands on the real composer with everything pre-populated, so
              Enhance, style recommendations and element drop all come for free
              rather than being reproduced in a modal. */}
          {sequenceId && (
            <Button variant="outline" size="sm" className="w-full" asChild>
              <Link
                to="/sequences/new"
                search={{ from: sequenceId }}
                onClick={() =>
                  posthog.capture('make_another_clicked', {
                    surface: 'generate_copy',
                    sequence_id: sequenceId,
                  })
                }
              >
                <CopyPlus className="mr-2 h-3.5 w-3.5" />
                Generate Copy…
              </Link>
            </Button>
          )}
        </div>
      )}
    </div>
  );
};
