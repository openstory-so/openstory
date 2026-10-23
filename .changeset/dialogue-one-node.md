---
'@openstory/stitch': patch
---

Each clip's sound, and a still's dialogue, is now decoded and played as one node at the track's own sample rate, in playback and in the MP4 export. Scheduling every decoded chunk on its own made the browser resample each one alone against a context at the music's or the device's rate, so dialogue crackled at every chunk boundary (#2170). A track that spans more than a second past its clip, or carries more than a second of gaps, is refused and reported instead of played.
