/**
 * Scenes chrome for Generate-in-flight (#1601): the parked script in the
 * splitting view. Empty side columns match `ScenesView` widths so replacing
 * the URL does not shove the script.
 */
import { GenerationProgressBanner } from '@/sequences/ui/generation/generation-progress-banner';
import {
  createInitialState,
  type GenerationPhaseConfig,
} from '@/sequences/ui/generation-stream.reducer';
import { SequenceHeaderPortal } from '@/sequences/ui/sequence-header-slot';
import type { GenerationStage } from '@/sequences/pipeline';
import { CanvasViewToggle } from '@/shots/ui/canvas-view-toggle';
import { SceneScriptDocument } from '@/shots/ui/scene-script-document';
import { useMemo } from 'react';

type CreatingScenesViewProps = {
  script: string;
  stopAt: GenerationStage;
  generateStartFrames: boolean;
  generateVoices?: boolean;
};

export function CreatingScenesView({
  script,
  stopAt,
  generateStartFrames,
  generateVoices = false,
}: CreatingScenesViewProps) {
  const generationState = useMemo(() => {
    const config: GenerationPhaseConfig = {
      stopAt,
      referenceOnly: !generateStartFrames,
      generateVoices,
    };
    const state = createInitialState(config);
    const first = state.phases[0];
    if (!first) return state;
    return {
      ...state,
      currentPhase: first.phase,
      phases: state.phases.map((phase, index) =>
        index === 0 ? { ...phase, status: 'active' as const } : phase
      ),
    };
  }, [stopAt, generateStartFrames, generateVoices]);

  return (
    <div className="flex h-full flex-col">
      <SequenceHeaderPortal>
        <GenerationProgressBanner
          generationState={generationState}
          isProcessing
          script={script}
        />
      </SequenceHeaderPortal>
      <div className="mx-auto w-full max-w-[1920px] flex-1 min-h-0 overflow-hidden">
        <div className="@container/scenes flex h-full min-h-0">
          <div className="hidden shrink-0 pl-4 py-4 md:block">
            <div className="h-full w-[clamp(220px,24cqw,360px)]" />
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <CanvasViewToggle
              view="script"
              onViewChange={() => undefined}
              canvasDisabled
            />
            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
              <SceneScriptDocument
                sequenceId=""
                scenes={[]}
                selectedSceneIds={[]}
                onSelectScene={() => undefined}
                splittingScript={script}
              />
            </div>
          </div>
          <div className="hidden shrink-0 @5xl/scenes:block @5xl/scenes:pr-4 @5xl/scenes:py-4">
            <div className="h-full w-[min(28cqw,420px)]" />
          </div>
        </div>
      </div>
    </div>
  );
}
