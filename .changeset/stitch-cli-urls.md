---
'@openstory/stitch': minor
---

The `stitch` command takes `http(s)` URLs anywhere a file goes. A URL is probed over the network and proxied through the local server with the browser's `Range`, so a remote without CORS headers still plays and exports.

`--frame 9:16` (or `1080x1920`) sets the shape of the page. Without it only the first clip is read before the page opens; other videos are read only when `--subs` needs their lengths.
