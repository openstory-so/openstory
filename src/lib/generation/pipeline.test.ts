import { describe, expect, it } from 'vitest';
import {
  actionLabelForStage,
  bannerStagesForStopAt,
  completedStageFromArtifacts,
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
  it('orders script → casting → references → images → motion → music', () => {
    expect([...GENERATION_STAGES]).toEqual([
      'script',
      'casting',
      'references',
      'images',
      'motion',
      'music',
    ]);
    expect(stageIndex('script')).toBe(0);
    expect(stageIndex('music')).toBe(5);
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
        generationStopAt: 'casting',
        autoGenerateMotion: false,
        autoGenerateMusic: false,
      })
    ).toBe('casting');
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
    expect(stagesUpTo('casting').map((s) => s)).toEqual(['script', 'casting']);
  });

  it('runs only the slice from startFrom through stopAt', () => {
    expect(shouldRunStage('casting', 'images', 'script')).toBe(false);
    expect(shouldRunStage('casting', 'images', 'casting')).toBe(true);
    expect(shouldRunStage('casting', 'images', 'images')).toBe(true);
    expect(shouldRunStage('casting', 'images', 'motion')).toBe(false);
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
    expect(nextStageAfter('script')).toBe('casting');
    expect(nextStageAfter('casting')).toBe('references');
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

  it('treats scenes without prompts as script-complete (next: casting)', () => {
    const artifacts = { ...empty, hasScenes: true };
    expect(completedStageFromArtifacts(artifacts)).toBe('script');
    expect(nextActionFromArtifacts(artifacts)).toBe('casting');
  });

  it('uses pipelineStage to distinguish script vs casting', () => {
    const afterCasting = {
      ...empty,
      hasScenes: true,
      pipelineStage: 'casting' as const,
    };
    expect(completedStageFromArtifacts(afterCasting)).toBe('casting');
    expect(nextActionFromArtifacts(afterCasting)).toBe('references');
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
  });

  it('labels the continue button with the next stage verb', () => {
    expect(actionLabelForStage('script')).toBe('Analyze Script');
    expect(actionLabelForStage('casting')).toBe('Cast Characters');
    expect(actionLabelForStage('images')).toBe('Generate Images');
    expect(actionLabelForStage('motion')).toBe('Generate Motion');
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
      'casting',
      'references',
      'images',
    ]);
    expect(bannerStagesForStopAt('motion')).toEqual([
      'script',
      'casting',
      'references',
      'images',
      'motion',
    ]);
    expect(bannerStagesForStopAt('music')).toEqual([
      'script',
      'casting',
      'references',
      'images',
      'motion',
    ]);
  });
});
