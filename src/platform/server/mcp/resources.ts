/**
 * Production-context resources (#1462): sequence summary, bible and scene,
 * each the same projection as its tool.
 *
 * `@tanstack/ai-mcp` 0.6.0 cannot serve these: its resource `read()` gets no
 * URI variables, no request context and no `list`. So `resources/*` requests
 * are answered here by an SDK `McpServer` holding only these templates, and
 * `server.ts` registers the same templates on the ai-mcp server so
 * `initialize` advertises the capability. Fold this back into
 * `createMCPServer` once ai-mcp passes the URI, variables and context.
 */

import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  createMcpHandler,
  type Variables,
} from '@modelcontextprotocol/server';
import { getLogger, toErrorPayload } from '@/platform/logger';
import { OpenStoryError } from '@/platform/errors';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { overResponseCap, type OpenStoryMcpContext } from './tool-context';
import { MCP_RESOURCE_TEMPLATES } from './tools/resource-reads';
import { SEQUENCE_CARD_HTML, SEQUENCE_CARD_URI } from './ui/sequence-card';
import { getEnv } from '#env';

const logger = getLogger(['openstory', 'mcp', 'resources']);

const JSON_MIME = 'application/json';
/** Sequences listed by `resources/list`, most recently updated first. */
const LISTED_SEQUENCES = 50;

const expand = (template: string, ids: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => ids[key] ?? '');

/** Every variable a single ULID, and the URI exactly the template's. */
function parseIds(
  uri: URL,
  template: (typeof MCP_RESOURCE_TEMPLATES)[number],
  variables: Variables
): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const [, param = ''] of template.uriTemplate.matchAll(/\{(\w+)\}/g)) {
    const parsed = ulidSchema.safeParse(variables[param]);
    if (!parsed.success) throw new ResourceNotFoundError(uri.href);
    ids[param] = parsed.data;
  }
  if (expand(template.uriTemplate, ids) !== uri.href) {
    throw new ResourceNotFoundError(uri.href);
  }
  return ids;
}

/** MCP Apps (#1673): the HTML profile and where a view's media may load from. */
const MCP_APP_MIME = 'text/html;profile=mcp-app';

function viewMeta(origin: string) {
  const cdn = getEnv().R2_PUBLIC_STORAGE_DOMAIN;
  return {
    ui: {
      csp: {
        // The app origin (`/r2/…`), the storage CDN, and older fal.media rows.
        resourceDomains: [
          origin,
          ...(cdn ? [`https://${cdn}`] : []),
          'https://fal.media',
          'https://*.fal.media',
        ],
      },
      prefersBorder: true,
    },
  };
}

function buildResourceServer(context: OpenStoryMcpContext) {
  const server = new McpServer({ name: 'openstory', version: '0.1.0' });
  // A static page: no scope, no db.
  server.registerResource(
    'sequence-card',
    SEQUENCE_CARD_URI,
    {
      title: 'Sequence card',
      mimeType: MCP_APP_MIME,
      _meta: viewMeta(context.origin),
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: MCP_APP_MIME,
          text: SEQUENCE_CARD_HTML,
          _meta: viewMeta(context.origin),
        },
      ],
    })
  );
  // Same scope as the tools on list and read; templates/list needs none.
  const scoped = () => context.scoped('sequences:read');
  // One query per resources/list, shared by the listed templates.
  let listing: ReturnType<ScopedDb['sequences']['listPage']> | undefined;
  for (const template of MCP_RESOURCE_TEMPLATES) {
    const list = template.listed
      ? async () => {
          try {
            listing ??= scoped().scopedDb.sequences.listPage({
              limit: LISTED_SEQUENCES,
              cursor: null,
            });
            const rows = await listing;
            return {
              resources: rows.slice(0, LISTED_SEQUENCES).map((sequence) => ({
                uri: expand(template.uriTemplate, { sequenceId: sequence.id }),
                name: `${template.title}: ${sequence.title}`,
                mimeType: JSON_MIME,
              })),
            };
          } catch (error) {
            throw resourceError('resources/list', error);
          }
        }
      : undefined;
    server.registerResource(
      template.name,
      new ResourceTemplate(template.uriTemplate, { list }),
      { title: template.title, mimeType: JSON_MIME },
      async (uri, variables) => {
        const ids = parseIds(uri, template, variables);
        try {
          const { scopedDb, origin } = scoped();
          const text = JSON.stringify(
            await template.read(scopedDb, ids, origin)
          );
          if (overResponseCap(text)) {
            throw new ProtocolError(
              ProtocolErrorCode.InvalidRequest,
              'Resource exceeds 256 KiB. Use the matching tool and its list tools to page it.'
            );
          }
          return {
            contents: [{ uri: uri.href, mimeType: JSON_MIME, text }],
          };
        } catch (error) {
          throw resourceError(uri.href, error);
        }
      }
    );
  }
  return server;
}

/** A foreign, deleted or wrong-type id is not found; other refusals keep their code. */
function resourceError(uri: string, error: unknown): Error {
  if (error instanceof ProtocolError) return error;
  if (error instanceof OpenStoryError) {
    if (error.statusCode === 404) return new ResourceNotFoundError(uri);
    if (error.statusCode < 500) {
      return new ProtocolError(ProtocolErrorCode.InvalidRequest, error.message);
    }
  }
  logger.error('MCP resource read failed {uri}', {
    uri,
    err: toErrorPayload(error),
  });
  return new ProtocolError(
    ProtocolErrorCode.InternalError,
    'Unable to read the resource. Please retry.'
  );
}

/** Serve one authenticated `resources/*` request. */
export function serveResourceRequest(
  request: Request,
  context: OpenStoryMcpContext
): Promise<Response> {
  return createMcpHandler(() => buildResourceServer(context), {
    legacy: 'reject',
    keepAliveMs: 0,
    onerror: (error) =>
      logger.error('MCP resource handler error: {message}', {
        message: error.message,
        err: toErrorPayload(error),
      }),
  }).fetch(request);
}
