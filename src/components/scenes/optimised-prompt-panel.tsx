/**
 * Collapsed-by-default preview of the assembled prompt the selected model
 * will actually receive (#1242). The inspector used to accordion every
 * catalog model; most of that JSON was for models the user had not picked.
 */

import { AppImage } from '@/components/ui/app-image';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { copyImageToClipboard } from '@/lib/utils/clipboard';
import { ChevronRight, CopyIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

export type BoundPromptImage = {
  label: string;
  url: string;
};

export type OptimisedPromptPreview = {
  modelName: string;
  endpointId: string;
  /** Assembled prompt text the model reads (after refs / audio sections). */
  prompt: string;
  /** Pretty-printed fal request body, or null when only the text exists. */
  json: string | null;
  promptLength: number;
  maxPromptLength: number;
  /** Bound stills in prompt order (`@Image1`, `@Image2`, …). */
  images?: BoundPromptImage[];
};

export function boundPromptImages(
  urls: readonly string[],
  tag: (position: number) => string
): BoundPromptImage[] {
  return urls
    .filter((url) => url.length > 0)
    .map((url, index) => ({ label: tag(index + 1), url }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Pull ordered still URLs off a fal motion/image request body. */
export function imageUrlsFromFalInput(input: unknown): string[] {
  if (!isRecord(input)) return [];
  const urls: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0) urls.push(value);
  };
  if (Array.isArray(input.image_urls)) {
    for (const url of input.image_urls) push(url);
  } else if (Array.isArray(input.reference_image_urls)) {
    for (const url of input.reference_image_urls) push(url);
  } else {
    push(input.image_url);
    push(input.start_image_url);
  }
  if (Array.isArray(input.elements)) {
    for (const element of input.elements) {
      if (isRecord(element)) push(element.frontal_image_url);
    }
  }
  return urls;
}

/** Image parts from an Ark / Grok multimodal prompt array. */
export function imageUrlsFromPromptParts(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  const urls: string[] = [];
  for (const part of parts) {
    if (!isRecord(part) || part.type !== 'image' || !isRecord(part.source)) {
      continue;
    }
    if (typeof part.source.value === 'string' && part.source.value.length > 0) {
      urls.push(part.source.value);
    }
  }
  return urls;
}

type PreviewView = 'prompt' | 'json';

/**
 * Pull `input.prompt` off a fal request body. Shared by the image and motion
 * builders so the panel shows the same string the endpoint receives.
 */
export function promptFromFalInput(input: unknown, fallback: string): string {
  if (
    input !== null &&
    typeof input === 'object' &&
    'prompt' in input &&
    typeof input.prompt === 'string'
  ) {
    return input.prompt;
  }
  return fallback;
}

export const OptimisedPromptPanel: React.FC<{
  preview: OptimisedPromptPreview;
  copiedKey: string | null;
  onCopy: (text: string | undefined, key: string) => void;
  footnote?: string | null;
  idPrefix: string;
  defaultOpen?: boolean;
}> = ({ preview, copiedKey, onCopy, footnote, idPrefix, defaultOpen }) => {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [view, setView] = useState<PreviewView>('prompt');
  const overLimit = preview.promptLength > preview.maxPromptLength;
  const headingId = `${idPrefix}-heading`;
  const previewId = `${idPrefix}-preview`;
  const copyKey = `${idPrefix}-${view}`;
  const showingJson = view === 'json' && preview.json !== null;
  const copyText = showingJson ? preview.json : preview.prompt;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-md border"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ChevronRight
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
              open && 'rotate-90'
            )}
            aria-hidden
          />
          <span className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
            <span id={headingId} className="font-medium">
              Optimised prompt
            </span>
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-xs font-normal text-muted-foreground">
                {preview.modelName}
              </span>
              <span
                className={cn(
                  'shrink-0 text-xs font-normal tabular-nums',
                  overLimit
                    ? 'font-medium text-destructive'
                    : 'text-muted-foreground'
                )}
              >
                {preview.promptLength}&nbsp;/&nbsp;{preview.maxPromptLength}
              </span>
            </span>
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 border-t px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            {preview.json !== null ? (
              <ToggleGroup
                type="single"
                value={view}
                onValueChange={(next) => {
                  if (next === 'prompt' || next === 'json') setView(next);
                }}
                variant="outline"
                size="sm"
                spacing={0}
                aria-label="Optimised prompt view"
              >
                <ToggleGroupItem value="prompt">Prompt</ToggleGroupItem>
                <ToggleGroupItem value="json">JSON</ToggleGroupItem>
              </ToggleGroup>
            ) : (
              <span className="font-mono text-xs text-muted-foreground">
                {preview.endpointId}
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => onCopy(copyText ?? undefined, copyKey)}
              disabled={!copyText}
              aria-label={
                showingJson
                  ? `Copy ${preview.modelName} request JSON`
                  : `Copy ${preview.modelName} optimised prompt`
              }
            >
              {copiedKey === copyKey ? (
                <span aria-hidden className="text-xs">
                  ✓
                </span>
              ) : (
                <CopyIcon className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
          {preview.json !== null && (
            <span className="font-mono text-xs text-muted-foreground">
              {preview.endpointId}
            </span>
          )}
          {preview.images && preview.images.length > 0 && (
            <BoundImageStrip images={preview.images} />
          )}
          {showingJson ? (
            <pre
              id={previewId}
              aria-labelledby={headingId}
              className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed text-foreground"
            >
              {preview.json}
            </pre>
          ) : (
            <p
              id={previewId}
              aria-labelledby={headingId}
              className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-sm leading-relaxed text-foreground"
            >
              {preview.prompt}
            </p>
          )}
          {footnote && (
            <p className="text-xs text-muted-foreground">{footnote}</p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

const BoundImageStrip: React.FC<{
  images: BoundPromptImage[];
}> = ({ images }) => {
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);

  const handleCopyImage = async (image: BoundPromptImage) => {
    if (!(await copyImageToClipboard(image.url))) {
      toast.error('Failed to copy image', {
        description:
          'Your browser blocked clipboard access, or the image could not be fetched.',
      });
      return;
    }
    setCopiedLabel(image.label);
    window.setTimeout(() => setCopiedLabel(null), 2000);
  };

  return (
    <ul
      className="flex gap-2 overflow-x-auto"
      aria-label="Bound reference images"
    >
      {images.map((image) => {
        const copied = copiedLabel === image.label;
        return (
          <li key={`${image.label}-${image.url}`} className="shrink-0">
            <figure className="flex flex-col items-center gap-1">
              <div className="relative size-16 overflow-hidden rounded-sm border bg-muted">
                <AppImage
                  src={image.url}
                  alt=""
                  width={64}
                  height={64}
                  className="size-16 object-cover"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute top-0.5 right-0.5 h-6 w-6 bg-background/80"
                  onClick={() => void handleCopyImage(image)}
                  aria-label={
                    copied
                      ? `Copied ${image.label}`
                      : `Copy ${image.label} image`
                  }
                >
                  {copied ? (
                    <span aria-hidden className="text-xs">
                      ✓
                    </span>
                  ) : (
                    <CopyIcon className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
              <figcaption className="font-mono text-xs text-muted-foreground">
                {image.label}
              </figcaption>
            </figure>
          </li>
        );
      })}
    </ul>
  );
};
