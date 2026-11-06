---
'@openstory/stitch': patch
---

A clip that fails to load now says which file and why: `Failed to fetch: <url> (<cause>)`, where the cause is `connection dropped`, an HTTP status, `no CORS headers` or `network error`.

A retry now skips the browser cache. A file first loaded by a `<video>` without `crossorigin` could sit in Chrome's cache with no CORS headers and fail every later play of that clip until the cache was cleared.

A range response whose `Content-Range` the browser hides (no `Access-Control-Expose-Headers`) is now an error that retries past the cache, not a guessed size that cuts the clip short.
