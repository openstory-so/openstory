/**
 * M0 proof: the OpenStory data core runs under Node/Bun on embedded SQLite,
 * with zero Workerd / Cloudflare involvement.
 *
 * Exercises, end to end:
 *   1. drizzle migrations (the D1 SQL, unchanged) applied to a libSQL file db
 *   2. the single-tenant bootstrap (real inserts into user/teams/team_members)
 *   3. a Drizzle relational read through the scoped-db graph
 *   4. a filesystem storage round-trip (upload → read back)
 *
 * Run:
 *   OPENSTORY_DB=file:./.openstory/local.db \
 *   OPENSTORY_STORAGE_DIR=./.openstory/storage \
 *   bun scripts/local/prove-core.ts
 */

import { migrateLocalDb } from '@/platform/server/db/migrate-node';
import { resolveUserTeam } from '@/platform/server/db/scoped';
import {
  getLocalScopedDb,
  LOCAL_USER_ID,
} from '@/platform/server/local/bootstrap';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import {
  readStorageObject,
  uploadFile,
} from '@/platform/server/storage/storage-node';

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(22)} ${value}\n`);
}

async function main(): Promise<void> {
  process.env.OPENSTORY_DB ??= 'file:./.openstory/local.db';
  process.env.OPENSTORY_STORAGE_DIR ??= './.openstory/storage';

  process.stdout.write('\n▶ OpenStory local data-core proof\n\n');

  line('OPENSTORY_DB', process.env.OPENSTORY_DB ?? '(unset)');
  line('OPENSTORY_STORAGE_DIR', process.env.OPENSTORY_STORAGE_DIR ?? '(unset)');
  process.stdout.write('\n');

  // 1. migrations
  await migrateLocalDb();
  line('migrations', '✅ applied');

  // 2. bootstrap — real inserts through the same path the sign-up hook uses
  const scopedDb = await getLocalScopedDb();
  line('scoped db', `✅ team=${scopedDb.teamId} user=${scopedDb.userId}`);

  // 3. relational read back through the scoped graph
  const team = await resolveUserTeam(LOCAL_USER_ID);
  if (!team) throw new Error('resolveUserTeam returned null after bootstrap');
  line('read back', `✅ "${team.teamName}" role=${team.role}`);

  // idempotency: a second bootstrap must not create a second team
  const again = await getLocalScopedDb();
  if (again.teamId !== scopedDb.teamId) {
    throw new Error('bootstrap not idempotent — team id changed');
  }
  line('idempotent', '✅ same team on re-bootstrap');

  // 4. storage round-trip
  const payload = `hello openstory ${Date.now()}`;
  const uploaded = await uploadFile(
    STORAGE_BUCKETS.VIDEOS,
    'proof/hello.txt',
    Buffer.from(payload)
  );
  line('storage upload', `✅ ${uploaded.publicUrl}`);

  const read = await readStorageObject(uploaded.path);
  if (!read) throw new Error('readStorageObject returned null');
  const roundTripped = Buffer.from(read.bytes).toString('utf8');
  if (roundTripped !== payload) {
    throw new Error(
      `storage round-trip mismatch: wrote "${payload}" read "${roundTripped}"`
    );
  }
  line('storage read', `✅ ${read.bytes.byteLength} bytes match`);

  process.stdout.write('\n✅ data core runs on Node/Bun + SQLite\n\n');
}

main().catch((error: unknown) => {
  process.stderr.write(
    `\n❌ proof failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n\n`
  );
  process.exit(1);
});
