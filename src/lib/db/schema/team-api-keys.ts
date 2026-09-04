/**
 * Team API Keys Schema
 * Encrypted storage for user-provided API keys (OpenRouter, Fal.ai, …).
 * Add a provider by appending to `API_KEY_PROVIDERS` — the Zod schema, key
 * resolver, and validate switch are derived from that list so a missing case
 * is a type error (#1216).
 *
 * Keys are encrypted with AES-256-GCM. The encryption key lives in
 * environment variables, separate from the database.
 */

import {
  integer,
  snakeCase,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { teams } from './teams';
import { user } from './auth';

export const API_KEY_PROVIDERS = [
  'openrouter',
  'fal',
  'xai',
  'google',
] as const;
export type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number];

const API_KEY_SOURCES = ['oauth', 'manual'] as const;
export type ApiKeySource = (typeof API_KEY_SOURCES)[number];

/**
 * Team API Keys table
 * Stores encrypted API keys per team per provider
 */
export const teamApiKeys = snakeCase.table(
  'team_api_keys',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    provider: text().$type<ApiKeyProvider>().notNull(),

    // Encrypted key data (AES-256-GCM)
    encryptedKey: text().notNull(),
    keyIv: text().notNull(),
    keyTag: text().notNull(),

    // Display hint (last 4 chars, safe to show in UI)
    keyHint: text().notNull(),

    // How the key was provided
    source: text().$type<ApiKeySource>().default('manual').notNull(),

    // Status
    isActive: integer({ mode: 'boolean' }).default(true).notNull(),

    // Validity — set false + invalidReason when a workflow or re-validation
    // check finds the key rejected by the provider (e.g. 401/403). When
    // invalid, resolveKey() skips the team key and falls back to platform.
    isInvalid: integer({ mode: 'boolean' }).default(false).notNull(),
    invalidReason: text(),
    lastValidatedAt: integer({ mode: 'timestamp' }),

    // Audit
    addedBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // One active key per team per provider
    uniqueIndex('idx_team_api_keys_team_provider').on(
      table.teamId,
      table.provider
    ),
    index('idx_team_api_keys_team_id').on(table.teamId),
  ]
);
