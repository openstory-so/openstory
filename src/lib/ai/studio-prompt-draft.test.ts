import { describe, expect, it } from 'vitest';
import { buildDraftMessages } from './studio-prompt-draft';

describe('buildDraftMessages', () => {
  it('numbers tokens per kind and only sends stills as image parts', async () => {
    const { messages } = await buildDraftMessages({
      activity: 'video',
      references: [
        { url: 'https://cdn.example/a.png', label: 'Ava', kind: 'image' },
        { url: 'https://cdn.example/b.mp4', label: 'Pan', kind: 'video' },
        { url: 'https://cdn.example/c.png', label: 'Bar', kind: 'image' },
        { url: 'https://cdn.example/d.mp3', label: 'Rain', kind: 'audio' },
      ],
      currentPrompt: 'slow push in',
    });
    const content = messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) return;
    const text = content[0];
    expect(text?.type === 'text' ? text.content : '').toContain(
      'Image1: image — "Ava"\nVideo1: video — "Pan"\nImage2: image — "Bar"\nAudio1: audio — "Rain"'
    );
    expect(text?.type === 'text' ? text.content : '').toContain('slow push in');
    expect(content.filter((part) => part.type === 'image')).toHaveLength(2);
  });
});
