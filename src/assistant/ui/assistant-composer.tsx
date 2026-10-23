/**
 * The composer (#2155): context chips the user can remove, attachments
 * with their upload state, a textarea that sends on Enter (Shift+Enter for
 * a line), and Send or Stop. Files arrive by drop or paste and upload at
 * once; `+` opens the Studio reference picker, so anything the team already
 * has (a generation, an upload, a shot, a character, a location) attaches
 * without a second upload, and its Upload button takes a new file.
 */

import { Suspense, useRef, useState, type ClipboardEvent } from 'react';
import { ArrowUp, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useUploadRightsGate } from '@/cast/ui/upload-rights-gate';
import {
  StudioReferencePicker,
  useStudioLibrary,
  type StudioReference,
} from '@/studio/ui/studio-reference-picker';
import { useUploadStudioMedia } from '@/studio/ui/use-studio-assets';
import { generateId } from '@/platform/id';
import type { AnalysisModelId } from '@/models/models.config';
import { ModelSelector } from '@/models/ui/pickers/model-selector';
import { Button } from '@/ui/shadcn/button';
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

/** Only the picker needs the library; mounting it only while open keeps the
 * chat from fetching every generation on every page. */
const AttachmentPicker: React.FC<{
  attached: string[];
  onOpenChange: (open: boolean) => void;
  onPick: (references: StudioReference[]) => void;
  onUpload: (files: File[]) => void;
}> = ({ attached, onOpenChange, onPick, onUpload }) => {
  const library = useStudioLibrary();
  return (
    <StudioReferencePicker
      open
      onOpenChange={onOpenChange}
      title="Attach"
      library={library}
      attached={attached}
      multiple
      slots={{ image: Infinity, video: Infinity, audio: Infinity }}
      onPick={onPick}
      onUpload={onUpload}
      acceptAlso="text/*,application/pdf,.pdf,.fountain,.fdx,.md,.txt,.srt"
    />
  );
};

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
  const [pickerOpen, setPickerOpen] = useState(false);
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

  // A pick from the library is already stored and already past the likeness
  // gate, so the chip is ready at once; only an image's preview for the
  // model's eyes is still fetched.
  const addReferences = (references: StudioReference[]) => {
    for (const reference of references) {
      const id = generateId();
      setAttachments((list) => [
        ...list,
        {
          id,
          name: reference.label,
          kind: reference.kind,
          mimeType: `${reference.kind}/*`,
          status: 'ready',
          upload: reference.url,
        },
      ]);
      if (reference.kind === 'image') {
        void fetch(reference.url)
          .then((response) => response.blob())
          .then(imagePreview)
          .then(
            (preview) => patch(id, { preview }),
            () => patch(id, { note: 'no preview' })
          );
      }
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
        'flex flex-col border-t bg-background p-3',
        dragging && 'ring-2 ring-ring ring-inset'
      )}
    >
      {/* One bordered field: chips and attachments above the text, the
          actions in a quiet row under it. The field takes the focus ring,
          not the textarea, so the whole thing reads as the input. */}
      <form
        className="flex flex-col gap-1.5 rounded-xl border bg-card px-3 pt-2.5 pb-1.5 shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30"
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
          aria-description="Enter sends, Shift+Enter starts a new line"
          rows={1}
          className="max-h-48 min-h-9 resize-none border-0 bg-transparent px-0 py-1 text-base shadow-none focus-visible:ring-0 md:text-base dark:bg-transparent"
          autoComplete="off"
        />
        <div className="-mx-1.5 flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Attach from your library or upload"
            onClick={() => setPickerOpen(true)}
          >
            <Plus aria-hidden="true" />
          </Button>
          {pickerOpen && (
            <Suspense fallback={null}>
              <AttachmentPicker
                attached={attachments.flatMap((a) =>
                  a.upload ? [a.upload] : []
                )}
                onOpenChange={setPickerOpen}
                onPick={addReferences}
                onUpload={addFiles}
              />
            </Suspense>
          )}
          <div className="min-w-0 max-w-44">
            <ModelSelector
              singleSelect
              size="sm"
              variant="ghost"
              selectedModels={[model]}
              onModelsChange={(ids) => ids[0] && onModelChange(ids[0])}
            />
          </div>
          <span className="flex-1" />
          {busy ? (
            <Button type="button" variant="outline" size="sm" onClick={onStop}>
              Stop
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon-sm"
              className="rounded-full"
              aria-label="Send"
              disabled={!canSend}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
          )}
        </div>
      </form>
    </div>
  );
};
