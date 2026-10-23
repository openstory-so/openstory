/**
 * The composer (#2155): context chips the user can remove, attachments
 * with their upload state, a textarea that sends on Enter (Shift+Enter for
 * a line), and Send or Stop. Files arrive by drop, paste or the Attach
 * button and upload at once.
 */

import { useRef, useState, type ClipboardEvent } from 'react';
import { toast } from 'sonner';
import { useUploadRightsGate } from '@/cast/ui/upload-rights-gate';
import { useUploadStudioMedia } from '@/studio/ui/use-studio-assets';
import { generateId } from '@/platform/id';
import type { AnalysisModelId } from '@/models/models.config';
import { ModelSelector } from '@/models/ui/pickers/model-selector';
import { Button } from '@/ui/shadcn/button';
import { Kbd } from '@/ui/shadcn/kbd';
import { Textarea } from '@/ui/shadcn/textarea';
import { cn } from '@/ui/utils';
import { PAGE_CONTEXT_NOUN, type PageContextItem } from '../page-context';
import {
  attachmentKind,
  imagePreview,
  messageContent,
  readText,
  type Attachment,
} from './attachments';

export type AssistantComposerProps = {
  context: PageContextItem[];
  onDismissContext: (item: PageContextItem) => void;
  /** Text a page handed over; placed, not sent. */
  initialPrompt?: string;
  busy: boolean;
  /** The model that answers; one pick for every thread. */
  model: AnalysisModelId;
  onModelChange: (model: AnalysisModelId) => void;
  onSend: (content: ReturnType<typeof messageContent>) => void;
  onStop: () => void;
  /** Stories: every upload resolves to this value, no network. */
  uploadStub?: (file: File) => Promise<string>;
};

const ContextChips: React.FC<{
  context: PageContextItem[];
  onDismiss: (item: PageContextItem) => void;
}> = ({ context, onDismiss }) => {
  if (context.length === 0) return null;
  return (
    <ul
      className="flex flex-wrap gap-1"
      aria-label="What the assistant can see"
    >
      {context.map((item) => (
        <li
          key={`${item.kind}:${item.id}`}
          className="flex h-6 items-center gap-1 rounded-full border bg-background pl-2 pr-0.5 text-xs"
        >
          <span className="text-muted-foreground">
            {PAGE_CONTEXT_NOUN[item.kind]}
          </span>
          <span className="max-w-40 truncate font-medium">{item.label}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-5 rounded-full"
            aria-label={`Remove ${PAGE_CONTEXT_NOUN[item.kind]} ${item.label} from the conversation`}
            onClick={() => onDismiss(item)}
          >
            <span aria-hidden>×</span>
          </Button>
        </li>
      ))}
    </ul>
  );
};

function attachmentStatus(attachment: Attachment): string {
  if (attachment.status === 'uploading') return 'Uploading…';
  if (attachment.status === 'error') return attachment.error ?? 'Failed';
  if (attachment.note) return attachment.note;
  return '';
}

const AttachmentChip: React.FC<{
  attachment: Attachment;
  onRemove: () => void;
}> = ({ attachment, onRemove }) => (
  <li
    className={cn(
      'flex h-8 items-center gap-2 rounded-md border bg-background pl-1 pr-0.5 text-xs',
      attachment.status === 'error' && 'border-destructive/40'
    )}
  >
    {attachment.preview ? (
      <img
        src={attachment.preview}
        alt=""
        width={24}
        height={24}
        className="size-6 rounded object-cover"
      />
    ) : (
      <span className="w-6 text-center text-muted-foreground">
        {attachment.kind === 'video'
          ? 'clip'
          : attachment.kind === 'audio'
            ? 'audio'
            : 'text'}
      </span>
    )}
    <span className="max-w-32 truncate">{attachment.name}</span>
    <span className="text-muted-foreground">
      {attachmentStatus(attachment)}
    </span>
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={`Remove ${attachment.name}`}
      onClick={onRemove}
    >
      <span aria-hidden>×</span>
    </Button>
  </li>
);

export const AssistantComposer: React.FC<AssistantComposerProps> = ({
  context,
  onDismissContext,
  initialPrompt,
  busy,
  model,
  onModelChange,
  onSend,
  onStop,
  uploadStub,
}) => {
  const [text, setText] = useState(initialPrompt ?? '');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const upload = useUploadStudioMedia();
  const { ensureUploadRights } = useUploadRightsGate();

  const patch = (id: string, change: Partial<Attachment>) =>
    setAttachments((list) =>
      list.map((a) => (a.id === id ? { ...a, ...change } : a))
    );

  const addFiles = (files: Iterable<File>) => {
    for (const file of files) {
      const kind = attachmentKind(file);
      if (!kind) {
        toast.error(`${file.name}: not an image, video, audio or text file`);
        continue;
      }
      const id = generateId();
      setAttachments((list) => [
        ...list,
        {
          id,
          name: file.name,
          kind,
          mimeType: file.type || 'text/plain',
          status: 'uploading',
        },
      ]);
      void (async () => {
        try {
          if (kind === 'text') {
            patch(id, { status: 'ready', text: await readText(file) });
            return;
          }
          // The preview is for the model's eyes and the chip; a format the
          // browser cannot decode (HEIC, a huge PNG) still uploads, and the
          // chip says the model will not see it.
          if (kind === 'image') {
            try {
              patch(id, { preview: await imagePreview(file) });
            } catch {
              patch(id, { note: 'no preview' });
            }
          }
          const stored = uploadStub
            ? { url: await uploadStub(file) }
            : await upload.mutateAsync({ file });
          if (kind !== 'audio' && !uploadStub) {
            await ensureUploadRights([
              { url: stored.url, filename: file.name },
            ]);
          }
          patch(id, { status: 'ready', upload: stored.url });
        } catch (error) {
          patch(id, {
            status: 'error',
            error: error instanceof Error ? error.message : 'Upload failed',
          });
        }
      })();
    }
  };

  // A failed chip blocks sending: the user removes it on purpose, so a
  // message never goes out with a file silently missing.
  const canSend =
    !busy &&
    (text.trim().length > 0 || attachments.some((a) => a.status === 'ready')) &&
    attachments.every((a) => a.status === 'ready');

  const send = () => {
    if (!canSend) return;
    onSend(messageContent(text, attachments));
    setText('');
    setAttachments([]);
    textareaRef.current?.focus();
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };

  return (
    <div
      className={cn(
        'flex flex-col border-t bg-background',
        dragging && 'ring-2 ring-ring ring-inset'
      )}
    >
      <form
        className="flex flex-col gap-2 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <ContextChips context={context} onDismiss={onDismissContext} />
        {attachments.length > 0 && (
          <ul className="flex flex-wrap gap-1" aria-label="Attachments">
            {attachments.map((attachment) => (
              <AttachmentChip
                key={attachment.id}
                attachment={attachment}
                onRemove={() =>
                  setAttachments((list) =>
                    list.filter((a) => a.id !== attachment.id)
                  )
                }
              />
            ))}
          </ul>
        )}
        <Textarea
          ref={textareaRef}
          name="message"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onPaste={onPaste}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            addFiles(event.dataTransfer.files);
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              send();
            }
          }}
          placeholder={
            context.length > 0 ? 'Ask about this…' : 'Ask about your work…'
          }
          aria-label="Message the assistant"
          rows={1}
          className="max-h-48 min-h-10 resize-none text-base md:text-base"
          autoComplete="off"
        />
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,video/*,audio/*,text/*,.fountain,.fdx,.md,.txt,.srt"
            className="sr-only"
            onChange={(event) => {
              if (event.target.files) addFiles(event.target.files);
              event.target.value = '';
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
          >
            Attach
          </Button>
          <div className="w-44">
            <ModelSelector
              singleSelect
              selectedModels={[model]}
              onModelsChange={(ids) => ids[0] && onModelChange(ids[0])}
            />
          </div>
          <span className="hidden flex-1 text-xs text-muted-foreground lg:block">
            <Kbd>Enter</Kbd> sends, <Kbd>Shift+Enter</Kbd> new line
          </span>
          <span className="flex-1 lg:hidden" />
          {busy ? (
            <Button type="button" variant="outline" size="sm" onClick={onStop}>
              Stop
            </Button>
          ) : (
            <Button type="submit" size="sm" disabled={!canSend}>
              Send
            </Button>
          )}
        </div>
      </form>
    </div>
  );
};
