/**
 * The one tool that is the assistant's and not the MCP server's (#2155):
 * replacing text the user is typing that nothing has saved yet (the script
 * on the new-sequence page, the prompt in the Studio composer). No MCP tool
 * can reach it because it lives in the browser, so the server advertises the
 * definition when the page reports a draft and the browser executes it
 * against the open editor, the way Enhance writes into the script.
 */

import { z } from 'zod';
import { DRAFT_KINDS } from './page-context';

export const REPLACE_UNSAVED_TEXT = {
  name: 'replace_unsaved_text',
  description:
    'Replace an unsaved draft the user is looking at (an "Unsaved script" or "Unsaved prompt" in the page context) with new text. The editor shows it at once and the user can undo. Send the whole new text, not a diff.',
  inputSchema: z.object({
    kind: z.enum(DRAFT_KINDS),
    text: z.string().max(50_000),
  }),
} as const;

export type ReplaceUnsavedTextInput = z.infer<
  typeof REPLACE_UNSAVED_TEXT.inputSchema
>;
