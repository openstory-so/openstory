import {
  type BannerPhase,
  ProgressBanner,
} from '@/components/generation/progress-banner';
import {
  estimateSceneCount,
  estimateTotalSeconds,
} from '@/shared/generation/time-estimate';
import type { GenerationStreamState } from '@/components/realtime/generation-stream.reducer';
import { useEffect, useRef, useState } from 'react';

/**
 * User-friendly descriptions for each generation phase.
 */

const PHASE_DESCRIPTIONS: Record<number, string> = {
  1: 'Breaking your script into scenes and casting characters, locations & elements',
  2: 'Generating reference sheets and crafting visual prompts',
  3: 'Generating images and writing motion & music prompts',
  4: 'Generating motion video and music',
};

type GenerationProgressBannerProps = {
  generationState: GenerationStreamState;
  isProcessing: boolean;
  startedAt?: Date;
  script?: string;
  /** When set, used instead of the banner's own elapsed-based remaining. */
  remainingSeconds?: number;
  analysisModel?: string | null;
  imageModel?: string | null;
  videoModel?: string | null;
  musicModel?: string | null;
  /** Show the ready-email promise in the leave hint. */
  willEmail?: boolean;
};

export const GenerationProgressBanner: React.FC<
  GenerationProgressBannerProps
> = ({
  generationState,
  isProcessing,
  startedAt,
  script,
  remainingSeconds,
  analysisModel,
  imageModel,
  videoModel,
  musicModel,
  willEmail = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startTimeRef = useRef(startedAt?.getTime() ?? Date.now());

  // Tick elapsed time every second (initial call avoids 1s blank after hydration)
  useEffect(() => {
    const tick = () =>
      setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, []);

  // Don't render before generation starts or after exit
  if (!isProcessing && generationState.currentPhase === 0) return null;

  const phase1Completed = generationState.phases[0]?.status === 'completed';
  const sceneCount = phase1Completed ? generationState.scenes.length : 0;
  const estimatedSceneCount = script ? estimateSceneCount(script) : undefined;
  const remaining =
    remainingSeconds ??
    Math.max(
      0,
      estimateTotalSeconds(
        sceneCount,
        estimatedSceneCount,
        generationState.phases.length,
        { analysisModel, imageModel, videoModel, musicModel }
      ) - elapsedSeconds
    );

  const bannerPhases: BannerPhase[] = generationState.phases.map((phase) => ({
    key: String(phase.phase),
    name: phase.phaseName,
    shortName: phase.shortName,
    status: phase.status,
    description:
      phase.status === 'active' ? PHASE_DESCRIPTIONS[phase.phase] : undefined,
  }));

  return (
    <ProgressBanner
      phases={bannerPhases}
      remaining={remaining}
      isComplete={generationState.isComplete}
      defaultLabel="Generating&#xa0;sequence"
      ariaPrefix="Generation"
      exitDelayMs={0}
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      leaveHint={
        willEmail ? (
          <>We&rsquo;ll email you when it&rsquo;s ready.</>
        ) : undefined
      }
    />
  );
};
