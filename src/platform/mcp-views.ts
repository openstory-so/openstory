/**
 * MCP Apps views (#1673, #2155): which tool has a `ui://` page to show its
 * result in. Client-safe so the in-app assistant can host the same page the
 * MCP server serves to outside agents; the page itself stays server-side
 * (`server/mcp/ui/`) and reaches the browser through `getMcpViewFn`.
 */

export const SEQUENCE_CARD_URI = 'ui://openstory/sequence-card.html';

/** Tool name (the MCP one, with its dot) → its view. */
export const TOOL_VIEWS: Readonly<Record<string, string>> = {
  'openstory.get_sequence': SEQUENCE_CARD_URI,
};

/**
 * The tools a view may call through the in-app host (`tools/call`): the
 * reads the pages above actually make, nothing more. Not "any read": a view
 * must not reach the web tools or walk the team's data on its own.
 */
export const VIEW_CALLABLE_TOOLS: ReadonlySet<string> = new Set([
  'openstory.get_sequence_status',
]);

/** The view for a tool the chat called (`openstory_get_sequence`), if any. */
export function viewForChatTool(chatName: string): string | undefined {
  return TOOL_VIEWS[chatName.replace(/^openstory_/, 'openstory.')];
}
