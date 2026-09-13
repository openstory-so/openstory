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
import { SEQUENCE_HEADER_SLOT_ID } from '@/sequences/ui/sequence-header-slot';
import { UNTITLED_SEQUENCE_TITLE } from '@/sequences/untitled-sequence-title';
import { flagsFromStopAt, type GenerationStage } from '@/sequences/pipeline';
import { CanvasViewToggle } from '@/shots/ui/canvas-view-toggle';
import { SceneScriptDocument } from '@/shots/ui/scene-script-document';
import { useMemo } from 'react';

type CreatingScenesViewProps = {
  script: string;
  stopAt: GenerationStage;
  generateStartFrames: boolean;
};

export function CreatingScenesView({
  script,
  stopAt,
  generateStartFrames,
}: CreatingScenesViewProps) {
  const generationState = useMemo(() => {
    const flags = flagsFromStopAt(stopAt);
    const config: GenerationPhaseConfig = {
      stopAt,
      autoGenerateMotion: flags.autoGenerateMotion,
      autoGenerateMusic: flags.autoGenerateMusic,
      referenceOnly: !generateStartFrames,
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
  }, [stopAt, generateStartFrames]);

  return (
    <div className="flex h-full flex-col">
      <div className="mx-auto w-full max-w-[1920px] shrink-0 space-y-1 px-6 pt-4">
        <div className="flex min-w-0 items-center gap-1">
          <h1 className="truncate text-sm font-medium">
            {UNTITLED_SEQUENCE_TITLE}
          </h1>
          <div
            id={SEQUENCE_HEADER_SLOT_ID}
            className="@container flex min-w-0 flex-1 items-center justify-end pl-2"
          >
            <GenerationProgressBanner
              generationState={generationState}
              isProcessing
              script={script}
            />
          </div>
        </div>
      </div>
      <div className="mx-auto w-full max-w-[1920px] flex-1 min-h-0 overflow-hidden">
        <div className="flex h-full min-h-0">
          <div className="hidden shrink-0 pl-4 py-4 md:block">
            <div className="h-full w-[280px] lg:w-[360px]" />
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
          <div className="hidden shrink-0 md:block md:w-[380px] md:pr-4 md:py-4 lg:w-[420px]" />
        </div>
      </div>
    </div>
  );
}
