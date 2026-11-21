/**
 * Gateway earnings (docs/architecture/model-gateway.md § Earnings): one row
 * per payee charge line, written in the line's own batch, held until
 * `available_at`, then matured once into the payee's wallet. No cascade.
 */

import type { InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { EarningStatus } from '@/billing/charge-lines';
import { generateId } from '@/platform/id';
import { chargeLines } from './charge-lines';
import { transactions } from './credits';
import { gatewayApps } from './gateway-apps';
import { organization } from './organization';

export const gatewayEarnings = snakeCase.table(
  'gateway_earnings',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    chargeLineId: text()
      .notNull()
      .references(() => chargeLines.id, { onDelete: 'restrict' }),
    payerOrganizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    payeeOrganizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    appId: text()
      .notNull()
      .references(() => gatewayApps.id, { onDelete: 'restrict' }),
    amountMicros: integer().notNull(),
    status: text({ length: 20 })
      .$type<EarningStatus>()
      .default('pending')
      .notNull(),
    availableAt: integer({ mode: 'timestamp' }).notNull(),
    maturedAt: integer({ mode: 'timestamp' }),
    // The `credit_earned` row it matured into.
    transactionId: text().references(() => transactions.id, {
      onDelete: 'restrict',
    }),
    cancelledAt: integer({ mode: 'timestamp' }),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('uq_gateway_earnings_charge_line').on(table.chargeLineId),
    index('idx_gateway_earnings_status_available').on(
      table.status,
      table.availableAt
    ),
    index('idx_gateway_earnings_payee_app_created').on(
      table.payeeOrganizationId,
      table.appId,
      table.createdAt
    ),
  ]
);

export type GatewayEarning = InferSelectModel<typeof gatewayEarnings>;
