import { describe, expect, it } from 'vitest';
import {
  bannerStagesForStopAt,
  sliderStages,
  sliderStopLabel,
  sliderTickLabel,
  stopAfterSentence,
  runScopeLabel,
  sliderThumbIndex,
  stopAtFromSliderIndex,
  DEFAULT_GENERATION_STOP_AT,
  flagsFromStopAt,
  GENERATION_STAGES,
  includesStage,
  allowsUnfundedGeneration,
  isGenerationStage,
  characterReferenceSheetsReady,
  resolveStopAt,
  stageIndex,
  stopAtFromFlags,
} from './pipeline';

describe('generation pipeline stages', () => {
  it('orders script → references → images → dialogue → motion → music', () => {
    expect([...GENERATION_STAGES]).toEqual([
      'script',
      'references',
      'images',
      'dialogue',
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
  });

  it('lets unfunded teams run script analysis, not sheets or later stages', () => {
    expect(allowsUnfundedGeneration('script')).toBe(true);
    expect(allowsUnfundedGeneration('references')).toBe(false);
    expect(allowsUnfundedGeneration('images')).toBe(false);
    expect(allowsUnfundedGeneration('dialogue')).toBe(false);
    expect(allowsUnfundedGeneration('motion')).toBe(false);
    expect(allowsUnfundedGeneration('music')).toBe(false);
  });

  it('validates stage strings', () => {
    expect(isGenerationStage('images')).toBe(true);
    expect(isGenerationStage('stills')).toBe(false);
    expect(isGenerationStage(4)).toBe(false);
  });
});

describe('banner and slider stops', () => {
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
    expect(bannerStagesForStopAt('music', { generateVoices: true })).toEqual([
      'script',
      'references',
      'images',
      'dialogue',
      'motion',
    ]);
  });
  it('slider folds music into the last stop (Motion & Music)', () => {
    const stages = sliderStages(false);
    expect(stages).toEqual(['script', 'references', 'images', 'motion']);
    expect(stopAtFromSliderIndex(3, stages)).toBe('music');
    expect(sliderThumbIndex('music', stages)).toBe(3);
    expect(sliderThumbIndex('motion', stages)).toBe(3);
    expect(sliderStopLabel('music')).toBe('Motion & Music');
    expect(sliderTickLabel('music')).toBe('Motion\u00a0&\nMusic');
    expect(sliderStopLabel('references')).toBe('References & Prompts');
    expect(sliderStopLabel('images')).toBe('Images');
    expect(stopAfterSentence('motion')).toBe('Don’t stop');
  });
  it('runScopeLabel names the Generate-button stop', () => {
    expect(runScopeLabel('music')).toBe('Whole sequence');
    expect(runScopeLabel('motion')).toBe('Whole sequence');
    expect(runScopeLabel('script')).toBe('Stops after Casting');
    expect(runScopeLabel('references')).toBe(
      'Stops after References & Prompts'
    );
    expect(runScopeLabel('images')).toBe('Stops after Images');
    expect(runScopeLabel('dialogue')).toBe('Stops after Dialogue');
  });
  it('slider has no Images stop in reference-only', () => {
    const stages = sliderStages(true);
    expect(stages).toEqual(['script', 'references', 'motion']);
    // A remembered Images stop lands on the next stop up, Motion & Music.
    expect(sliderThumbIndex('images', stages)).toBe(2);
    expect(stopAtFromSliderIndex(2, stages)).toBe('music');
    expect(sliderThumbIndex('references', stages)).toBe(1);
  });
  it('slider inserts Dialogue before motion when Voices is on without start frames', () => {
    const stages = sliderStages(true, true);
    expect(stages).toEqual(['script', 'references', 'dialogue', 'motion']);
    expect(stopAtFromSliderIndex(2, stages)).toBe('dialogue');
    expect(stopAtFromSliderIndex(3, stages)).toBe('music');
    expect(sliderStopLabel('dialogue')).toBe('Dialogue');
    expect(stopAfterSentence('dialogue')).toBe('Stop after dialogue');
  });
  it('slider folds Images and Dialogue into one stop when both are on', () => {
    const stages = sliderStages(false, true);
    expect(stages).toEqual(['script', 'references', 'dialogue', 'motion']);
    // A remembered Images stop is the combined tick (runs through Dialogue).
    expect(sliderThumbIndex('images', stages)).toBe(2);
    expect(stopAtFromSliderIndex(2, stages)).toBe('dialogue');
    expect(sliderThumbIndex('dialogue', stages)).toBe(2);
    expect(sliderStopLabel('dialogue', { generateStartFrames: true })).toBe(
      'Start Frames & Dialogue'
    );
    expect(sliderTickLabel('dialogue', { generateStartFrames: true })).toBe(
      'Start Frames\u00a0&\nDialogue'
    );
    expect(stopAfterSentence('dialogue', { generateStartFrames: true })).toBe(
      'Stop after start frames & dialogue'
    );
    expect(runScopeLabel('dialogue', { generateStartFrames: true })).toBe(
      'Stops after Start Frames & Dialogue'
    );
  });
  it('a fresh run is ready only when every on-screen sheet landed (#1727)', () => {
    expect(
      characterReferenceSheetsReady(
        [
          { characterId: 'ada', voiceOnly: false },
          { characterId: 'bob', voiceOnly: false },
          { characterId: 'narrator', voiceOnly: true },
        ],
        [
          {
            characterId: 'ada',
            sheetStatus: 'completed',
            sheetImageUrl: '/r2/ada.png',
          },
          { characterId: 'bob', sheetStatus: 'failed', sheetImageUrl: null },
        ]
      )
    ).toBe(false);
    expect(
      characterReferenceSheetsReady(
        [{ characterId: 'ada', voiceOnly: false }],
        [
          {
            characterId: 'ada',
            sheetStatus: 'completed',
            sheetImageUrl: '/r2/ada.png',
          },
        ]
      )
    ).toBe(true);
  });
});

describe('draft first copy (#1756)', () => {
  it('names the motion stop Drafts and keeps every other stop', () => {
    expect(sliderStopLabel('music', { draftFirst: true })).toBe('Drafts');
    expect(sliderStopLabel('images', { draftFirst: true })).toBe('Images');
    expect(stopAfterSentence('music', { draftFirst: true })).toBe(
      'Stop after drafts'
    );
    expect(stopAfterSentence('music')).toBe('Don’t stop');
    expect(runScopeLabel('music', { draftFirst: true })).toBe(
      'Stops after drafts'
    );
  });
});
