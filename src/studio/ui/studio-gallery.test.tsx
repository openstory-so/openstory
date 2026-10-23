import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GeneratedAsset } from '@/platform/server/db/schema';
import { Dialog } from '@/ui/shadcn/dialog';
import { TooltipProvider } from '@/ui/shadcn/tooltip';
import {
  GenerationDetail,
  stepReferenceIndex,
  studioShownFailure,
} from './studio-gallery';

function asset(input: GeneratedAsset['input']): GeneratedAsset {
  return {
    id: '01STUDIOASSET000000000000',
    teamId: 'team',
    userId: 'user',
    provider: 'fal',
    endpointId: 'fal-ai/example',
    modelName: 'Seedance 2.5',
    source: 'studio',
    activity: 'video',
    isFavorite: false,
    status: 'completed',
    error: null,
    workflowRunId: 'wf',
    costMicros: 1,
    draftTaskId: null,
    outputs: [{ url: '/r2/clip.mp4', contentType: 'video/mp4' }],
    createdAt: new Date(),
    updatedAt: new Date(),
    input,
  };
}

describe('GenerationDetail', () => {
  it('shows the prompt as prose and the references that were used', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <Dialog open>
          <GenerationDetail
            asset={asset({
              prompt: 'the fox \\*turns\\*\\ntoward camera',
              aspectRatio: '16:9',
              resolution: '720p',
              duration: 5,
              mode: 'reference',
              referenceImages: ['/r2/fox.png'],
              referenceAudio: ['/r2/rain.mp3'],
            })}
            supportMode={false}
            copied={false}
            onCopy={() => undefined}
            onReuse={() => undefined}
            deletePending={false}
            onDelete={() => undefined}
          />
        </Dialog>
      </TooltipProvider>
    );

    expect(html).toContain('Seedance 2.5');
    expect(html).toContain('the fox *turns*');
    expect(html).toContain('toward camera');
    expect(html).not.toContain('\\*');
    expect(html).not.toContain('\\n');
    expect(html).toContain('@Image1');
    expect(html).toContain('@Audio1');
    expect(html).toContain('/r2/fox.png');
    expect(html).toContain('Reference to video');
    expect(html).toContain('Use again');
    expect(html).toContain('Copy prompt');
    expect(html).toContain('Share link');
    expect(html).toContain('Download');
    expect(html).toContain('Open @Image1');
    expect(html).not.toContain('Download @Image1');
    expect(html).not.toContain('Download @Audio1');
    expect(html).toContain('aspect-video');
  });

  it('keeps a stored failure that is not a Seedance sentence', () => {
    const stored = 'The image service refused this prompt.';
    expect(studioShownFailure(stored)).toBe(stored);
    expect(
      studioShownFailure(
        "Our video provider is busy right now. You weren't charged. Try again in a few minutes."
      )
    ).toMatch(/busy right now/);
    expect(studioShownFailure(null)).toBe('Generation failed');
    expect(studioShownFailure('   ')).toBe('Generation failed');

    const html = renderToStaticMarkup(
      <TooltipProvider>
        <Dialog open>
          <GenerationDetail
            asset={{
              ...asset({ prompt: 'a fox' }),
              status: 'failed',
              error: stored,
              outputs: [],
            }}
            supportMode={false}
            copied={false}
            onCopy={() => undefined}
            deletePending={false}
            onDelete={() => undefined}
          />
        </Dialog>
      </TooltipProvider>
    );
    expect(html).toContain(stored);
    expect(html).not.toContain('Generation failed');
  });

  it('steps reference stills and wraps at the ends', () => {
    expect(stepReferenceIndex(0, -1, 4)).toBe(3);
    expect(stepReferenceIndex(3, 1, 4)).toBe(0);
    expect(stepReferenceIndex(1, 1, 4)).toBe(2);
  });
});
