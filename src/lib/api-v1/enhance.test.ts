import { describe, expect, it } from 'vitest';
import { enhanceSseResponse } from './enhance';

/** Drain an SSE Response body to its decoded text. */
async function readSse(res: Response): Promise<string> {
  return new Response(res.body).text();
}

/** A generator that yields the given deltas, then optionally throws. */
async function* deltas(
  values: string[],
  throwAt?: number
): AsyncGenerator<{ delta: string }> {
  let i = 0;
  for (const delta of values) {
    if (throwAt === i++) throw new Error('mid-stream boom');
    yield { delta };
  }
}

describe('enhanceSseResponse', () => {
  it('streams delta shots then a terminal done shot with the full script', async () => {
    const gen = deltas(['INT. ', 'LIGHTHOUSE', ' - NIGHT  ']);
    const first = await gen.next();
    const res = enhanceSseResponse(first, gen);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe(
      'text/event-stream; charset=utf-8'
    );

    const body = await readSse(res);
    expect(body).toContain('data: {"delta":"INT. "}\n\n');
    expect(body).toContain('data: {"delta":"LIGHTHOUSE"}\n\n');

    // The done shot carries the trimmed, concatenated script plus the HAL
    // affordance catalog every v1 response exposes.
    const doneShot = body
      .split('\n\n')
      .find((shot) => shot.startsWith('event: done'));
    expect(doneShot).toBeDefined();
    const donePayload = JSON.parse(
      (doneShot ?? '').replace('event: done\ndata: ', '')
    );
    expect(donePayload.enhancedScript).toBe('INT. LIGHTHOUSE - NIGHT');
    expect(donePayload._links.self.href).toBe('/api/v1/scripts/enhance');
    expect(donePayload._links.root.href).toBe('/api/v1');
    const createLink = donePayload._links['create-sequence'];
    expect(createLink.href).toBe('/api/v1/sequences');
    expect(createLink.method).toBe('POST');
    expect(createLink.contentType).toBe('application/json');
    // The create affordance is ready-to-POST: it embeds the enhanced script
    // with enhancement disabled (the script is already enhanced).
    expect(createLink.examples).toEqual([
      { script: 'INT. LIGHTHOUSE - NIGHT', enhance: 'off' },
    ]);
  });

  it('resets the accumulated script on a replace chunk and includes duration on done', async () => {
    async function* gen(): AsyncGenerator<{
      delta: string;
      replace?: boolean;
    }> {
      yield { delta: 'Scene 1 — 5s\nToo long.\n' };
      yield { delta: 'Scene 1 — 6s\nJust right.', replace: true };
    }
    const stream = gen();
    const first = await stream.next();
    const body = await readSse(
      enhanceSseResponse(first, stream, {
        targetSeconds: 6,
        videoModel: 'ltx_2_3_pro',
      })
    );
    expect(body).toContain('event: replace');
    const doneShot = body
      .split('\n\n')
      .find((shot) => shot.startsWith('event: done'));
    const donePayload = JSON.parse(
      (doneShot ?? '').replace('event: done\ndata: ', '')
    );
    expect(donePayload.enhancedScript).toBe('Scene 1 — 6s\nJust right.');
    expect(donePayload.duration.snappedSeconds).toBe(6);
    expect(donePayload.duration.message).toBeNull();
  });

  it('emits an error shot when the generator fails mid-stream', async () => {
    const gen = deltas(['partial ', 'never'], 1); // yields one delta, then throws
    const first = await gen.next();
    const body = await readSse(enhanceSseResponse(first, gen));

    expect(body).toContain('data: {"delta":"partial "}\n\n');
    expect(body).toContain('event: error');
    expect(body).not.toContain('event: done');
  });
});
