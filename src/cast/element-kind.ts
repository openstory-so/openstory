/**
 * What KIND of media a sequence element is (#1559).
 *
 * An element used to be an image and nothing else. It can now also be a clip
 * or an audio file — a dialogue line, a voice sample, a music bed, a
 * performance to copy, a camera move. Nothing here says what the file is FOR:
 * the element carries what it is, the `@` mention around it in the script or
 * shot prompt carries how it is used.
 *
 * Client-safe: the upload surfaces and the server fn derive the kind from the
 * same table, so a file accepted by the picker cannot land as a different kind
 * on the row. Sorted by MIME type, exactly like `studio-composer`'s `fileKind`.
 */

const ELEMENT_KINDS = ['image', 'video', 'audio'] as const;
export type SequenceElementKind = (typeof ELEMENT_KINDS)[number];

/**
 * Extensions we accept for the two non-image kinds. Images are sniffed by
 * prefix.
 *
 * M4A and OGG are accepted but never STORED as such: the upload re-encodes
 * them to WAV (`normalizeElementFile`), since every model that documents its
 * formats takes only MP3 or WAV. Video has no such conversion, so it is MP4 or
 * MOV only — WebM was accepted until #1559 and then rejected by the model.
 */
const NON_IMAGE_EXTENSIONS: Record<string, SequenceElementKind> = {
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  ogg: 'audio',
  mp4: 'video',
  mov: 'video',
};

/**
 * `accept` for every element file input.
 *
 * DERIVED from the extension table above rather than spelled out: the two
 * drifted apart once already — `NON_IMAGE_EXTENSIONS` took `.m4a`, `.ogg` and
 * `.webm` while this string did not, so the picker silently refused a file
 * that paste and drag-and-drop both accepted, and that the server stores
 * happily. A list that can disagree with the parser will.
 */
export const ELEMENT_UPLOAD_ACCEPT = [
  'image/*',
  ...Object.keys(NON_IMAGE_EXTENSIONS).map((ext) => `.${ext}`),
].join(',');

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'svg',
  'avif',
  'heic',
]);

/** `null` for a type we don't store as an element. */
function elementKindFromMimeType(
  mimeType: string | null | undefined
): SequenceElementKind | null {
  if (!mimeType) return null;
  const type = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return null;
}

/**
 * The kind a filename (or stored path / URL) names. The server has only the
 * filename at finalize time, so the extension is the authority there — and the
 * client derives the same answer so the two never disagree.
 */
export function elementKindFromFilename(
  filename: string
): SequenceElementKind | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return NON_IMAGE_EXTENSIONS[ext] ?? null;
}

/** The kind of a picked File: its MIME type, falling back to its name. */
export function elementKindFromFile(file: {
  type: string;
  name: string;
}): SequenceElementKind | null {
  return (
    elementKindFromMimeType(file.type) ?? elementKindFromFilename(file.name)
  );
}

/** "12s" / "1:04" — how a clip length reads in prompts and in the UI. */
export function formatElementDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0)
    return null;
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded}s`;
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}

/**
 * Read a local audio/video file's duration in the browser, or `null` when the
 * browser can't decode it. Best-effort: a missing duration only costs the
 * prompt a hint, so a failure resolves rather than rejects.
 */
export async function readMediaDuration(
  file: File,
  kind: SequenceElementKind
): Promise<number | null> {
  if (kind === 'image') return null;
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    el.preload = 'metadata';
    el.onloadedmetadata = () =>
      done(Number.isFinite(el.duration) ? el.duration : null);
    el.onerror = () => done(null);
    el.src = url;
  });
}
