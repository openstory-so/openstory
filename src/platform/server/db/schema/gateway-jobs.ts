/**
 * Model gateway jobs (docs/architecture/model-gateway.md): one row per
 * `POST /api/v1/gateway/jobs`. `input` is the normalized request the run was
 * snapshotted from; `outputs` are R2 uploads with origin-relative URLs.
 * No cascade (AGENTS.md, D1 table-rebuild trap): cleanup is app code.
 */

import { type InferSelectModel, sql } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type {
  GatewayJobError,
  GatewayJobInput,
  GatewayJobKind,
  GatewayJobOutput,
  GatewayJobStatus,
} from '@/gateway/schema';
import type { MediaVia } from '@/models/via';
import { generateId } from '@/platform/id';
import { user } from './auth';
import { organization } from './organization';

export const gatewayJobs = snakeCase.table(
  'gateway_jobs',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    kind: text({ length: 20 }).$type<GatewayJobKind>().notNull(),
    modelKey: text({ length: 100 }).notNull(),
    input: text({ mode: 'json' }).$type<GatewayJobInput>().notNull(),
    status: text({ length: 20 })
      .$type<GatewayJobStatus>()
      .default('queued')
      .notNull(),
    // The via the job was sent to; poll follows it.
    via: text({ length: 50 }).$type<MediaVia>(),
    providerJobId: text(),
    outputs: text({ mode: 'json' }).$type<GatewayJobOutput[]>(),
    error: text({ mode: 'json' }).$type<GatewayJobError>(),
    costMicros: integer(),
    reservationId: text(),
    workflowRunId: text(),
    idempotencyKey: text({ length: 255 }),
    // The OAuth client that submitted, when one did; null for `osk_` keys.
    oauthClientId: text(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    completedAt: integer({ mode: 'timestamp' }),
  },
  (table) => [
    index('idx_gateway_jobs_organization').on(table.organizationId, table.id),
    // Per caller: each OAuth client, and the organization's own keys (''), has its own key space.
    // SQLite treats NULLs as distinct, so this binds only keyed submits.
    uniqueIndex('uq_gateway_jobs_organization_client_idempotency').on(
      table.organizationId,
      sql`coalesce(${table.oauthClientId}, '')`,
      table.idempotencyKey
    ),
  ]
);

export type GatewayJob = InferSelectModel<typeof gatewayJobs>;
