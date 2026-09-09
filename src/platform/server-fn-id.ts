import { createHash } from 'node:crypto';

/**
 * Stable server-function ids across file moves (#1549).
 *
 * TanStack Start's default production id is
 * `sha256("<relative filename>--<functionName>")`, so moving a file changes
 * the id of every server function in it. #1536 moved ~1,500 files and every
 * open browser tab from before the deploy then called `GET /_serverFn/<id>`
 * for ids that no longer existed — ~50 bare `HTTPError` 500s in an hour.
 *
 * Seeding on the function name alone makes a move a no-op; only renaming the
 * variable moves the id, which is a real API change. The name is still hashed
 * so the id stays compact and doesn't leak source layout.
 *
 * Wired via `tanstackStart({ serverFns: { generateFunctionId } })` in
 * vite.config.ts. Dev is unaffected — dev ids are base64 of file + export and
 * the hook is only consulted for builds.
 */
export function createServerFnIdGenerator(): (opts: {
  filename: string;
  functionName: string;
}) => string {
  // id -> the file that first produced it. Two different files with the same
  // function name would otherwise get silently deduplicated by the compiler
  // (it appends `_1`), whose ordering isn't stable — a build failure is safer.
  const owners = new Map<string, string>();

  return ({ filename, functionName }) => {
    const id = createHash('sha256').update(functionName).digest('hex');
    const owner = owners.get(id);
    if (owner !== undefined && owner !== filename) {
      throw new Error(
        `Duplicate server function name "${functionName}" in ${owner} and ${filename}. ` +
          'Server function ids are seeded on the variable name alone (#1549), ' +
          'so the name must be unique across the codebase — rename one of them.'
      );
    }
    owners.set(id, filename);
    return id;
  };
}
