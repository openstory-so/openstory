import {
  boundPromptImages,
  imageUrlsFromFalInput,
  imageUrlsFromPromptParts,
  OptimisedPromptPanel,
  promptFromFalInput,
  type OptimisedPromptPreview,
} from '@/components/scenes/optimised-prompt-panel';
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

describe('promptFromFalInput', () => {
  it('reads the prompt string off a fal request body', () => {
    expect(
      promptFromFalInput(
        { prompt: 'bound (Image 1) sheet', seed: 1 },
        'fallback'
      )
    ).toBe('bound (Image 1) sheet');
  });

  it('falls back when the body has no prompt string', () => {
    expect(promptFromFalInput({ image_urls: [] }, 'assembled')).toBe(
      'assembled'
    );
    expect(promptFromFalInput(null, 'assembled')).toBe('assembled');
  });
});

describe('boundPromptImages', () => {
  it('tags non-empty URLs in order', () => {
    expect(
      boundPromptImages(
        ['https://cdn.example/a.png', '', 'https://cdn.example/b.png'],
        (position) => `@Image${position}`
      )
    ).toEqual([
      { label: '@Image1', url: 'https://cdn.example/a.png' },
      { label: '@Image2', url: 'https://cdn.example/b.png' },
    ]);
  });
});

describe('imageUrlsFromFalInput', () => {
  it('reads image_urls ahead of image_url', () => {
    expect(
      imageUrlsFromFalInput({
        image_url: 'https://cdn.example/ignored.png',
        image_urls: [
          'https://cdn.example/still.png',
          'https://cdn.example/cast.png',
        ],
      })
    ).toEqual([
      'https://cdn.example/still.png',
      'https://cdn.example/cast.png',
    ]);
  });

  it('reads reference_image_urls when image_urls is absent', () => {
    expect(
      imageUrlsFromFalInput({
        reference_image_urls: [
          'https://cdn.example/still.png',
          'https://cdn.example/cast.png',
        ],
      })
    ).toEqual([
      'https://cdn.example/still.png',
      'https://cdn.example/cast.png',
    ]);
  });

  it('falls back to image_url plus Kling elements', () => {
    expect(
      imageUrlsFromFalInput({
        image_url: 'https://cdn.example/still.png',
        elements: [{ frontal_image_url: 'https://cdn.example/cast.png' }],
      })
    ).toEqual([
      'https://cdn.example/still.png',
      'https://cdn.example/cast.png',
    ]);
  });
});

describe('imageUrlsFromPromptParts', () => {
  it('keeps image parts in request order', () => {
    expect(
      imageUrlsFromPromptParts([
        { type: 'text', content: 'go' },
        { type: 'image', source: { type: 'url', value: 'https://a.png' } },
        { type: 'image', source: { type: 'url', value: 'https://b.png' } },
      ])
    ).toEqual(['https://a.png', 'https://b.png']);
  });
});

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
});
