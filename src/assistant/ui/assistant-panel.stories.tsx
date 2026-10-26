/**
 * The assistant panel in every state (#2155): empty, streaming, a tool
 * running, a tool error, confirm-before-spend, an upload in progress, and
 * a long thread. Each story plays a scripted run over the same AG-UI
 * events the server streams, so what shows here is what the server sends.
 */

import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AuthGateStub } from '@/platform/ui/auth/auth-gate-provider';
import { UploadRightsGateStub } from '@/cast/ui/upload-rights-gate';
import { generateId } from '@/platform/id';
import { TooltipProvider } from '@/ui/shadcn/tooltip';
import type { PageContextItem } from '../page-context';
import { AssistantPanel } from './assistant-panel';
import { openAssistant, switchAssistantThread } from './assistant-store';
import {
  scriptedConnection,
  type ScriptedConnectionOptions,
} from './scripted-connection';

const SHOT_CONTEXT: PageContextItem[] = [
  { kind: 'sequence', id: '01J0SEQ', label: 'The Last Ferry' },
  { kind: 'scene', id: '01J0SCENE', label: 'Harbour at dawn' },
  { kind: 'shot', id: '01J0SHOT', label: 'Shot 3' },
];

const SUGGESTIONS = [
  'What is still missing before this scene can render?',
  'Make this shot darker and more handheld',
  'Draft a second look for Mara in rain gear',
];

const SHOT = {
  shotId: '01J0SHOT',
  shotNumber: 3,
  imagePrompt:
    'Mara on the harbour wall at dawn, wide shot, mist over the water',
  motionPrompt: 'Slow push in; gulls cross the frame',
  status: { image: 'ready', video: 'stale' },
};

function Harness({
  script,
  pageContext = SHOT_CONTEXT,
  prompt,
  send,
}: {
  script: ScriptedConnectionOptions;
  pageContext?: PageContextItem[];
  prompt?: string;
  /** Sent on mount so the story shows the reply, not an empty box. */
  send?: string;
}) {
  const queryClient = new QueryClient();
  useEffect(() => {
    switchAssistantThread(generateId());
    openAssistant(prompt ? { prompt } : undefined);
  }, [prompt]);
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGateStub>
        <UploadRightsGateStub>
          <TooltipProvider>
            <div className="flex h-[640px] w-[420px] overflow-hidden rounded-lg border bg-background">
              <div className="flex-1">
                <AssistantPanel
                  inline
                  pageContext={pageContext}
                  suggestions={SUGGESTIONS}
                  connection={scriptedConnection(script)}
                  uploadStub={async (file) => {
                    await new Promise((r) => setTimeout(r, 1500));
                    return `/r2/uploads/${file.name}`;
                  }}
                />
              </div>
            </div>
            {send && <AutoSend text={send} />}
          </TooltipProvider>
        </UploadRightsGateStub>
      </AuthGateStub>
    </QueryClientProvider>
  );
}

/** Types the text and presses Enter once the composer is on screen. */
function AutoSend({ text }: { text: string }) {
  useEffect(() => {
    const id = window.setTimeout(() => {
      const box = document.querySelector<HTMLTextAreaElement>(
        'textarea[name="message"]'
      );
      if (!box) return;
      // Through the prototype setter so React's value tracker sees the change.
      Reflect.set(HTMLTextAreaElement.prototype, 'value', text, box);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.form?.requestSubmit();
    }, 50);
    return () => window.clearTimeout(id);
  }, [text]);
  return null;
}

const meta: Meta<typeof Harness> = {
  title: 'Assistant/Panel',
  component: Harness,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof Harness>;

export const Empty: Story = {
  args: { script: { steps: [] } },
};

export const NoPageContext: Story = {
  args: { script: { steps: [] }, pageContext: [] },
};

export const AskAboutThis: Story = {
  args: {
    script: { steps: [] },
    prompt: 'Why is the clip for this shot stale?',
  },
};

export const Streaming: Story = {
  args: {
    send: 'What does this shot look like?',
    script: {
      charsPerSecond: 40,
      steps: [
        {
          text: 'Shot 3 opens wide on the harbour wall at dawn: Mara stands with her back to us, mist over the water, a slow push in while gulls cross the frame. The still is ready; the clip is stale because the motion prompt changed after it rendered.',
        },
      ],
    },
  },
};

export const ToolRunning: Story = {
  args: {
    send: 'What is the current prompt for this shot?',
    script: {
      steps: [
        {
          toolCalls: [
            {
              name: 'openstory_get_shot',
              input: { shotId: '01J0SHOT' },
              result: SHOT,
              delayMs: 4000,
            },
          ],
        },
        {
          text: 'The visual prompt is "Mara on the harbour wall at dawn, wide shot, mist over the water". The clip is stale, the still is ready.',
        },
      ],
    },
  },
};

export const ToolError: Story = {
  args: {
    send: 'Set the music to the track I uploaded yesterday',
    script: {
      steps: [
        {
          toolCalls: [
            {
              name: 'openstory_set_music_from_upload',
              input: {
                sequenceId: '01J0SEQ',
                upload: '/r2/uploads/yesterday.mp3',
              },
              error: 'upload must be the value upload_media returned.',
            },
          ],
        },
        {
          text: 'That upload is gone from storage, so I could not set it. Attach the track again and I will set it as the music.',
        },
      ],
    },
  },
};

export const ConfirmBeforeDelete: Story = {
  args: {
    send: 'Delete this shot',
    script: {
      steps: [
        {
          toolCalls: [
            {
              name: 'openstory_get_shot',
              input: { sequenceId: '01J0SEQ', shotId: '01J0SHOT' },
              result: { id: '01J0SHOT', number: 3, hasStill: true },
            },
          ],
        },
        {
          text: 'Shot 3 and its still go. Allow it and I will delete them.',
          toolCalls: [
            {
              name: 'openstory_delete_shot',
              input: { sequenceId: '01J0SEQ', shotId: '01J0SHOT' },
              needsApproval: true,
              result: { deleted: true },
            },
          ],
        },
        { text: 'Deleted. The scene now has two shots.' },
      ],
    },
  },
};

export const LongConversation: Story = {
  args: {
    send: 'Give me a tour of this sequence, one scene at a time.',
    script: {
      charsPerSecond: 4000,
      steps: Array.from({ length: 40 }, (_, i) => ({
        text: `Scene ${i + 1}: ${['Harbour at dawn', 'The ferry office', 'Mara’s kitchen', 'Open water'][i % 4]}. Two shots, both stills ready, one clip stale. ${'Nothing else is owed here. '.repeat((i % 3) + 1)}`,
        toolCalls:
          i < 39
            ? [
                {
                  name: 'openstory_get_scene',
                  input: { sceneId: `scene-${i + 2}` },
                  result: { shots: 2 },
                  delayMs: 100,
                },
              ]
            : undefined,
      })),
    },
  },
};

export const UploadInProgress: Story = {
  args: { script: { steps: [] } },
  render: (args) => (
    <>
      <Harness {...args} />
      <DropAFile />
    </>
  ),
};

/** Drops a generated image onto the composer so the chip shows uploading. */
function DropAFile() {
  useEffect(() => {
    const id = window.setTimeout(() => {
      const zone = document.querySelector('[aria-label="Message composer"]');
      if (!zone) return;
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 48;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#5b7c99';
        ctx.fillRect(0, 0, 64, 48);
      }
      canvas.toBlob((blob) => {
        if (!blob) return;
        const file = new File([blob], 'harbour-reference.png', {
          type: 'image/png',
        });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        zone.dispatchEvent(
          new DragEvent('drop', { bubbles: true, dataTransfer: transfer })
        );
      }, 'image/png');
    }, 300);
    return () => window.clearTimeout(id);
  }, []);
  return null;
}
