/**
 * Join a track's decoded chunks into one `AudioBuffer`, placed by timestamp.
 *
 * A track rarely shares the `AudioContext`'s sample rate: dialogue is cut at
 * 44.1 kHz, embedded clip sound is usually 48 kHz, and the context runs at
 * the music's rate or the device's. Scheduling each decoded chunk as its own
 * `AudioBufferSourceNode` makes the browser resample every chunk on its own,
 * so each boundary clicks (#2170). One node per track resamples the whole
 * track once, continuously.
 */
export function joinAudioBuffers(
  chunks: readonly { buffer: AudioBuffer; timestamp: number }[],
  /** The longest the track can be, from what the caller knows of the clip. */
  maxSeconds: number
): { buffer: AudioBuffer; timestamp: number } | null {
  if (!(Number.isFinite(maxSeconds) && maxSeconds > 0)) {
    throw new Error(
      `Audio track bound is not a positive length: ${maxSeconds}`
    );
  }
  const first = chunks[0];
  if (!first) return null;
  const last = chunks.at(-1) ?? first;
  const { sampleRate, numberOfChannels } = first.buffer;
  const start = first.timestamp;
  // The span comes from the file's own timestamps, and so does the clip's
  // length, so neither is trusted alone to size the allocation. A track may
  // outrun its picture by an encoder pad (milliseconds), so each bound has a
  // second of slack; past either, or with no span at all, it is a broken
  // track and the caller reports it like one.
  const seconds = last.timestamp + last.buffer.duration - start;
  const length = Math.round(seconds * sampleRate);
  if (!(length > 0)) {
    throw new Error('Audio track chunks span no positive length');
  }
  let frames = 0;
  for (const { buffer } of chunks) frames += buffer.length;
  if (seconds > maxSeconds + 1 || length > frames + sampleRate) {
    throw new Error(
      `Audio track spans ${seconds.toFixed(1)}s with ${((length - frames) / sampleRate).toFixed(1)}s of gaps, past the clip's ${maxSeconds.toFixed(1)}s`
    );
  }
  const joined = new AudioBuffer({ numberOfChannels, length, sampleRate });
  for (const { buffer, timestamp } of chunks) {
    const at = Math.round((timestamp - start) * sampleRate);
    const fit = Math.min(buffer.length, length - at);
    if (fit <= 0) continue;
    for (let c = 0; c < numberOfChannels; c++) {
      joined.copyToChannel(
        buffer
          .getChannelData(Math.min(c, buffer.numberOfChannels - 1))
          .subarray(0, fit),
        c,
        at
      );
    }
  }
  return { buffer: joined, timestamp: start };
}
