/**
 * Channel-buffer assembly from decoded AudioData frames. Sizing is from the
 * actual frame count, NOT the muxed track duration: AAC priming/padding makes
 * the decoder emit ~2k more frames than `computeDuration` reports, and sizing
 * from duration overflows the typed array (`Float32Array.set` throws "offset
 * is out of bounds" once the write cursor passes the pre-allocated length).
 *
 * Exposed so the priming/padding-overflow regression has a unit test that
 * exercises the actual production code path.
 */
type DecodedAudioFrame = {
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  copyTo(
    dest: Float32Array,
    opts: { planeIndex: number; format: 'f32-planar' }
  ): void;
  close(): void;
};

export function assembleChannelData(
  decoded: ReadonlyArray<DecodedAudioFrame>,
  numberOfChannels: number
): { channelData: Float32Array[]; totalFrames: number } {
  let totalFrames = 0;
  for (const data of decoded) totalFrames += data.numberOfFrames;

  const channelData: Float32Array[] = [];
  for (let c = 0; c < numberOfChannels; c++) {
    channelData.push(new Float32Array(totalFrames));
  }

  let writeOffsetSamples = 0;
  for (const data of decoded) {
    const frames = data.numberOfFrames;
    for (
      let c = 0;
      c < Math.min(numberOfChannels, data.numberOfChannels);
      c++
    ) {
      const dest = channelData[c];
      if (!dest) throw new Error(`expected channel data ${c}`);
      const tmp = new Float32Array(frames);
      data.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
      dest.set(tmp, writeOffsetSamples);
    }
    writeOffsetSamples += frames;
    data.close();
  }

  return { channelData, totalFrames };
}
