/**
 * Charge lines (docs/architecture/model-gateway.md § Money): one row per
 * part of a settled charge. A transaction's lines sum to its debit and are
 * written in the same batch. No cascade (AGENTS.md, D1 table-rebuild trap).
 */

import type { InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import type { ChargeLineKind } from '@/billing/charge-lines';
import { generateId } from '@/platform/id';
import { transactions } from './credits';
import { gatewayJobs } from './gateway-jobs';
import { organization } from './organization';

export const chargeLines = snakeCase.table(
  'charge_lines',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    // The payer.
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    transactionId: text()
      .notNull()
      .references(() => transactions.id, { onDelete: 'restrict' }),
    kind: text({ length: 20 }).$type<ChargeLineKind>().notNull(),
    amountMicros: integer().notNull(),
    // Null is the platform.
    payeeOrganizationId: text().references(() => organization.id, {
      onDelete: 'restrict',
    }),
    gatewayJobId: text().references(() => gatewayJobs.id, {
      onDelete: 'restrict',
    }),
    oauthClientId: text(),
    // A `gateway_apps` id; plain text, as no column was rebuilt to add the key.
    appId: text(),
    sku: text(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_charge_lines_transaction').on(table.transactionId),
    index('idx_charge_lines_organization_client_created').on(
      table.organizationId,
      table.oauthClientId,
      table.createdAt
    ),
    index('idx_charge_lines_payee_created').on(
      table.payeeOrganizationId,
      table.createdAt
    ),
    index('idx_charge_lines_organization_gateway_job').on(
      table.organizationId,
      table.gatewayJobId
    ),
  ]
);

export type ChargeLine = InferSelectModel<typeof chargeLines>;
