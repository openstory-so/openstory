import { describe, expect, it } from 'vitest';
import {
  displaySummary,
  historyChanges,
  mediaVersionIds,
} from './history-changes';

describe('historyChanges', () => {
  it('names a setting from and to, and a style by its current name', () => {
    const lines = historyChanges(
      {
        fields: ['styleId', 'imageModel'],
        changes: [
          { field: 'styleId', from: 'style-a', to: 'style-b' },
          { field: 'imageModel', from: 'nano_banana_2', to: 'gpt_image_2' },
          { field: 'generationStopAt', from: 'images', to: 'motion' },
          { field: 'musicModel', from: null, to: 'elevenlabs_music' },
        ],
      },
      new Map([
        ['style-a', 'Documentary'],
        ['style-b', 'Noir'],
      ])
    );
    expect(lines).toEqual([
      { label: 'Style', from: 'Documentary', to: 'Noir' },
      { label: 'Image', from: 'Nano Banana 2', to: 'GPT Image 2.5' },
      { label: 'Stops', from: 'Images', to: 'Motion' },
      { label: 'Music', from: 'None', to: 'ElevenLabs Music' },
    ]);
  });

  it('says a missing style was removed and ignores a raw version id', () => {
    expect(
      historyChanges({
        changes: [{ field: 'styleId', from: 'gone', to: 'also-gone' }],
        versionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      })
    ).toEqual([{ label: 'Style', from: 'Removed style', to: 'Removed style' }]);
  });

  it('shows the previous text of an edit and skips ids', () => {
    expect(
      historyChanges({
        prevState: {
          physicalDescription: 'tall, brown hair',
          age: null,
          voiceOnly: false,
          selectedBibleVersionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          prompt: 'a'.repeat(120),
        },
      })
    ).toEqual([
      { label: 'Age', from: 'empty', to: null },
      { label: 'Description', from: 'tall, brown hair', to: null },
      { label: 'Voice only', from: 'No', to: null },
      { label: 'Prompt', from: `${'a'.repeat(95)}…`, to: null },
    ]);
  });

  it('names the model in a stored sentence', () => {
    expect(
      displaySummary('Selected minimax_h3_max video', {
        model: 'minimax_h3_max',
        versionId: 'clip',
      })
    ).toBe('Selected MiniMax H3 Max video');
    expect(displaySummary('Finished the storyboard', null)).toBe(
      'Finished the storyboard'
    );
  });

  it('reads the file ids off a generation event', () => {
    expect(
      mediaVersionIds({
        versionId: 'new',
        prevVersionId: 'old',
        model: 'minimax_h3_max',
      })
    ).toEqual({ versionId: 'new', prevVersionId: 'old' });
    expect(mediaVersionIds({ workflow: 'StoryboardWorkflow' })).toEqual({
      versionId: null,
      prevVersionId: null,
    });
  });

  it('leaves a generation line with no stored diff alone', () => {
    expect(historyChanges({ workflow: 'StoryboardWorkflow' })).toEqual([]);
    expect(historyChanges(null)).toEqual([]);
  });
});
