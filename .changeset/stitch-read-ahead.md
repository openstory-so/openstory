---
'@openstory/stitch': minor
---

Clips are downloaded whole, in order, one at a time, up to two past the clip under the playhead, and held in memory. `play()` resolves once the current clip is all here, and a stall at a cut clears once the next clip is, so a slow link waits once per clip for the clip's bytes instead of stop-and-go; music still streams. Clips outside that window are let go of. The `stitch` preview server answers only its own host and only GET and HEAD, types a remote file as media or opaque bytes, and `--music` / `--audio` take only `.wav`, `.mp3`, `.m4a`, or `.ogg`.
