/**
 * Empty-prompt gate for Generate Image / Generate Motion (#1594).
 *
 * The assembled motion trailer (dialogue, audio direction, reference lines)
 * does not count: an empty *base* prompt is an empty prompt. Whitespace is
 * empty. Shared by the scene-editor buttons and the server fns behind them
 * so a stale tab gets the same answer as the UI.
 */

export const EMPTY_GENERATION_PROMPT_MESSAGE =
  'Write or generate a prompt first.';

export function isBlankPrompt(text: string | null | undefined): boolean {
  return !text?.trim();
}

/**
 * Resolve the prompt a generate click will render: an explicit override
 * (including `''` / whitespace) wins; otherwise the stored selected prompt.
 * Throws before credits are reserved.
 */
export function requireGenerationPrompt(
  override: string | undefined,
  stored: string | null | undefined
): void {
  const source = override !== undefined ? override : (stored ?? '');
  if (isBlankPrompt(source)) {
    throw new Error(EMPTY_GENERATION_PROMPT_MESSAGE);
  }
}
