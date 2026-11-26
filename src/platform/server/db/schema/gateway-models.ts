/**
 * The gateway's stored modelschemas snapshot (docs/architecture/model-gateway.md):
 * one model, its request schema and its rate card. Platform-global derived cache,
 * refreshed daily; a submit reads it and never waits on modelschemas.
 */

import type { GatewayModel } from '@/gateway/server/catalog';
import type { GatewayProvider } from '@/gateway/schema';
import { integer, primaryKey, snakeCase, text } from 'drizzle-orm/sqlite-core';

export const gatewayModels = snakeCase.table(
  'gateway_models',
  {
    provider: text({ length: 20 }).$type<GatewayProvider>().notNull(),
    /** The id the model is asked for by, as in `/gateway/{provider}/{model}`. */
    modelId: text({ length: 200 }).notNull(),
    model: text({ mode: 'json' }).$type<GatewayModel>().notNull(),
    fetchedAt: integer({ mode: 'timestamp' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.provider, table.modelId] })]
);
