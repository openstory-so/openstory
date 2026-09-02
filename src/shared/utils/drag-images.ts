/**
 * Extract image File objects from a drag-and-drop DataTransfer.
 *
 * Handles three increasingly loose sources:
 *  1. `dataTransfer.files` — real File objects (local drag from Finder, etc.)
 *  2. `text/uri-list` / `text/html` / `text/plain` — URL-only drags (from
 *     browser tabs, macOS Finder preview pane, or anywhere that doesn't
 *     populate files). We fetch the URL client-side and wrap the blob as a
 *     File so the rest of the upload flow is unchanged.
 *
 * CORS-protected URLs cannot be fetched client-side (no server proxy), so
 * those URLs are reported in `failedUrls` — callers should surface a message
 * when every dragged URL fails so the user knows why nothing was imported.
 */

import { toast } from 'sonner';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'utils', 'drag-images']);

const FILENAME_FALLBACK = 'image';

function extensionForMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/svg+xml') return 'svg';
  if (mime === 'image/avif') return 'avif';
  return 'bin';
}

function filenameFromUrl(url: string, mime: string): string {
  try {
    const parsed = new URL(url, 'http://local');
    const last = parsed.pathname.split('/').pop()?.split('#')[0] ?? '';
    if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last;
  } catch {
    // fall through
  }
  return FILENAME_FALLBACK + '.' + extensionForMime(mime);
}

function parseUriList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function parseHtmlImageSources(raw: string): string[] {
  const urls: string[] = [];
  const srcRegex = /<img[^>]+src=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  let match: RegExpExecArray | null = srcRegex.exec(raw);
  while (match !== null) {
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- match length could be < 2
    const src = match[1] ?? match[2] ?? match[3];
    if (src) urls.push(src);
    match = srcRegex.exec(raw);
  }
  return urls;
}

async function fetchAsImageFile(url: string): Promise<File | null> {
  try {
    const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!response.ok) {
      logger.warn('fetch returned non-ok status', {
        url,
        status: response.status,
      });
      return null;
    }
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) {
      logger.warn('fetched resource is not an image', {
        url,
        type: blob.type,
      });
      return null;
    }
    const name = filenameFromUrl(url, blob.type);
    return new File([blob], name, { type: blob.type });
  } catch (err) {
    logger.warn('fetch failed (likely CORS)', { url, err });
    return null;
  }
}

export function dataTransferHasImages(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types);
  // Skip pure `text/plain` / `text/html` drags — those cover text selections
  // too. `Files` covers local file drags; `text/uri-list` covers browser image
  // drags (Chrome/Firefox both populate it alongside html/plain).
  return types.includes('Files') || types.includes('text/uri-list');
}

/**
 * Synchronously snapshot the relevant bits of a DataTransfer before the
 * browser invalidates it (DataTransfer is only valid during the drop event
 * handler; subsequent async access returns empty strings).
 */
export type DragImageSnapshot = {
  files: File[];
  uriList: string;
  html: string;
  plain: string;
};

export function snapshotDataTransfer(
  dataTransfer: DataTransfer
): DragImageSnapshot {
  return {
    files: Array.from(dataTransfer.files).filter((f) =>
      f.type.startsWith('image/')
    ),
    uriList: dataTransfer.getData('text/uri-list'),
    html: dataTransfer.getData('text/html'),
    plain: dataTransfer.getData('text/plain'),
  };
}

export type ExtractImagesResult = {
  files: File[];
  failedUrls: string[];
};

export async function extractImagesFromSnapshot(
  snapshot: DragImageSnapshot
): Promise<ExtractImagesResult> {
  if (snapshot.files.length > 0) {
    return { files: snapshot.files, failedUrls: [] };
  }

  const urls = new Set<string>();
  for (const url of parseUriList(snapshot.uriList)) urls.add(url);
  for (const url of parseHtmlImageSources(snapshot.html)) urls.add(url);
  if (urls.size === 0) {
    const plain = snapshot.plain.trim();
    if (/^(https?:|data:image\/|blob:)/i.test(plain)) urls.add(plain);
  }

  if (urls.size === 0) return { files: [], failedUrls: [] };

  const urlList = Array.from(urls);
  const results = await Promise.all(
    urlList.map((url) => fetchAsImageFile(url))
  );
  const files: File[] = [];
  const failedUrls: string[] = [];
  results.forEach((result, index) => {
    if (result) {
      files.push(result);
    } else {
      const url = urlList[index];
      if (!url) throw new Error(`expected url at index ${index}`);
      failedUrls.push(url);
    }
  });
  return { files, failedUrls };
}

export function toastDragImportCorsError() {
  toast.error("Couldn't import dragged image", {
    description:
      'The source blocked cross-site access (CORS). Save it locally and drag from Finder.',
  });
}
