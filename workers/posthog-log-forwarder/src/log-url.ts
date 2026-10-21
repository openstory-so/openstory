// Cloudflare's tail-URL redaction rule, applied here because the streaming
// tail feed sends request URLs raw: a run of id characters is replaced when it
// looks like a hex id (32+ hex digits) or a base-64 id (21+ chars with at least
// two upper, two lower and two digits). Server-fn paths are kept: the id there
// names the function, which is what we need to debug.
// https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/
const ID_RUN = /[A-Za-z0-9+_-]+/g;

export function logUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return redactIds(raw);
  }
  const path = url.pathname.startsWith('/_serverFn/')
    ? url.pathname
    : redactIds(url.pathname);
  return `${url.origin}${path}${redactIds(url.search)}`;
}

function redactIds(s: string): string {
  return s.replace(ID_RUN, (run) => (looksLikeId(run) ? 'REDACTED' : run));
}

function looksLikeId(run: string): boolean {
  const count = (re: RegExp) => run.match(re)?.length ?? 0;
  if (/^[0-9a-fA-F+_-]+$/.test(run) && count(/[0-9a-fA-F]/g) >= 32) {
    return true;
  }
  return (
    run.length >= 21 &&
    count(/[A-Z]/g) >= 2 &&
    count(/[a-z]/g) >= 2 &&
    count(/[0-9]/g) >= 2
  );
}
