import { generateVideo } from '@tanstack/ai';
import { falVideo } from '@tanstack/ai-fal';
import { describe, expect, it, vi } from 'vitest';
import { klingWireInput, stripPackedKlingPrompt } from './kling-wire-body';

function sentBody(fetchImpl: {
  mock: { calls: Array<Parameters<typeof fetch>> };
}): string {
  const body = fetchImpl.mock.calls[0]?.[1]?.body;
  if (typeof body !== 'string') throw new Error('expected a string body');
  return body;
}

describe('klingWireInput', () => {
  it('drops prompt only when multi_prompt is present', () => {
    expect(
      klingWireInput({
        prompt: 'the hallway beyond the door',
        multi_prompt: [
          { prompt: 'opens the door', duration: 4 },
          { prompt: 'the hallway beyond the door', duration: 6 },
        ],
        start_image_url: 'https://example.com/image.jpg',
      })
    ).toEqual({
      multi_prompt: [
        { prompt: 'opens the door', duration: 4 },
        { prompt: 'the hallway beyond the door', duration: 6 },
      ],
      start_image_url: 'https://example.com/image.jpg',
    });

    const single = { prompt: 'A person walking', duration: '5' };
    expect(klingWireInput(single)).toBe(single);
  });
});

describe('stripPackedKlingPrompt', () => {
  it('removes the prompt the fal adapter copies back onto a packed body', async () => {
    const inner = vi.fn<typeof fetch>(async () => new Response('ok'));
    const fetchImpl = stripPackedKlingPrompt(inner);
    await fetchImpl('https://queue.fal.run/kling/v4/image-to-video', {
      method: 'POST',
      body: JSON.stringify({
        prompt: 'the hallway beyond the door',
        multi_prompt: [{ prompt: 'opens the door', duration: 4 }],
        start_image_url: 'https://example.com/image.jpg',
      }),
    });
    expect(JSON.parse(sentBody(inner))).toEqual({
      multi_prompt: [{ prompt: 'opens the door', duration: 4 }],
      start_image_url: 'https://example.com/image.jpg',
    });
  });

  it('leaves a normal prompt body alone', async () => {
    const inner = vi.fn<typeof fetch>(async () => new Response('ok'));
    const fetchImpl = stripPackedKlingPrompt(inner);
    const raw = JSON.stringify({
      prompt: 'A person walking',
      start_image_url: 'https://example.com/image.jpg',
    });
    await fetchImpl('https://queue.fal.run/kling/v4/image-to-video', {
      method: 'POST',
      body: raw,
    });
    expect(sentBody(inner)).toBe(raw);
  });
});

describe('packed Kling queue body', () => {
  it('reaches fal without prompt after generateVideo copies the longest shot back on', async () => {
    const bodies: unknown[] = [];
    const fetchImpl = stripPackedKlingPrompt(async (_input, init) => {
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ request_id: 'packed-kling-4' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const job = await generateVideo({
      adapter: falVideo('kling/v4/image-to-video', {
        apiKey: 'test-key',
        fetch: fetchImpl,
      }),
      threadId: 'thread-packed-kling',
      prompt: 'the hallway beyond the door',
      modelOptions: {
        multi_prompt: [
          { prompt: 'opens the door', duration: 4 },
          { prompt: 'the hallway beyond the door', duration: 6 },
        ],
        start_image_url: 'https://example.com/image.jpg',
        duration: 10,
      },
    });

    expect(job.jobId).toBe('packed-kling-4');
    expect(bodies[0]).toEqual({
      multi_prompt: [
        { prompt: 'opens the door', duration: 4 },
        { prompt: 'the hallway beyond the door', duration: 6 },
      ],
      start_image_url: 'https://example.com/image.jpg',
      duration: 10,
    });
  });
});
