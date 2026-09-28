import {
  GENERATION_STAGE_META,
  includesStage,
  sliderStages,
  sliderTickLabel,
  sliderThumbIndex,
  stopAfterSentence,
  stopAtFromSliderIndex,
} from '@/sequences/pipeline';
import type { GenerationStage } from '@/sequences/pipeline';
import { VOICE_ESTIMATE_COST } from '@/billing/elevenlabs-pricing';
import { microsToDisplayUsd } from '@/billing/money';
import { Label } from '@/ui/shadcn/label';
import { Slider } from '@/ui/shadcn/slider';
import { Switch } from '@/ui/shadcn/switch';
import { cn } from '@/ui/utils';
import { useEffect, type FC } from 'react';

type GenerationStopSliderProps = {
  value: GenerationStage;
  onChange: (stage: GenerationStage) => void;
  /** Continue-from: the thumb cannot move earlier than this stage. */
  minStage?: GenerationStage;
  /**
   * The thumb cannot move past this stage: a switch just turned on stops the
   * run at its own step (`switchStopAt`, #1780 §3).
   */
  maxStage?: GenerationStage;
  /**
   * Render a still per shot before motion. Off = reference-only, which has no
   * Images stop. Pass `onGenerateStartFramesChange` to offer the switch; it
   * shows at every step (#1780 §2).
   */
  generateStartFrames?: boolean;
  onGenerateStartFramesChange?: (value: boolean) => void;
  /** Stills exist: the switch can turn on, never off (#1817). */
  startFramesLocked?: boolean;
  /** Design a voice per speaking character (#1553); offered like start frames. */
  generateVoices?: boolean;
  onGenerateVoicesChange?: (value: boolean) => void;
  /** Recordings exist: Voices can turn on, never off (#1817). */
  voicesLocked?: boolean;
  /**
   * Draft first (#1756): the motion pass renders 480p drafts and the run
   * stops there; the 1080p finals are rendered from the scene list once the
   * drafts are approved. Pass `onDraftFirstChange` to offer the switch (a
   * chosen model has a draft mode and this team can reach Ark).
   */
  draftFirst?: boolean;
  onDraftFirstChange?: (value: boolean) => void;
  /** Every clip exists: shown, not changeable (#1780 §2). */
  draftFirstLocked?: boolean;
  /**
   * The sequence has music (`sequences.includeMusic`). Pass
   * `onIncludeMusicChange` to offer the switch; it shows at the Music stop.
   */
  includeMusic?: boolean;
  onIncludeMusicChange?: (value: boolean) => void;
  disabled?: boolean;
};

/**
 * The Finals tick is not a stop the thumb can reach: a run never renders
 * finals on its own (that would pay for the draft and the final with no look
 * in between). It is on the track so the road ahead is visible.
 */
const FINALS_TICK = 'final';
type Tick = GenerationStage | typeof FINALS_TICK;

function stopLabelPercent(index: number, lastStop: number): number {
  return lastStop === 0 ? 0 : (index / lastStop) * 100;
}

export const GenerationStopSlider: FC<GenerationStopSliderProps> = ({
  value,
  onChange,
  minStage,
  maxStage,
  generateStartFrames = true,
  onGenerateStartFramesChange,
  startFramesLocked = false,
  generateVoices = false,
  onGenerateVoicesChange,
  voicesLocked = false,
  draftFirst = false,
  onDraftFirstChange,
  draftFirstLocked = false,
  includeMusic = true,
  onIncludeMusicChange,
  disabled = false,
}) => {
  const stages = sliderStages(!generateStartFrames, generateVoices);
  const lastStop = stages.length - 1;
  const ticks: Tick[] = draftFirst ? [...stages, FINALS_TICK] : stages;
  const lastTick = ticks.length - 1;
  const minIndex = minStage ? sliderThumbIndex(minStage, stages) : 0;
  const maxIndex = Math.max(
    minIndex,
    maxStage ? sliderThumbIndex(maxStage, stages) : lastStop
  );
  const clampedIndex = Math.min(
    maxIndex,
    Math.max(minIndex, sliderThumbIndex(value, stages))
  );
  const selected = stopAtFromSliderIndex(clampedIndex, stages);
  const combinedStillsAndDialogue = generateStartFrames && generateVoices;
  // Images is not a slider stop when Voices is also on — promote so the
  // parent stores Dialogue (the combined tick) rather than a hidden Images.
  useEffect(() => {
    if (selected !== value) onChange(selected);
  }, [onChange, selected, value]);
  // Six ticks do not fit on one line; alternate them above and below the
  // track so neighbours never collide.
  const alternate = ticks.length > 5;

  const tickLabel = (tick: Tick, index: number): string => {
    if (tick === FINALS_TICK) return 'Finals';
    if (index === lastStop) return sliderTickLabel(tick, { draftFirst });
    if (tick === 'dialogue' && combinedStillsAndDialogue) {
      return sliderTickLabel('dialogue', { generateStartFrames: true });
    }
    return GENERATION_STAGE_META[tick].shortName;
  };

  /*
    Radix insets each thumb by half its width so it stays on the track
    (`size-3` → 6px). Labels use the same inset, then sit on the stop
    percentages — not in equal flex cells, which centre between stops.
  */
  const tickRow = (side: 'above' | 'below') => (
    <div className="px-1.5" aria-hidden="true">
      <div className="relative min-h-8">
        {ticks.map((tick, index) => {
          if (alternate && (index % 2 === 1) !== (side === 'above')) {
            return null;
          }
          const ghost = tick === FINALS_TICK;
          const locked = ghost || index < minIndex || index > maxIndex;
          return (
            <button
              key={tick}
              type="button"
              disabled={disabled || locked}
              title={ghost ? 'After you approve the drafts' : undefined}
              onClick={() => {
                if (locked) return;
                onChange(stopAtFromSliderIndex(index, stages));
              }}
              className={cn(
                'absolute max-w-[6.5rem] text-[11px] leading-tight tracking-wide whitespace-pre-line line-clamp-2',
                side === 'above' ? 'bottom-0' : 'top-0',
                index === 0
                  ? 'translate-x-0 text-left'
                  : index === lastTick
                    ? '-translate-x-full text-right'
                    : '-translate-x-1/2 text-center',
                !ghost && index <= clampedIndex
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground/40',
                locked && !ghost && 'cursor-not-allowed opacity-50'
              )}
              style={{ left: `${stopLabelPercent(index, lastTick)}%` }}
            >
              {/* Ticks name the stop; the heading above says what happens
                  there. The last tick used stopAfterSentence, so it repeated
                  the heading ("Don't stop") instead of naming the stage. */}
              {tickLabel(tick, index)}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="generation-stop-label"
    >
      <h3
        id="generation-stop-label"
        className="text-sm font-medium text-foreground"
      >
        {stopAfterSentence(selected, {
          generateStartFrames: combinedStillsAndDialogue,
          draftFirst,
        })}
      </h3>
      {alternate && tickRow('above')}
      <Slider
        min={0}
        max={lastTick}
        step={1}
        value={[clampedIndex]}
        disabled={disabled}
        onValueChange={(next) => {
          const index = next[0];
          if (index === undefined) return;
          onChange(
            stopAtFromSliderIndex(
              Math.min(maxIndex, Math.max(minIndex, index)),
              stages
            )
          );
        }}
        aria-label="How far generation should run"
      />
      {tickRow('below')}
      {/* A switch shows only when it changes a step this run takes. */}
      {onGenerateStartFramesChange && includesStage(selected, 'images') && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Switch
              id="generate-start-frames"
              checked={generateStartFrames}
              onCheckedChange={(next) => {
                onGenerateStartFramesChange(next);
                // Off drops the Images stop; a thumb sitting on it moves up to
                // Motion & Music so the parent's value matches the slider.
                const nextStages = sliderStages(!next, generateVoices);
                const moved = stopAtFromSliderIndex(
                  sliderThumbIndex(value, nextStages),
                  nextStages
                );
                if (moved !== value) onChange(moved);
              }}
              disabled={disabled || (startFramesLocked && generateStartFrames)}
            />
            <Label htmlFor="generate-start-frames" className="text-sm">
              Use start frames
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            {startFramesLocked && generateStartFrames
              ? 'Shots have stills, so start frames stay on.'
              : generateStartFrames
                ? 'Each shot’s video starts from a generated still.'
                : 'Video is generated straight from the reference sheets.'}
          </p>
        </div>
      )}
      {onGenerateVoicesChange && includesStage(selected, 'references') && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Switch
              id="generate-voices"
              checked={generateVoices}
              onCheckedChange={(next) => {
                onGenerateVoicesChange(next);
                const nextStages = sliderStages(!generateStartFrames, next);
                const moved = stopAtFromSliderIndex(
                  sliderThumbIndex(value, nextStages),
                  nextStages
                );
                if (moved !== value) onChange(moved);
              }}
              disabled={disabled || (voicesLocked && generateVoices)}
            />
            <Label htmlFor="generate-voices" className="text-sm">
              Voices
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            {voicesLocked && generateVoices
              ? 'Shots have recorded dialogue, so voices stay on.'
              : generateVoices
                ? `Each speaking character gets a designed voice (${microsToDisplayUsd(VOICE_ESTIMATE_COST)} each).`
                : 'Characters have no voice.'}
          </p>
        </div>
      )}
      {onIncludeMusicChange && selected === 'music' && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Switch
              id="include-music"
              checked={includeMusic}
              onCheckedChange={onIncludeMusicChange}
              disabled={disabled}
            />
            <Label htmlFor="include-music" className="text-sm">
              Music
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            {includeMusic
              ? 'One track for the whole sequence.'
              : 'No music track.'}
          </p>
        </div>
      )}
      {onDraftFirstChange && includesStage(selected, 'motion') && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Switch
              id="draft-first"
              checked={draftFirst}
              onCheckedChange={onDraftFirstChange}
              disabled={disabled || draftFirstLocked}
            />
            <Label htmlFor="draft-first" className="text-sm">
              Draft first
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            {draftFirst
              ? 'Clips render at 480p first. Approve them, then render the 1080p finals. Drafts last seven days.'
              : 'Clips render at full quality straight away.'}
          </p>
        </div>
      )}
    </section>
  );
};
