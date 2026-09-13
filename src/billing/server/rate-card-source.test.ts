import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  descriptionSizeTable,
  fetchRateCardSource,
  llmsTxtInputSchemaSection,
  sha256Hex,
} from './rate-card-source';

const LLMS = (pricing: string) =>
  `# Model\n\n## Overview\n\nText.\n\n## Pricing\n\n${pricing}\n\n## API Information\n\nIntro.\n\n### Input Schema\n\n- **\`duration\`** (\`DurationEnum\`, _optional_): Default value: \`"5"\`\n\n### Output Schema\n\n- **\`video\`** (\`File\`)\n\n## Usage Examples\n\nnone\n`;

// The playground page embeds the description as a JSON string: rows joined
// by a literal backslash-n.
const ESCAPED_TABLE =
  'standpoint.\\\\n| Size | low | high |\\\\n|---|---:|---:|' +
  '\\\\n| 1024×1024 | $0.00588 | $0.05268 |\\\\n\\\\n**This implies**';

function stubFetch(handler: (url: string) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL) => Promise.resolve(handler(String(input))))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('llmsTxtInputSchemaSection', () => {
  it('stops at the next heading of the same or a higher level', () => {
    expect(llmsTxtInputSchemaSection(LLMS('$0.08 per image'))).toBe(
      '- **`duration`** (`DurationEnum`, _optional_): Default value: `"5"`'
    );
    expect(llmsTxtInputSchemaSection('# Model\n\n## Overview\n')).toBeNull();
  });
});

describe('descriptionSizeTable', () => {
  it('reads the escaped playground table as plain markdown', () => {
    expect(descriptionSizeTable(`<html>${ESCAPED_TABLE}</html>`)).toBe(
      '| Size | low | high |\n|---|---:|---:|\n| 1024×1024 | $0.00588 | $0.05268 |'
    );
    expect(descriptionSizeTable('<html>no table</html>')).toBeNull();
  });
});

describe('fetchRateCardSource', () => {
  it('returns the priced text and a hash over pricing + table only', async () => {
    stubFetch((url) =>
      url.endsWith('/llms.txt')
        ? new Response(
            LLMS(
              'Image tokens (per 1M): **$30.00** output. See the description at the bottom of this page.'
            )
          )
        : new Response(`<html>${ESCAPED_TABLE}</html>`)
    );
    const result = await fetchRateCardSource('openai/gpt-image-2.5/x');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.source.url).toBe(
      'https://fal.ai/models/openai/gpt-image-2.5/x/llms.txt'
    );
    expect(result.source.descriptionTable).toContain('| 1024×1024 |');
    expect(result.source.inputSchemaSection).toContain('`duration`');
    // The Input Schema is not part of the hash: a schema edit alone must not
    // force a re-extraction.
    expect(result.source.hash).toBe(await sha256Hex(result.source.text));
    expect(result.source.text).not.toContain('Input Schema');
  });

  it('does not fetch the playground page when the text does not point at it', async () => {
    const fetchMock = vi.fn((input: string | URL) =>
      Promise.resolve(
        String(input).endsWith('/llms.txt')
          ? new Response(LLMS('Your request will cost **$0.08** per image.'))
          : new Response('', { status: 500 })
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchRateCardSource('fal-ai/nano-banana-2');
    expect(result.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a page without a Pricing section is an absence; a 404 is a failure', async () => {
    stubFetch((url) =>
      url.includes('gone')
        ? new Response('', { status: 404 })
        : new Response('# Model\n\n## Overview\n\nno pricing\n')
    );
    expect(await fetchRateCardSource('fal-ai/gone')).toEqual({
      status: 'failed',
    });
    expect(await fetchRateCardSource('fal-ai/free')).toEqual({
      status: 'no-pricing',
    });
  });
});
