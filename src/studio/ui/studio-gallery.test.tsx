import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GeneratedAsset } from '@/platform/server/db/schema';
import { Dialog } from '@/ui/shadcn/dialog';
import { TooltipProvider } from '@/ui/shadcn/tooltip';
import { GenerationDetail } from './studio-gallery';

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
    expect(html).toContain('Copy');
    expect(html).toContain('Share link');
    expect(html).toContain('Download');
    expect(html).toContain('aspect-video');
  });
});
