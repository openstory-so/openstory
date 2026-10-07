/**
 * Stable, readable server-function ids (#1549, #1974).
 *
 * TanStack Start's default production id is
 * `sha256("<relative filename>--<functionName>")`, so moving a file changes
 * the id of every server function in it. #1536 moved ~1,500 files and every
 * open browser tab from before the deploy then called `GET /_serverFn/<id>`
 * for ids that no longer existed — ~50 bare `HTTPError` 500s in an hour.
 *
 * The id is the variable name, so a move is a no-op; only renaming the
 * variable moves the id, which is a real API change. It is not hashed:
 * Cloudflare redacts any 32+ hex-digit run in a URL, so a hash showed up in
 * every exported trace as `/_serverFn/REDACTED`. A name like
 * `listSequencesFn` passes Cloudflare's rule unless it is 21+ chars with two
 * or more each of upper, lower and digits.
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
    const id = functionName.replace(/_createServerFn_handler$/, '');
    const owner = owners.get(id);
    if (owner !== undefined && owner !== filename) {
      throw new Error(
        `Duplicate server function name "${functionName}" in ${owner} and ${filename}. ` +
          'Server function ids are the variable name alone (#1549), ' +
          'so the name must be unique across the codebase — rename one of them.'
      );
    }
    owners.set(id, filename);
    return id;
  };
}
