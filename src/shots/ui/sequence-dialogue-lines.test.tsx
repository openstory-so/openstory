import { sequenceCharacterKeys } from '@/cast/ui/use-sequence-characters';
import type { MotionAudioClip } from '@/platform/server/db/schema';
import type { MotionDialogue } from '@/shots/scene-analysis.schema';
import { TooltipProvider } from '@/ui/shadcn/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SequenceDialogueLines } from './sequence-dialogue-lines';

type ListedShot = {
  id: string;
  sceneId: string | null;
  deletedAt: Date | null;
  dialogue: MotionDialogue | null;
  audioClips: MotionAudioClip[] | null;
};

function shot(
  partial: Pick<ListedShot, 'id'> & Partial<ListedShot>
): ListedShot {
  return {
    sceneId: 'scene-1',
    deletedAt: null,
    dialogue: { presence: false, lines: [] },
    audioClips: null,
    ...partial,
  };
}

const kitchen = { id: 'scene-1', title: 'Kitchen' };

function render(shots: ListedShot[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(sequenceCharacterKeys.list('seq-1'), []);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <SequenceDialogueLines
          sequenceId="seq-1"
          shots={shots}
          sequenceShots={shots}
          scenes={[kitchen]}
          playingShotId={undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

const playButton = (html: string) =>
  html.match(/<button[^>]*aria-label="Play dialogue for Kitchen"[^>]*>/)?.[0];

/** A disabled attribute, not the `disabled:` utility in the class string. */
const buttonDisabled = (tag: string | undefined) =>
  /[\s"]disabled(?:=|[\s>])/.test(tag ?? '');

describe('SequenceDialogueLines', () => {
  it('lists a silent scene with Add line and no upload', () => {
    const html = render([shot({ id: 'shot-1' })]);

    expect(html).toContain('Kitchen');
    expect(html).toContain('No lines');
    expect(html).toContain('Add line');
    expect(html).not.toContain('Upload a recording of Kitchen');
    expect(html).not.toContain('Regenerate dialogue for Kitchen');
    expect(buttonDisabled(playButton(html))).toBe(true);
  });

  it('offers upload once the scene has a line, including on its silent shots', () => {
    const html = render([
      shot({
        id: 'shot-1',
        dialogue: {
          presence: true,
          lines: [{ character: 'Ada', line: 'The kettle is on', tone: '' }],
        },
        audioClips: [
          {
            id: 'clip-1',
            url: 'https://example.com/ada.wav',
            token: 'DIALOGUE',
            durationSeconds: 2,
          },
        ],
      }),
      shot({ id: 'shot-2' }),
    ]);

    expect(html).toContain('The kettle is on');
    expect(html).toContain('No lines');
    expect(html).toContain('Upload a recording of Kitchen');
    expect(html).toContain('Regenerate dialogue for Kitchen');
    expect(html.match(/Add line/g)).toHaveLength(2);
    expect(buttonDisabled(playButton(html))).toBe(false);
  });
});
