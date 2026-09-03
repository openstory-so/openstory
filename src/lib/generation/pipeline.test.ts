import { describe, expect, it } from 'vitest';
import {
  actionLabelForStage,
  artifactsFromSequenceState,
  bannerStagesForStopAt,
  completedStageFromArtifacts,
  sliderStages,
  sliderStopLabel,
  sliderThumbIndex,
  stopAtFromSliderIndex,
  continueStageFromState,
  DEFAULT_GENERATION_STOP_AT,
  flagsFromStopAt,
  GENERATION_STAGES,
  includesStage,
  isGenerationStage,
  nextActionFromArtifacts,
  nextStageAfter,
  resolveStopAt,
  shouldRunStage,
  stageIndex,
  stagesUpTo,
  stopAtFromFlags,
  type PipelineArtifacts,
} from './pipeline';

const empty: PipelineArtifacts = {
  hasScenes: false,
  hasVisualPrompts: false,
  hasImages: false,
  hasMotion: false,
  hasMusic: false,
};

describe('generation pipeline stages', () => {
  it('orders script → references → images → motion → music', () => {
    expect([...GENERATION_STAGES]).toEqual([
      'script',
      'references',
      'images',
      'motion',
      'music',
    ]);
    expect(stageIndex('script')).toBe(0);
    expect(stageIndex('music')).toBe(4);
  });

  it('defaults stop-at to music (stills + motion + music aha)', () => {
    expect(DEFAULT_GENERATION_STOP_AT).toBe('music');
    expect(flagsFromStopAt('music')).toEqual({
      autoGenerateMotion: true,
      autoGenerateMusic: true,
    });
  });

  it('maps stop-at onto the legacy auto-generate flags', () => {
    expect(flagsFromStopAt('images')).toEqual({
      autoGenerateMotion: false,
      autoGenerateMusic: false,
    });
    expect(flagsFromStopAt('motion')).toEqual({
      autoGenerateMotion: true,
      autoGenerateMusic: false,
    });
    expect(flagsFromStopAt('script')).toEqual({
      autoGenerateMotion: false,
      autoGenerateMusic: false,
    });
  });

  it('prefers an explicit stop-at over auto-generate flags', () => {
    expect(
      resolveStopAt({
        stopAt: 'references',
        autoGenerateMotion: false,
        autoGenerateMusic: false,
      })
    ).toBe('references');
    expect(
      resolveStopAt({
        autoGenerateMotion: false,
        autoGenerateMusic: false,
      })
    ).toBe('images');
  });

  it('maps legacy flags back onto a stop-at stage', () => {
    expect(
      stopAtFromFlags({ autoGenerateMotion: true, autoGenerateMusic: true })
    ).toBe('music');
    expect(
      stopAtFromFlags({ autoGenerateMotion: true, autoGenerateMusic: false })
    ).toBe('motion');
    expect(
      stopAtFromFlags({ autoGenerateMotion: false, autoGenerateMusic: false })
    ).toBe('images');
    expect(
      stopAtFromFlags({ autoGenerateMotion: false, autoGenerateMusic: true })
    ).toBe('images');
  });

  it('includes every stage up to the stop, none after', () => {
    expect(includesStage('references', 'script')).toBe(true);
    expect(includesStage('references', 'references')).toBe(true);
    expect(includesStage('references', 'images')).toBe(false);
    expect(stagesUpTo('references')).toEqual(['script', 'references']);
  });

  it('runs only the slice from startFrom through stopAt', () => {
    expect(shouldRunStage('references', 'images', 'script')).toBe(false);
    expect(shouldRunStage('references', 'images', 'references')).toBe(true);
    expect(shouldRunStage('references', 'images', 'images')).toBe(true);
    expect(shouldRunStage('references', 'images', 'motion')).toBe(false);
  });

  it('validates stage strings', () => {
    expect(isGenerationStage('images')).toBe(true);
    expect(isGenerationStage('stills')).toBe(false);
    expect(isGenerationStage(4)).toBe(false);
  });
});

describe('nextStageAfter', () => {
  it('starts at script when nothing has run', () => {
    expect(nextStageAfter(null)).toBe('script');
  });

  it('walks the DAG in order and ends at music', () => {
    expect(nextStageAfter('script')).toBe('references');
    expect(nextStageAfter('references')).toBe('images');
    expect(nextStageAfter('images')).toBe('motion');
    expect(nextStageAfter('motion')).toBe('music');
    expect(nextStageAfter('music')).toBe(null);
  });
});

describe('completedStageFromArtifacts / nextActionFromArtifacts', () => {
  it('returns null when the sequence has not been split yet', () => {
    expect(completedStageFromArtifacts(empty)).toBe(null);
    expect(nextActionFromArtifacts(empty)).toBe(null);
  });

  it('treats scenes without prompts as script-complete (next: references)', () => {
    const artifacts = { ...empty, hasScenes: true };
    expect(completedStageFromArtifacts(artifacts)).toBe('script');
    expect(nextActionFromArtifacts(artifacts)).toBe('references');
  });

  it('prefers artifacts over a stale pipelineStage write', () => {
    const imagesLanded = {
      ...empty,
      hasScenes: true,
      hasVisualPrompts: true,
      hasImages: true,
      pipelineStage: 'references' as const,
    };
    expect(completedStageFromArtifacts(imagesLanded)).toBe('images');
    expect(nextActionFromArtifacts(imagesLanded)).toBe('motion');
  });

  it('reference-only: References done means Images done too (next: motion)', () => {
    // No frame prompts or stills ever land in this mode, so the persisted
    // stage is the only evidence — and the Images stage renders nothing.
    const shots = [
      {
        imagePromptVersion: null,
        frame: { imageStatus: null },
        videoStatus: 'pending',
      },
    ];
    const afterReferences = artifactsFromSequenceState({
      sceneCount: 1,
      shots,
      pipelineStage: 'references',
      referenceOnly: true,
    });
    expect(completedStageFromArtifacts(afterReferences)).toBe('images');
    expect(nextActionFromArtifacts(afterReferences)).toBe('motion');

    const afterScript = artifactsFromSequenceState({
      sceneCount: 1,
      shots,
      pipelineStage: 'script',
      referenceOnly: true,
    });
    expect(nextActionFromArtifacts(afterScript)).toBe('references');

    // Frame-based still needs the artifacts themselves.
    const frameBased = artifactsFromSequenceState({
      sceneCount: 1,
      shots,
      pipelineStage: 'references',
    });
    expect(nextActionFromArtifacts(frameBased)).toBe('references');
  });

  it('offers motion after stills, music after motion, nothing after music', () => {
    const stills = {
      ...empty,
      hasScenes: true,
      hasVisualPrompts: true,
      hasImages: true,
    };
    expect(nextActionFromArtifacts(stills)).toBe('motion');

    const videos = { ...stills, hasMotion: true };
    expect(nextActionFromArtifacts(videos)).toBe('music');

    const done = { ...videos, hasMusic: true };
    expect(nextActionFromArtifacts(done)).toBe(null);

    // Music left over from a run whose shots were since deleted is not a
    // finished pipeline.
    const staleMusic = { ...empty, hasScenes: true, hasMusic: true };
    expect(nextActionFromArtifacts(staleMusic)).toBe('references');
  });

  it('labels the continue button with the next stage verb', () => {
    expect(actionLabelForStage('script')).toBe('Analyze Script');
    expect(actionLabelForStage('images')).toBe('Generate Images');
    expect(actionLabelForStage('motion')).toBe('Generate Motion');
    // The `music` stop runs motion too, so the verb must say both.
    expect(actionLabelForStage('music')).toBe('Generate Motion & Music');
    expect(actionLabelForStage('references')).toBe('Generate References');
  });

  it('does not offer a continue action while the sequence is processing', () => {
    const artifacts = {
      ...empty,
      hasScenes: true,
      hasVisualPrompts: true,
    };
    expect(nextActionFromArtifacts(artifacts)).toBe('images');
    expect(continueStageFromState({ isProcessing: true, artifacts })).toBe(
      null
    );
    expect(continueStageFromState({ isProcessing: false, artifacts })).toBe(
      'images'
    );
  });

  it('folds music into the motion banner segment (they run as one child)', () => {
    expect(bannerStagesForStopAt('images')).toEqual([
      'script',
      'references',
      'images',
    ]);
    expect(bannerStagesForStopAt('motion')).toEqual([
      'script',
      'references',
      'images',
      'motion',
    ]);
    expect(bannerStagesForStopAt('music')).toEqual([
      'script',
      'references',
      'images',
      'motion',
    ]);
  });

  it('slider folds music into the last stop (Music & Motion)', () => {
    const stages = sliderStages(false);
    expect(stages).toEqual(['script', 'references', 'images', 'motion']);
    expect(stopAtFromSliderIndex(3, stages)).toBe('music');
    expect(sliderThumbIndex('music', stages)).toBe(3);
    expect(sliderThumbIndex('motion', stages)).toBe(3);
    expect(sliderStopLabel('music')).toBe('Music & Motion');
    expect(sliderStopLabel('references')).toBe('References & Prompts');
    expect(sliderStopLabel('images')).toBe('Images');
  });

  it('slider has no Images stop in reference-only', () => {
    const stages = sliderStages(true);
    expect(stages).toEqual(['script', 'references', 'motion']);
    // A remembered Images stop lands on the next stop up, Music & Motion.
    expect(sliderThumbIndex('images', stages)).toBe(2);
    expect(stopAtFromSliderIndex(2, stages)).toBe('music');
    expect(sliderThumbIndex('references', stages)).toBe(1);
  });
});
