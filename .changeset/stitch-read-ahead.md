---
'@openstory/stitch': minor
---

Clips are downloaded whole, in order, one at a time, up to two past the clip under the playhead, and held in memory. `play()` resolves once the current clip is all here, and a stall at a cut clears once the next clip is, so a slow link waits once per clip at most instead of stop-and-go. Clips behind the playhead are let go of.
