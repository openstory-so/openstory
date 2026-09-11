import { OptimisedPromptPanel } from './optimised-prompt-panel';
import type { OptimisedPromptPreview } from '@/shots/server/optimised-prompt-preview';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

const selected: OptimisedPromptPreview = {
  modelName: 'GPT Image 2',
  endpointId: 'openai/gpt-image-2',
  prompt: 'Sarah types at a sunlit coffee shop',
  json: JSON.stringify(
    { prompt: 'SECRET_JSON_MARKER', image_size: 'landscape_16_9' },
    null,
    2
  ),
  promptLength: 36,
  maxPromptLength: 32000,
};

function renderPanel(
  preview: OptimisedPromptPreview,
  options?: { defaultOpen?: boolean }
) {
  return renderToStaticMarkup(
    <OptimisedPromptPanel
      preview={preview}
      copiedKey={null}
      onCopy={() => undefined}
      idPrefix="image-request"
      defaultOpen={options?.defaultOpen}
    />
  );
}

describe('OptimisedPromptPanel', () => {
  it('SSRs a collapsed header for the selected model only', () => {
    const html = renderPanel(selected);

    expect(html).toContain('Optimised prompt');
    expect(html).toContain('GPT Image 2');
    expect(html).toContain('36');
    expect(html).toContain('32000');
    expect(html).toContain('aria-expanded="false"');
    // Other catalog models must not leak in — the panel is given one preview.
    expect(html).not.toContain('Nano Banana');
    expect(html).not.toContain('FLUX.2 Max');
    expect(html).not.toContain('Seedance');
  });

  it('does not SSR the request JSON while collapsed on the prompt view', () => {
    const html = renderPanel(selected);
    expect(html).not.toContain('SECRET_JSON_MARKER');
  });

  it('flags an over-limit count on the collapsed header', () => {
    const html = renderPanel({
      ...selected,
      promptLength: 2501,
      maxPromptLength: 2500,
    });
    expect(html).toContain('text-destructive');
    expect(html).toContain('2501');
    expect(html).toContain('2500');
  });

  it('leaves the closed collapsible body empty so the inspector stays short', () => {
    const html = renderPanel(selected);
    expect(html).toContain('data-slot="collapsible-content"');
    expect(html).toContain('hidden');
    expect(html).not.toContain('Sarah types at a sunlit coffee shop');
    expect(html).not.toContain('Prompt');
    expect(html).not.toContain('JSON');
  });

  it('hides bound-image thumbnails while collapsed', () => {
    const html = renderPanel({
      ...selected,
      modelName: 'Seedance 2.5',
      images: [
        { label: '@Image1', url: 'https://cdn.example/still.png' },
        { label: '@Image2', url: 'https://cdn.example/cast.png' },
      ],
    });
    expect(html).not.toContain('Copy @Image1 image');
    expect(html).not.toContain('https://cdn.example/still.png');
  });

  it('renders copyable bound-image thumbnails when expanded', () => {
    const html = renderPanel(
      {
        ...selected,
        modelName: 'Seedance 2.5',
        images: [
          { label: '@Image1', url: 'https://cdn.example/still.png' },
          { label: '@Image2', url: 'https://cdn.example/cast.png' },
        ],
      },
      { defaultOpen: true }
    );
    expect(html).toContain('Copy @Image1 image');
    expect(html).toContain('Copy @Image2 image');
    expect(html).toContain('https://cdn.example/still.png');
    expect(html).toContain('https://cdn.example/cast.png');
  });

  it('lists images, clips and audio in one wrapping row; only images copy', () => {
    const html = renderPanel(
      {
        ...selected,
        modelName: 'Seedance 2.5',
        images: [{ label: '@Image1', url: 'https://cdn.example/still.png' }],
        videos: [{ label: '@Video1', url: 'https://cdn.example/clip.mp4' }],
        audio: [{ label: '@Audio1', url: 'https://cdn.example/line.wav' }],
      },
      { defaultOpen: true }
    );
    expect(html.match(/<ul/g)).toHaveLength(1);
    expect(html).toContain('flex-wrap');
    expect(html).toContain('Copy @Image1 image');
    expect(html).toContain('Play @Video1');
    expect(html).toContain('Play @Audio1');
    expect(html).not.toContain('Copy @Video1');
    expect(html).not.toContain('Copy @Audio1');
  });
});
