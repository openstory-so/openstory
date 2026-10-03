import { describe, expect, it } from 'vitest';
import {
  foreignKeysFromSchema,
  reorderPreviewDump,
} from './reorder-preview-dump';

describe('preview D1 dump ordering', () => {
  it('derives FK edges from the exported D1 CREATE TABLE syntax', () => {
    expect(
      foreignKeysFromSchema(
        'CREATE TABLE `child` (\n `parent_id` text REFERENCES `parent`(`id`)\n);\nCREATE TABLE "parent" ("id" text);'
      )
    ).toEqual([{ child: 'child', parent: 'parent' }]);
  });
  it('imports parents first and keeps migration history', () => {
    expect(
      reorderPreviewDump(
        'PRAGMA defer_foreign_keys=TRUE;\nINSERT INTO "child" VALUES (1);\nINSERT INTO "d1_migrations" VALUES (1);\nINSERT INTO "parent" VALUES (1);\n',
        [{ child: 'child', parent: 'parent' }]
      )
    ).toBe(
      'PRAGMA defer_foreign_keys=TRUE;\nINSERT INTO "d1_migrations" VALUES (1);\nINSERT INTO "parent" VALUES (1);\nINSERT INTO "child" VALUES (1);\n'
    );
  });

  it('rejects cycles instead of importing partial data', () => {
    expect(() =>
      reorderPreviewDump(
        'INSERT INTO "a" VALUES (1);\nINSERT INTO "b" VALUES (1);',
        [
          { child: 'a', parent: 'b' },
          { child: 'b', parent: 'a' },
        ]
      )
    ).toThrow('Cyclic');
  });
});
