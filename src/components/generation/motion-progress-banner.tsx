import {
  type BannerPhase,
  ProgressBanner,
} from '@/components/generation/progress-banner';
import type { ShotView } from '@/lib/shots/shot-view';
import type { Sequence } from '@/lib/db/schema/sequences';
import {
  estimateMotionSeconds,
  estimateMusicSeconds,
} from '@/lib/generation/time-estimate';
import { useEffect, useMemo, useRef, useState } from 'react';

type MotionProgressBannerProps = {
  shots: ShotView[];
  sequence: Sequence;
  includeMusic: boolean;
  startedAt: number;
  onComplete: () => void;
};

type Phase = {
  key: string;
  name: string;
  shortName: string;
  status: 'pending' | 'active' | 'completed';
  budgetSeconds: number;
  description: string;
};

function isTerminal(status: string | null): boolean {
  // 'cancelled' (#1108) is terminal for video: without it, one cancelled shot
  // keeps `allMotionDone` false forever and this banner never finishes.
  // (Harmless for the `musicStatus` call below — music has no cancel.)
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

function derivePhases(
  shots: ShotView[],
  sequence: Sequence,
  includeMusic: boolean
): Phase[] {
  const allMotionDone =
    shots.length > 0 && shots.every((f) => isTerminal(f.videoStatus));
  const musicDone = isTerminal(sequence.musicStatus);

  const motionMusicComplete = includeMusic
    ? allMotionDone && musicDone
    : allMotionDone;
  const motionMusicStatus: Phase['status'] = motionMusicComplete
    ? 'completed'
    : 'active';

  const motionBudget = estimateMotionSeconds(sequence.videoModel, shots.length);
  const phase1Budget = includeMusic
    ? Math.max(motionBudget, estimateMusicSeconds(sequence.musicModel))
    : motionBudget;

  return [
    {
      key: 'motion-music',
      name: includeMusic
        ? 'Generating motion & music\u2026'
        : 'Generating motion\u2026',
      shortName: includeMusic ? 'Motion & Music' : 'Motion',
      status: motionMusicStatus,
      budgetSeconds: phase1Budget,
      description: includeMusic
        ? 'Animating scenes and composing music in parallel.'
        : 'Animating each scene with camera movement and motion effects.',
    },
  ];
}

export const MotionProgressBanner: React.FC<MotionProgressBannerProps> = ({
  shots,
  sequence,
  includeMusic,
  startedAt,
  onComplete,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startTimeRef = useRef(startedAt);

  // Tick elapsed time every second (initial call avoids 1s blank after hydration)
  useEffect(() => {
    const tick = () =>
      setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, []);

  const phases = useMemo(
    () => derivePhases(shots, sequence, includeMusic),
    [shots, sequence, includeMusic]
  );

  const allComplete = phases.every((p) => p.status === 'completed');
  const totalBudget = phases.reduce((sum, p) => sum + p.budgetSeconds, 0);
  const remaining = Math.max(0, totalBudget - elapsedSeconds);

  const bannerPhases: BannerPhase[] = phases.map(
    ({ budgetSeconds: _, ...phase }) => phase
  );

  return (
    <ProgressBanner
      phases={bannerPhases}
      remaining={remaining}
      isComplete={allComplete}
      defaultLabel="Generating&#xa0;motion"
      ariaPrefix="Motion"
      completedLabel="Motion complete"
      completedBadge="Done"
      exitDelayMs={1500}
      onExitComplete={onComplete}
      isOpen={isOpen}
      onOpenChange={setIsOpen}
    />
  );
};
