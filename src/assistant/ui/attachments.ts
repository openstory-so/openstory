/**
 * Composer attachments (#2155). A dropped or pasted file is uploaded at
 * once through the editor's own upload path (presign → PUT, then the
 * likeness gate for an image), so by the time the message goes the model
 * is told the stored `upload` value every set_*_from_upload and Studio tool
 * takes. An image also rides along as a small preview the model can see; a
 * script or text file is inlined as text.
 */

import type { ContentPart } from '@tanstack/ai';

export type AttachmentKind = 'image' | 'video' | 'audio' | 'text';

export type Attachment = {
  id: string;
  name: string;
  kind: AttachmentKind;
  mimeType: string;
  status: 'uploading' | 'ready' | 'error';
  /** The stored `/r2/…` value the tools take. */
  upload?: string;
  /** A downscaled JPEG for the model to look at and the chip to show. */
  preview?: string;
  /** Why the model will not see it: "no preview". */
  note?: string;
  /** A script or notes file, read whole. */
  text?: string;
  error?: string;
};

const TEXT_EXTENSIONS = /\.(txt|md|fountain|fdx|srt|vtt|csv|json)$/i;
/** The model sees a preview this wide; the upload keeps the full file. */
const PREVIEW_MAX_EDGE = 1024;
const PREVIEW_QUALITY = 0.8;
const TEXT_MAX_CHARS = 100_000;

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

export function attachmentKind(file: File): AttachmentKind | null {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (
    file.type.startsWith('text/') ||
    TEXT_EXTENSIONS.test(file.name) ||
    isPdf(file)
  ) {
    return 'text';
  }
  return null;
}

/** A PDF is its text: pages joined, read in the browser, nothing stored. */
async function readPdf(file: File): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

/** A JPEG data URL no wider than `PREVIEW_MAX_EDGE`. */
export async function imagePreview(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(
    1,
    PREVIEW_MAX_EDGE / Math.max(bitmap.width, bitmap.height)
  );
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D canvas');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', PREVIEW_QUALITY);
}

export async function readText(file: File): Promise<string> {
  const text = isPdf(file) ? await readPdf(file) : await file.text();
  return text.length > TEXT_MAX_CHARS
    ? `${text.slice(0, TEXT_MAX_CHARS)}\n[cut at ${TEXT_MAX_CHARS} characters]`
    : text;
}

/**
 * The message content: the user's words, then one line per upload naming
 * its `upload` value, then any inlined text, then an image part per image
 * preview so a vision model sees what was attached.
 */
export function messageContent(
  text: string,
  attachments: Attachment[]
): string | { content: ContentPart[] } {
  const ready = attachments.filter((a) => a.status === 'ready');
  if (ready.length === 0) return text;
  const lines = [text.trim()];
  const uploads = ready.filter((a) => a.upload);
  if (uploads.length > 0) {
    lines.push(
      '',
      'Attached uploads (pass the upload value to a set_*_from_upload or Studio tool):',
      ...uploads.map(
        (a) => `- ${a.name} (${a.mimeType}): upload = ${a.upload ?? ''}`
      )
    );
  }
  for (const a of ready) {
    if (a.text !== undefined) {
      lines.push('', `Attached file ${a.name}:`, '```', a.text, '```');
    }
  }
  const parts: ContentPart[] = [{ type: 'text', content: lines.join('\n') }];
  for (const a of ready) {
    if (a.kind === 'image' && a.preview) {
      const [header, data] = a.preview.split(',', 2);
      const mimeType = header?.match(/^data:([^;]+)/)?.[1] ?? 'image/jpeg';
      if (data) {
        parts.push({
          type: 'image',
          source: { type: 'data', value: data, mimeType },
        });
      }
    }
  }
  return { content: parts };
}
