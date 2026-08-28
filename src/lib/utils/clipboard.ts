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
