/**
 * Which message each environment gives for an audio upload (#2265).
 * The words stay the no-container list. With the container, M4A, OGG and
 * FLAC for element, studio, music and dialogue become WAV instead.
 */

import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/platform/errors';
import {
  planAudioUpload,
  type AudioUploadUse,
} from '@/shots/server/audio-upload-plan';

const ELEMENT_LIST = 'jpg, jpeg, png, webp, gif, mp3, wav, mp4, mov';
const MUSIC_LIST = 'mp3, wav, ogg, m4a';
const STITCH_LIST =
  'jpg, jpeg, png, webp, gif, mp4, webm, mov, mp3, wav, ogg, m4a';
const IMAGE_LIST = 'jpg, jpeg, png, webp, gif';

function refusal(
  use: AudioUploadUse,
  mediaType: string,
  transcoderAvailable: boolean
): string | null {
  try {
    planAudioUpload(use, mediaType, transcoderAvailable);
    return null;
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return error.message;
  }
}

describe('planAudioUpload', () => {
  it('refuses element M4A, OGG and FLAC without a container, and stores WAV with one', () => {
    const message = `A element upload must be ${ELEMENT_LIST}; got audio/mp4.`;
    expect(refusal('element', 'audio/mp4', false)).toBe(message);
    expect(refusal('element', 'audio/x-m4a', false)).toBe(
      `A element upload must be ${ELEMENT_LIST}; got audio/x-m4a.`
    );
    expect(refusal('element', 'audio/ogg', false)).toBe(
      `A element upload must be ${ELEMENT_LIST}; got audio/ogg.`
    );
    expect(refusal('element', 'audio/flac', false)).toBe(
      `A element upload must be ${ELEMENT_LIST}; got audio/flac.`
    );
    expect(refusal('element', 'audio/x-flac', false)).toBe(
      `A element upload must be ${ELEMENT_LIST}; got audio/x-flac.`
    );

    for (const mediaType of [
      'audio/mp4',
      'audio/x-m4a',
      'audio/ogg',
      'audio/flac',
      'audio/x-flac',
    ]) {
      expect(planAudioUpload('element', mediaType, true)).toEqual({
        extension: 'wav',
        contentType: 'audio/wav',
        transcode: true,
      });
    }
  });

  it('uses the same words for studio', () => {
    expect(refusal('studio', 'audio/mp4', false)).toBe(
      `A studio upload must be ${ELEMENT_LIST}; got audio/mp4.`
    );
    expect(planAudioUpload('studio', 'audio/ogg', true)).toEqual({
      extension: 'wav',
      contentType: 'audio/wav',
      transcode: true,
    });
  });

  it('keeps music M4A and OGG as themselves until a container is up, then stores WAV', () => {
    expect(planAudioUpload('music', 'audio/mp4', false)).toEqual({
      extension: 'm4a',
      contentType: 'audio/mp4',
      transcode: false,
    });
    expect(planAudioUpload('music', 'audio/ogg', false)).toEqual({
      extension: 'ogg',
      contentType: 'audio/ogg',
      transcode: false,
    });
    expect(refusal('music', 'audio/flac', false)).toBe(
      `A music upload must be ${MUSIC_LIST}; got audio/flac.`
    );
    for (const mediaType of ['audio/mp4', 'audio/ogg', 'audio/flac']) {
      expect(planAudioUpload('music', mediaType, true)).toEqual({
        extension: 'wav',
        contentType: 'audio/wav',
        transcode: true,
      });
    }
  });

  it('refuses dialogue that is not WAV until a container is up', () => {
    expect(refusal('dialogue', 'audio/ogg', false)).toBe(
      'A dialogue upload must be wav; got audio/ogg.'
    );
    expect(refusal('dialogue', 'audio/mpeg', false)).toBe(
      'A dialogue upload must be wav; got audio/mpeg.'
    );
    expect(planAudioUpload('dialogue', 'audio/wav', false)).toEqual({
      extension: 'wav',
      contentType: 'audio/wav',
      transcode: false,
    });
    expect(planAudioUpload('dialogue', 'audio/ogg', true)).toEqual({
      extension: 'wav',
      contentType: 'audio/wav',
      transcode: true,
    });
    expect(planAudioUpload('dialogue', 'audio/wav', true)).toEqual({
      extension: 'wav',
      contentType: 'audio/wav',
      transcode: false,
    });
  });

  it('leaves a stitch file in its own container, and refuses FLAC either way', () => {
    expect(planAudioUpload('stitch', 'audio/mp4', true)).toEqual({
      extension: 'm4a',
      contentType: 'audio/mp4',
      transcode: false,
    });
    const message = `A stitch upload must be ${STITCH_LIST}; got audio/flac.`;
    expect(refusal('stitch', 'audio/flac', false)).toBe(message);
    expect(refusal('stitch', 'audio/flac', true)).toBe(message);
  });

  it('stores MP3 as MP3 even when a container is up', () => {
    expect(planAudioUpload('element', 'audio/mpeg', true)).toEqual({
      extension: 'mp3',
      contentType: 'audio/mpeg',
      transcode: false,
    });
  });

  it('refuses audio on a still with the same message either way', () => {
    const message = `A shot_image upload must be ${IMAGE_LIST}; got audio/mpeg.`;
    expect(refusal('shot_image', 'audio/mpeg', false)).toBe(message);
    expect(refusal('shot_image', 'audio/mpeg', true)).toBe(message);
    expect(refusal('shot_image', 'audio/flac', true)).toBe(
      `A shot_image upload must be ${IMAGE_LIST}; got audio/flac.`
    );
  });
});
