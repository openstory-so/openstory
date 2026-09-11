/**
 * Helpers for the local embedded-SQLite database file (`OPENSTORY_DB`).
 *
 * libSQL opens a `file:` URL but will not create its parent directory, so both
 * the client and the migrator call `ensureDbFileDir` before opening. In-memory
 * (`file::memory:` / `:memory:`) and remote (`libsql:` / `http:`) URLs have no
 * directory to make and are left alone.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Create the parent directory of a `file:`-URL SQLite database if needed. */
export function ensureDbFileDir(url: string): void {
  if (!url.startsWith('file:')) return;
  const path = url.slice('file:'.length);
  // `file::memory:` and other special forms have no real filesystem parent.
  if (path === '' || path.startsWith(':')) return;
  mkdirSync(dirname(path), { recursive: true });
}
