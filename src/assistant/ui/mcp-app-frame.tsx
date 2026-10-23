/**
 * The in-app host for a tool's MCP Apps view (#2155): the same `ui://` page
 * the MCP server serves to Claude or ChatGPT, in a sandboxed iframe under a
 * finished tool card. It speaks the view's side of the MCP Apps protocol:
 * answers `ui/initialize`, hands over the tool result once the view says it
 * is ready, grows with `size-changed`, runs a `tools/call` through
 * `callMcpReadToolFn` (reads only), opens links in a new tab, and posts a
 * `ui/message` into the thread. Mounted only once the result is in, so the
 * result is sent once and never changes under the view.
 */

import { useQuery } from '@tanstack/react-query';
import type { ToolResultPart } from '@tanstack/ai';
import { useState } from 'react';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { callMcpReadToolFn, getMcpViewFn } from '../assistant.fn';

const PROTOCOL_VERSION = '2026-01-26';

type Rpc = {
  jsonrpc?: unknown;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};

function isRpc(value: unknown): value is Rpc {
  return (
    typeof value === 'object' &&
    value !== null &&
    'jsonrpc' in value &&
    value.jsonrpc === '2.0'
  );
}

/** The chat's unwrapped result back in an MCP envelope, which is what a view reads. */
function envelope(result: ToolResultPart) {
  if (result.error) {
    return {
      isError: true,
      content: [{ type: 'text', text: result.error }],
    };
  }
  const text =
    typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content);
  let structuredContent: unknown;
  try {
    structuredContent = JSON.parse(text);
  } catch {
    structuredContent = undefined;
  }
  return {
    isError: false,
    content: [{ type: 'text', text }],
    ...(structuredContent !== undefined ? { structuredContent } : {}),
  };
}

export const McpAppFrame: React.FC<{
  uri: string;
  result: ToolResultPart;
  /** A `ui/message` from the view: text sent into the thread as the user. */
  onMessage?: (text: string) => void;
}> = ({ uri, result, onMessage }) => {
  const view = useQuery({
    queryKey: ['mcp-view', uri],
    queryFn: () => getMcpViewFn({ data: { uri } }),
    staleTime: Infinity,
  });
  const [height, setHeight] = useState(96);

  // The listener lives with the iframe: attached when it mounts, dropped
  // when it unmounts. Only its own window's messages are read.
  const attach = (node: HTMLIFrameElement | null) => {
    if (!node) return;
    const post = (message: Record<string, unknown>) =>
      node.contentWindow?.postMessage({ jsonrpc: '2.0', ...message }, '*');
    const fail = (id: Rpc['id'], message: string, code = -32000) =>
      post({ id, error: { code, message } });
    const onMessage_ = (event: MessageEvent) => {
      if (event.source !== node.contentWindow) return;
      const message: unknown = event.data;
      if (!isRpc(message) || !message.method) return;
      const { id, method, params = {} } = message;
      switch (method) {
        case 'ui/initialize':
          post({
            id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              hostInfo: { name: 'openstory-app', version: '1' },
              hostCapabilities: { serverTools: {}, openLinks: {} },
              hostContext: {
                theme: document.documentElement.classList.contains('dark')
                  ? 'dark'
                  : 'light',
              },
            },
          });
          return;
        case 'ui/notifications/initialized':
          post({
            method: 'ui/notifications/tool-result',
            params: envelope(result),
          });
          return;
        case 'ui/notifications/size-changed':
          if (typeof params.height === 'number') {
            setHeight(Math.min(Math.max(params.height, 48), 1200));
          }
          return;
        case 'tools/call':
          if (typeof params.name !== 'string') {
            fail(id, 'name required', -32602);
            return;
          }
          void callMcpReadToolFn({
            data: {
              name: params.name,
              arguments:
                typeof params.arguments === 'object' &&
                params.arguments !== null
                  ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validated again on the server
                    (params.arguments as Record<string, unknown>)
                  : {},
            },
          }).then(
            (value) => post({ id, result: value }),
            (error: unknown) =>
              fail(id, error instanceof Error ? error.message : 'Call failed')
          );
          return;
        case 'ui/open-link':
          if (typeof params.url === 'string' && /^https?:/.test(params.url)) {
            window.open(params.url, '_blank', 'noopener');
          }
          post({ id, result: {} });
          return;
        case 'ui/message': {
          const content = Array.isArray(params.content) ? params.content : [];
          const text = content
            .filter(
              (part): part is { type: 'text'; text: string } =>
                typeof part === 'object' &&
                part !== null &&
                'type' in part &&
                part.type === 'text' &&
                'text' in part &&
                typeof part.text === 'string'
            )
            .map((part) => part.text)
            .join('\n');
          if (text) onMessage?.(text);
          post({ id, result: {} });
          return;
        }
        default:
          if (id !== undefined) fail(id, 'Method not found', -32601);
      }
    };
    window.addEventListener('message', onMessage_);
    return () => window.removeEventListener('message', onMessage_);
  };

  if (view.error) {
    return (
      <p className="text-xs text-muted-foreground">
        The view could not load: {view.error.message}
      </p>
    );
  }
  if (!view.data) return <Skeleton className="h-24 w-full" />;
  return (
    <iframe
      ref={attach}
      title="Tool result"
      // No same-origin: the page is served to outside hosts too, and gets
      // the same rights here as there. Links open through the host.
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      srcDoc={view.data.html}
      style={{ height }}
      className="w-full rounded-md border-0 bg-transparent"
    />
  );
};
