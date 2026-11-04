import type { InferSelectModel } from 'drizzle-orm';
import {
  integer,
  snakeCase,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import { user } from './auth';
import { organization } from './organization';

export const giftTokens = snakeCase.table(
  'gift_tokens',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    code: text().unique().notNull(),
    amountMicros: integer().notNull(),
    maxRedemptions: integer().default(1).notNull(),
    createdByUserId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: integer({ mode: 'timestamp' }),
    note: text(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('idx_gift_tokens_code').on(table.code),
    index('idx_gift_tokens_created_by').on(table.createdByUserId),
  ]
);

export const giftTokenRedemptions = snakeCase.table(
  'gift_token_redemptions',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    giftTokenId: text()
      .notNull()
      .references(() => giftTokens.id, { onDelete: 'cascade' }),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text().references(() => user.id, {
      onDelete: 'set null',
    }),
    redeemedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('idx_gift_token_redemptions_token_organization').on(
      table.giftTokenId,
      table.organizationId
    ),
    index('idx_gift_token_redemptions_token').on(table.giftTokenId),
    index('idx_gift_token_redemptions_organization').on(table.organizationId),
  ]
);

export type GiftToken = InferSelectModel<typeof giftTokens>;
