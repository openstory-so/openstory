---
'@openstory/stitch': minor
---

`stitch pull` and `stitch share` moved to `@openstory/cli`: `npx @openstory/cli@latest pull` and `npx @openstory/cli@latest share`. stitch no longer talks to OpenStory. For this minor version both print where they went and run the CLI through npx; the next minor version removes them. The cut pieces the CLI builds a share from are exported as `@openstory/stitch/bundle`.
