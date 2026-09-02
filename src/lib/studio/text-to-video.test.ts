import { describe, expect, it } from 'vitest';
import {
  IMAGE_TO_VIDEO_MODELS,
  isValidImageToVideoModel,
} from '@/lib/ai/models';
import {
  buildStudioVideoInput,
  renumberStudioReferences,
  snapStudioVideoDuration,
  studioCombinedRefCap,
  studioSupportsEndFrame,
  studioSupportsMode,
  studioVideoEndpointId,
  studioVideoEndpointIds,
  studioVideoSupportsAudio,
  tagStudioReferences,
} from './text-to-video';

const SEQUENCE_VIDEO_KEYS = Object.keys(IMAGE_TO_VIDEO_MODELS).filter(
  isValidImageToVideoModel
);

describe('studioVideoEndpointId', () => {
  it('maps every sequence video model to a text-to-video sibling, not image-to-video', () => {
    const ids = SEQUENCE_VIDEO_KEYS.map((model) =>
      studioVideoEndpointId(model)
    );
    expect(ids).toEqual([
      'xai/grok-imagine-video/v1.5/text-to-video',
      'fal-ai/ltx-2.3/text-to-video',
      'fal-ai/veo3.1',
      'fal-ai/gemini-omni-1.1-flash',
      'fal-ai/kling-video/v3/pro/text-to-video',
      'fal-ai/minimax/hailuo-2.3/pro/text-to-video',
      'minimax/h3-max/text-to-video',
      'bytedance/seedance-2.0/enterprise/v2/text-to-video',
      'bytedance/seedance-2.5/text-to-video',
    ]);
    expect(ids.some((id) => id.includes('image-to-video'))).toBe(false);
    // Pricing refresh sees the reference siblings too.
    expect(studioVideoEndpointIds()).toEqual(
      expect.arrayContaining([
        ...ids,
        'xai/grok-imagine-video/v1.5/reference-to-video',
        'fal-ai/veo3.1/reference-to-video',
        'fal-ai/kling-video/o3/pro/reference-to-video',
        'fal-ai/gemini-omni-1.1-flash/reference-to-video',
        'minimax/h3-max/reference-to-video',
      ])
    );
  });
});

describe('buildStudioVideoInput', () => {
  const base = {
    prompt: 'A red fox turns toward camera in morning fog',
    duration: 5,
    aspectRatio: '16:9' as const,
    generateAudio: true,
  };

  it.each(SEQUENCE_VIDEO_KEYS)('never sends an image field for %s', (model) => {
    const { modelOptions } = buildStudioVideoInput({ ...base, model });
    expect(modelOptions).not.toHaveProperty('image_url');
    expect(modelOptions).not.toHaveProperty('start_image_url');
    expect(modelOptions).not.toHaveProperty('image_urls');
  });

  it('encodes Kling duration as a string and includes aspect + audio', () => {
    const { prompt, modelOptions } = buildStudioVideoInput({
      ...base,
      model: 'kling_v3_pro',
    });
    expect(prompt).toBe(base.prompt);
    expect(modelOptions).toMatchObject({
      duration: '5',
      aspect_ratio: '16:9',
      generate_audio: true,
    });
  });

  it('encodes Veo duration with an s suffix and the default tier', () => {
    expect(
      buildStudioVideoInput({ ...base, model: 'veo3_1', duration: 8 })
        .modelOptions
    ).toMatchObject({
      duration: '8s',
      aspect_ratio: '16:9',
      generate_audio: true,
      resolution: '720p',
    });
  });

  it('resolves the requested tier against the model enum (#1449)', () => {
    const at = (
      model: 'veo3_1' | 'minimax_h3_max',
      resolution: '1080p' | '4k'
    ) =>
      buildStudioVideoInput({ ...base, model, duration: 8, resolution })
        .modelOptions.resolution;
    expect(at('veo3_1', '4k')).toBe('4k');
    expect(at('veo3_1', '1080p')).toBe('1080p');
    // H3 Max stops at 768P, whatever is asked for.
    expect(at('minimax_h3_max', '4k')).toBe('768P');
  });

  it('omits resolution for a model that takes none', () => {
    expect(
      buildStudioVideoInput({
        ...base,
        model: 'kling_v3_pro',
        resolution: '4k',
      }).modelOptions
    ).not.toHaveProperty('resolution');
  });

  it('sends LTX duration as a number snapped to 6/8/10', () => {
    expect(
      buildStudioVideoInput({ ...base, model: 'ltx_2_3_pro', duration: 5 })
        .modelOptions
    ).toMatchObject({
      duration: 6,
      aspect_ratio: '16:9',
      generate_audio: true,
    });
  });

  it('sends Seedance duration as a string and 720p', () => {
    expect(
      buildStudioVideoInput({ ...base, model: 'seedance_v2' }).modelOptions
    ).toMatchObject({
      duration: '5',
      aspect_ratio: '16:9',
      generate_audio: true,
      resolution: '720p',
    });
    expect(
      buildStudioVideoInput({ ...base, model: 'seedance_v2_5' }).modelOptions
    ).toMatchObject({
      duration: '5',
      aspect_ratio: '16:9',
      generate_audio: true,
      resolution: '720p',
    });
  });

  it('sends Grok fal T2V duration as an integer, with no generate_audio field', () => {
    const { modelOptions } = buildStudioVideoInput({
      ...base,
      model: 'grok_imagine_video_1_5',
    });
    expect(modelOptions).toMatchObject({
      duration: 5,
      aspect_ratio: '16:9',
      resolution: '720p',
    });
    expect(modelOptions).not.toHaveProperty('generate_audio');
  });

  it('sends H3 Max duration, 768P, and balanced prompt expansion', () => {
    expect(
      buildStudioVideoInput({ ...base, model: 'minimax_h3_max' }).modelOptions
    ).toMatchObject({
      duration: 5,
      aspect_ratio: '16:9',
      resolution: '768P',
      prompt_expansion_mode: 'balanced',
    });
  });

  it('sends Hailuo prompt only — that endpoint has no duration or aspect', () => {
    const { prompt, modelOptions } = buildStudioVideoInput({
      ...base,
      model: 'minimax_hailuo_02',
    });
    expect(prompt).toBe(base.prompt);
    expect(modelOptions).toEqual({});
  });

  it('omits aspect_ratio when the T2V endpoint does not accept it', () => {
    expect(
      buildStudioVideoInput({
        ...base,
        model: 'ltx_2_3_pro',
        aspectRatio: '1:1',
      }).modelOptions
    ).not.toHaveProperty('aspect_ratio');
  });
});

describe('snapStudioVideoDuration', () => {
  it('snaps LTX to 6/8/10 and Veo to 4/6/8', () => {
    expect(snapStudioVideoDuration(5, 'ltx_2_3_pro')).toBe(6);
    expect(snapStudioVideoDuration(5, 'veo3_1')).toBe(4);
    expect(snapStudioVideoDuration(10, 'veo3_1')).toBe(8);
  });
});

describe('studioVideoSupportsAudio', () => {
  it('is true only when the T2V sibling exposes generate_audio', () => {
    expect(studioVideoSupportsAudio('kling_v3_pro')).toBe(true);
    expect(studioVideoSupportsAudio('ltx_2_3_pro')).toBe(true);
    expect(studioVideoSupportsAudio('veo3_1')).toBe(true);
    expect(studioVideoSupportsAudio('seedance_v2')).toBe(true);
    expect(studioVideoSupportsAudio('seedance_v2_5')).toBe(true);
    expect(studioVideoSupportsAudio('grok_imagine_video_1_5')).toBe(false);
    expect(studioVideoSupportsAudio('minimax_hailuo_02')).toBe(false);
  });
});

describe('reference tags', () => {
  it('turns bare pill tokens into provider @ImageN tags', () => {
    expect(tagStudioReferences('Image1 walks past Image2, not @Image3')).toBe(
      '@Image1 walks past @Image2, not @Image3'
    );
    expect(tagStudioReferences('Image10x and MyImage1')).toBe(
      'Image10x and MyImage1'
    );
    expect(
      tagStudioReferences('Audio1 plays under Image2, cut like Video1')
    ).toBe('@Audio1 plays under @Image2, cut like @Video1');
    expect(renumberStudioReferences('Audio1 then Audio2', 0, 'Audio')).toBe(
      ' then Audio1'
    );
    expect(
      tagStudioReferences('Image1 meets Image2', 'grok_imagine_video_1_5')
    ).toBe('<IMAGE_0> meets <IMAGE_1>');
    expect(tagStudioReferences('Image2 at dusk', 'veo3_1')).toBe(
      'reference image 2 at dusk'
    );
    expect(
      tagStudioReferences('Image1 meets Image2', 'gemini_omni_flash')
    ).toBe('<IMAGE_REF_0> meets <IMAGE_REF_1>');
    expect(
      tagStudioReferences(
        'Image1 walks with Video1 under Audio1',
        'minimax_h3_max'
      )
    ).toBe('Image 1 walks with Video 1 under Audio 1');
  });

  it('drops the removed token and shifts later ones down', () => {
    expect(renumberStudioReferences('Image1 hands Image2 to Image3.', 1)).toBe(
      'Image1 hands  to Image2.'
    );
    expect(renumberStudioReferences('@Image1 alone', 0)).toBe(' alone');
  });
});

describe('studioVideoEndpointId modes', () => {
  it('routes reference mode to the reference-to-video sibling', () => {
    expect(studioVideoEndpointId('seedance_v2', 'reference')).toBe(
      'bytedance/seedance-2.0/enterprise/v2/reference-to-video'
    );
    expect(studioVideoEndpointId('seedance_v2_5', 'text')).toBe(
      'bytedance/seedance-2.5/text-to-video'
    );
    expect(studioVideoEndpointId('seedance_v2_5', 'reference')).toBe(
      'bytedance/seedance-2.5/reference-to-video'
    );
    expect(studioVideoEndpointId('seedance_v2_5', 'frames')).toBe(
      'bytedance/seedance-2.5/image-to-video'
    );
    expect(studioVideoEndpointId('kling_v3_pro', 'reference')).toBe(
      'fal-ai/kling-video/o3/pro/reference-to-video'
    );
    expect(studioVideoEndpointId('grok_imagine_video_1_5', 'reference')).toBe(
      'xai/grok-imagine-video/v1.5/reference-to-video'
    );
    expect(studioVideoEndpointId('minimax_h3_max', 'reference')).toBe(
      'minimax/h3-max/reference-to-video'
    );
    expect(studioCombinedRefCap('minimax_h3_max')).toBe(12);
    expect(studioCombinedRefCap('seedance_v2')).toBeNull();
    expect(studioSupportsMode('minimax_h3_max', 'reference')).toBe(true);
    expect(() => studioVideoEndpointId('ltx_2_3_pro', 'reference')).toThrow();
    expect(studioSupportsMode('ltx_2_3_pro', 'reference')).toBe(false);
    expect(studioSupportsMode('minimax_hailuo_02', 'reference')).toBe(false);
  });

  it('routes frames mode to the image-to-video endpoint', () => {
    expect(studioVideoEndpointId('kling_v3_pro', 'frames')).toBe(
      IMAGE_TO_VIDEO_MODELS.kling_v3_pro.id
    );
    expect(studioSupportsEndFrame('kling_v3_pro')).toBe(true);
    expect(studioSupportsEndFrame('gemini_omni_flash')).toBe(true);
    expect(studioSupportsEndFrame('veo3_1')).toBe(false);
  });
});
