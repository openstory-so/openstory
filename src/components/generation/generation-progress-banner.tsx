import {
  type BannerPhase,
  ProgressBanner,
} from '@/components/generation/progress-banner';
import { PHASE_DESCRIPTIONS } from '@/lib/generation/phase-descriptions';
import {
  estimateSceneCount,
  estimateTotalSeconds,
} from '@/lib/generation/time-estimate';
import type { GenerationStreamState } from '@/lib/realtime/generation-stream.reducer';
import { useEffect, useRef, useState } from 'react';

type GenerationProgressBannerProps = {
  generationState: GenerationStreamState;
  isProcessing: boolean;
  startedAt?: Date;
  script?: string;
  /** When set, used instead of the banner's own elapsed-based remaining. */
  remainingSeconds?: number;
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
  imageModel,
  videoModel,
  musicModel,
  willEmail = false,
}) => {
  const [isOpen, setIsOpen] = useState(true);
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
        { imageModel, videoModel, musicModel }
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
