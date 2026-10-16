---
'@openstory/stitch': minor
---

Play waits once for a time-based lead instead of stop-and-go on a slow link: `readAheadSeconds` (default 6, `DEFAULT_READ_AHEAD_SECONDS`) of the clip under the playhead are fetched before `play()` resolves, kept fetched while playing, and fetched again before a stall clears. The next clip's opening is fetched to the same lead before a cut. New option on the engine, `StitchedSequenceSource` and `StitchedPlayer`; `--read-ahead` on the CLI.
