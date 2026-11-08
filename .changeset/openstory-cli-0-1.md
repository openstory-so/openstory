---
'@openstory/cli': minor
---

First release of `@openstory/cli` (bin `openstory`): `login`, `pull` and `share`, moved out of `@openstory/stitch`. Run it with `npx @openstory/cli@latest <command>`. Keys move from `~/.openstory/stitch.json` to `~/.openstory/credentials.json` on first run. Every request carries the CLI version (`X-OpenStory-CLI`), and a 426 from the server says to update. A newer version is noted on stderr at most once a day.
