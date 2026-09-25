import { describe, expect, it } from 'vitest';
import {
  actionLabelForStage,
  artifactsFromSequenceState,
  bannerStagesForStopAt,
  completedStageFromArtifacts,
  sliderStages,
  sliderStopLabel,
  sliderTickLabel,
  stopAfterSentence,
  runScopeLabel,
  sliderThumbIndex,
  stopAtFromSliderIndex,
  continueOffersStartFramesSwitch,
  continueOffersVoicesSwitch,
  continueReachableFrom,
  continueStartFrom,
  alignContinueStartFrom,
  continueStageFromState,
  DEFAULT_GENERATION_STOP_AT,
  resolveContinueGenerationFlags,
  flagsFromStopAt,
  GENERATION_STAGES,
  includesStage,
  allowsUnfundedGeneration,
  isGenerationStage,
  isContinueStage,
  continueStageSchema,
  nextActionFromArtifacts,
  nextStageAfter,
  characterReferenceSheetsReady,
  referenceSheetProgress,
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
    expect(stagesUpTo('references')).toEqual(['script', 'references']);
  });

  it('lets unfunded teams run script analysis, not sheets or later stages', () => {
    expect(allowsUnfundedGeneration('script')).toBe(true);
    expect(allowsUnfundedGeneration('references')).toBe(false);
    expect(allowsUnfundedGeneration('images')).toBe(false);
    expect(allowsUnfundedGeneration('dialogue')).toBe(false);
    expect(allowsUnfundedGeneration('motion')).toBe(false);
    expect(allowsUnfundedGeneration('music')).toBe(false);
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
    expect(nextStageAfter('images')).toBe('dialogue');
    expect(nextStageAfter('dialogue')).toBe('motion');
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

  it('stays at script when a character sheet is still missing (#1727)', () => {
    const missingSheet = {
      ...empty,
      hasScenes: true,
      hasVisualPrompts: true,
      hasReferenceSheets: false,
    };
    expect(completedStageFromArtifacts(missingSheet)).toBe('script');
    expect(nextActionFromArtifacts(missingSheet)).toBe('references');

    const persistedAnyway = {
      ...missingSheet,
      pipelineStage: 'references' as const,
    };
    expect(completedStageFromArtifacts(persistedAnyway)).toBe('script');
    expect(nextActionFromArtifacts(persistedAnyway)).toBe('references');
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

    // Frame-based: a persisted References stage is done even before every
    // shot row shows a prompt, so continue cannot offer References again.
    const frameBased = artifactsFromSequenceState({
      sceneCount: 1,
      shots,
      pipelineStage: 'references',
    });
    expect(completedStageFromArtifacts(frameBased)).toBe('references');
    expect(nextActionFromArtifacts(frameBased)).toBe('images');

    const failedSheet = artifactsFromSequenceState({
      sceneCount: 1,
      shots: [
        {
          imagePromptVersion: {},
          frame: { imageStatus: null },
          videoStatus: 'pending',
        },
      ],
      pipelineStage: 'script',
      characters: [
        {
          voiceOnly: false,
          sheetStatus: 'failed',
          sheetImageUrl: null,
        },
        {
          voiceOnly: false,
          sheetStatus: 'completed',
          sheetImageUrl: '/r2/ada.png',
        },
      ],
    });
    expect(failedSheet.hasReferenceSheets).toBe(false);
    expect(completedStageFromArtifacts(failedSheet)).toBe('script');
    expect(nextActionFromArtifacts(failedSheet)).toBe('references');
  });

  it('advances continue past a persisted stage that has no shot artifacts yet', () => {
    const afterReferences = {
      ...empty,
      hasScenes: true,
      pipelineStage: 'references' as const,
    };
    expect(completedStageFromArtifacts(afterReferences)).toBe('references');
    expect(nextActionFromArtifacts(afterReferences)).toBe('images');

    const afterImages = {
      ...empty,
      hasScenes: true,
      hasVisualPrompts: true,
      pipelineStage: 'images' as const,
    };
    expect(completedStageFromArtifacts(afterImages)).toBe('images');
    expect(nextActionFromArtifacts(afterImages)).toBe('motion');
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

  it.each([false, true])(
    'offers Dialogue after images/references with Voices (reference-only: %s)',
    (referenceOnly) => {
      const artifacts = artifactsFromSequenceState({
        sceneCount: 1,
        shots: [
          {
            imagePromptVersion: {},
            frame: { imageStatus: 'completed' },
            videoStatus: 'pending',
          },
        ],
        pipelineStage: referenceOnly ? 'references' : 'images',
        referenceOnly,
        generateVoices: true,
      });
      expect(continueStageFromState({ isProcessing: false, artifacts })).toBe(
        'dialogue'
      );
      const stages = sliderStages(referenceOnly, true);
      expect(
        stopAtFromSliderIndex(sliderThumbIndex('dialogue', stages), stages)
      ).toBe('dialogue');
      expect(isContinueStage('dialogue')).toBe(true);
      expect(continueStageSchema.parse('dialogue')).toBe('dialogue');
      expect(
        nextActionFromArtifacts({ ...artifacts, pipelineStage: 'dialogue' })
      ).toBe('motion');
      expect(
        continueStageFromState({ isProcessing: true, artifacts })
      ).toBeNull();
    }
  );

  it('labels the continue button with the next stage verb', () => {
    expect(actionLabelForStage('script')).toBe('Analyze Script');
    expect(actionLabelForStage('images')).toBe('Generate Images');
    expect(actionLabelForStage('dialogue')).toBe('Generate Dialogue');
    expect(actionLabelForStage('motion')).toBe('Generate Motion');
    // The `music` stop runs motion too, so the verb must say both.
    expect(actionLabelForStage('music')).toBe('Generate Motion & Music');
    expect(actionLabelForStage('references')).toBe('Generate References');
    expect(actionLabelForStage('references', { remaining: 1, total: 3 })).toBe(
      'Generate 1 / 3 references'
    );
    expect(actionLabelForStage('references', { remaining: 1, total: 1 })).toBe(
      'Generate 1 / 1 reference'
    );
  });

  it('counts remaining on-screen character sheets for the references CTA (#1727)', () => {
    expect(
      referenceSheetProgress([
        {
          voiceOnly: false,
          sheetStatus: 'completed',
          sheetImageUrl: '/r2/ada.png',
        },
        { voiceOnly: false, sheetStatus: 'failed', sheetImageUrl: null },
        { voiceOnly: true, sheetStatus: 'completed', sheetImageUrl: null },
      ])
    ).toEqual({ remaining: 1, total: 2 });
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
    expect(
      actionLabelForStage('dialogue', {
        generateStartFrames: true,
        startFrom: 'images',
      })
    ).toBe('Generate Start Frames & Dialogue');
    expect(
      actionLabelForStage('dialogue', {
        generateStartFrames: true,
        startFrom: 'dialogue',
      })
    ).toBe('Generate Dialogue');
  });

  it('offers start-frames and Voices switches until those stages have finished', () => {
    expect(continueOffersStartFramesSwitch('references')).toBe(true);
    expect(continueOffersStartFramesSwitch('images')).toBe(true);
    expect(continueOffersStartFramesSwitch('dialogue')).toBe(false);
    expect(continueOffersVoicesSwitch('references')).toBe(true);
    expect(continueOffersVoicesSwitch('images')).toBe(true);
    expect(continueOffersVoicesSwitch('dialogue')).toBe(true);
    expect(continueOffersVoicesSwitch('motion')).toBe(false);
  });

  it('applies continue flag edits only for stages that have not run yet', () => {
    const current = { generateStartFrames: false, generateVoices: false };
    expect(
      resolveContinueGenerationFlags({
        startFrom: 'references',
        current,
        requested: { generateStartFrames: true, generateVoices: true },
      })
    ).toEqual({ generateStartFrames: true, generateVoices: true });
    expect(
      resolveContinueGenerationFlags({
        startFrom: 'images',
        current: { generateStartFrames: true, generateVoices: false },
        requested: { generateStartFrames: false, generateVoices: true },
      })
    ).toEqual({ generateStartFrames: false, generateVoices: true });
    expect(
      resolveContinueGenerationFlags({
        startFrom: 'dialogue',
        current: { generateStartFrames: true, generateVoices: true },
        requested: { generateStartFrames: false, generateVoices: false },
      })
    ).toEqual({ generateStartFrames: true, generateVoices: false });
  });

  it('continue starts at the next unrun stage, never a completed one', () => {
    const flags = { generateStartFrames: true, generateVoices: false };
    expect(continueReachableFrom('script', flags)).toBe('references');
    expect(continueReachableFrom('references', flags)).toBe('images');
    expect(continueReachableFrom('images', flags)).toBe('motion');
    expect(
      continueReachableFrom('references', {
        generateStartFrames: false,
        generateVoices: true,
      })
    ).toBe('dialogue');
    expect(
      continueReachableFrom('references', {
        generateStartFrames: false,
        generateVoices: false,
      })
    ).toBe('motion');
    expect(continueReachableFrom('dialogue', flags)).toBe('motion');
    expect(continueReachableFrom('music', flags)).toBeNull();
  });

  it('draft flags can skip Images when continue was about to start there', () => {
    expect(
      continueStartFrom('images', {
        generateStartFrames: true,
        generateVoices: false,
      })
    ).toBe('images');
    expect(
      continueStartFrom('images', {
        generateStartFrames: false,
        generateVoices: true,
      })
    ).toBe('dialogue');
    expect(
      continueStartFrom('images', {
        generateStartFrames: false,
        generateVoices: false,
      })
    ).toBe('motion');
    expect(
      continueStartFrom('references', {
        generateStartFrames: false,
        generateVoices: true,
      })
    ).toBe('references');
  });

  it('accepts an Images continue click after start frames are turned off', () => {
    const flags = { generateStartFrames: false, generateVoices: false };
    expect(alignContinueStartFrom('images', 'motion', flags)).toBe('motion');
    expect(
      alignContinueStartFrom('images', 'dialogue', {
        generateStartFrames: false,
        generateVoices: true,
      })
    ).toBe('dialogue');
    expect(
      alignContinueStartFrom('references', 'images', {
        generateStartFrames: true,
        generateVoices: false,
      })
    ).toBeNull();
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
