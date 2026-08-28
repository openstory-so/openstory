import {
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

function renderPanel(preview: OptimisedPromptPreview) {
  return renderToStaticMarkup(
    <OptimisedPromptPanel
      preview={preview}
      copiedKey={null}
      onCopy={() => undefined}
      idPrefix="image-request"
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
});
