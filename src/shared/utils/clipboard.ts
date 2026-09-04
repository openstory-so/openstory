/**
 * Copy text to the clipboard, with a fallback for browsers that refuse the
 * async Clipboard API.
 *
 * `navigator.clipboard` is undefined outside a secure context, and
 * `writeText` rejects on mobile Chrome when the page has no clipboard grant —
 * so a copy button that only calls it does nothing at all for those users.
 * The legacy `document.execCommand('copy')` path still works there, provided
 * it runs while the transient user activation from the tap is alive; that is
 * why the fallback fires immediately after the rejection rather than behind a
 * retry or a follow-up prompt.
 *
 * Returns whether the text made it to the clipboard, so callers can show a
 * failure state instead of a silent no-op. Never throws — a copy button
 * should not be able to take a handler down with it.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  // lib.dom types `navigator.clipboard` as always present; it is undefined
  // outside a secure context, so the lookup goes through a widened global.
  const clipboard = (globalThis as { navigator?: Partial<Navigator> }).navigator
    ?.clipboard;

  if (clipboard) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied / document not focused — try the legacy path.
    }
  }

  return copyViaExecCommand(text);
}

/**
 * Copy an image (by URL) onto the clipboard as PNG bytes — not the URL
 * string. Safari requires `clipboard.write` to run in the same turn as the
 * click, so the fetch is handed to `ClipboardItem` as a promise; Chrome
 * prefers a resolved Blob, and the catch retries that way.
 *
 * Returns whether the image made it onto the clipboard. Never throws.
 */
export async function copyImageToClipboard(url: string): Promise<boolean> {
  const clipboard = (globalThis as { navigator?: Partial<Navigator> }).navigator
    ?.clipboard;
  const ClipboardItemCtor = (
    globalThis as { ClipboardItem?: typeof ClipboardItem }
  ).ClipboardItem;

  if (!clipboard?.write || !ClipboardItemCtor) {
    return false;
  }

  const png = loadPngBlob(url);
  try {
    await clipboard.write([new ClipboardItemCtor({ 'image/png': png })]);
    return true;
  } catch {
    try {
      const blob = await png;
      await clipboard.write([new ClipboardItemCtor({ 'image/png': blob })]);
      return true;
    } catch {
      return false;
    }
  }
}

async function loadPngBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image (${response.status})`);
  }
  const blob = await response.blob();
  if (blob.type === 'image/png') return blob;
  return rasterizeToPng(blob);
}

async function rasterizeToPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Could not convert image to PNG');
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (png) => (png ? resolve(png) : reject(new Error('toBlob failed'))),
      'image/png'
    );
  });
}

/**
 * Selection-based copy. The textarea has to be in the document and visible to
 * the layout engine (`display: none` or `hidden` elements cannot be selected),
 * hence off-screen-but-rendered rather than hidden.
 */
function copyViaExecCommand(text: string): boolean {
  if (
    typeof document === 'undefined' ||
    typeof document.execCommand !== 'function'
  ) {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  // Read-only keeps the mobile keyboard closed; iOS still allows the selection.
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.width = '1px';
  textarea.style.height = '1px';
  textarea.style.padding = '0';
  textarea.style.border = 'none';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  const selection = document.getSelection();
  const previousRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  try {
    document.body.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (selection && previousRange) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
  }
}
