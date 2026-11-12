---
'@openstory/cli': patch
---

`openstory` sends at most 10 API-key requests, then waits more than a second, and retries when the server answers that the key is rate limited.
