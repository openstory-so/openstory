/**
 * What each artifact input hash read (#2344): leaf path → short digest, over
 * the body the hash is over. Content-addressed by the hash, so identical
 * inputs share a row and no artifact table grows a column. A stale verdict
 * diffs the stored manifest against the live one and names exactly what
 * moved. Not organization-scoped: a row holds digests of inputs, never the
 * inputs, and a reader already holds the hash from a row it may read.
 */
import type { InferSelectModel } from 'drizzle-orm';
import { integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import type { InputManifest } from '@/shots/input-hash';

export const inputManifests = snakeCase.table('input_manifests', {
  hash: text().primaryKey().notNull(),
  manifest: text({ mode: 'json' }).$type<InputManifest>().notNull(),
  createdAt: integer({ mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .notNull(),
});

export type InputManifestRow = InferSelectModel<typeof inputManifests>;
