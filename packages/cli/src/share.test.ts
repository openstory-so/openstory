import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServedCut } from '@openstory/stitch/bundle';
import { describe, expect, it } from 'vitest';

import { shareCut } from './share.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** The cut stitch builds for `board.png --audio line.wav shot.mp4 --music line.wav`. */
async function cutIn(cwd: string): Promise<ServedCut> {
  await writeFile(join(cwd, 'board.png'), png);
  await writeFile(join(cwd, 'line.wav'), 'line');
  await writeFile(join(cwd, 'shot.mp4'), 'video');
  return {
    clips: [
      {
        imageUrl: 'media/0.png',
        fallbackImageUrl: null,
        durationSeconds: 4,
        audioUrls: ['media/1.wav'],
        width: 1,
        height: 1,
        cues: [],
      },
      { videoUrl: 'media/2.mp4', posterUrl: null, cues: [] },
    ],
    frameWidth: 1,
    frameHeight: 1,
    musicUrl: 'media/1.wav',
    musicGainDb: 0,
    files: new Map([
      ['0', join(cwd, 'board.png')],
      ['1', join(cwd, 'line.wav')],
      ['2', join(cwd, 'shot.mp4')],
    ]),
  };
}

describe('openstory share', () => {
  function fakeOpenStory(options: {
    approvedAfter: number;
    reject?: boolean;
    realPerson?: boolean;
  }) {
    const calls: { method: string; url: string; type: string | null }[] = [];
    const published: unknown[] = [];
    let polls = 0;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      calls.push({
        method,
        url: url.pathname + url.search,
        type: headers.get('content-type'),
      });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status });
      if (url.pathname === '/api/v1/device/code') {
        return json(
          {
            device_code: 'dev',
            user_code: 'ABCD-1234',
            verification_url_complete: `${url.origin}/device?user_code=ABCD-1234`,
            interval: 0,
          },
          201
        );
      }
      if (url.pathname === '/api/v1/device/token') {
        polls += 1;
        if (polls <= options.approvedAfter) {
          return json({ error: 'authorization_pending' }, 428);
        }
        return json({
          api_key: 'osk_1',
          organization: { id: 't', name: 'T' },
        });
      }
      if (headers.get('authorization') !== 'Bearer osk_1' || options.reject) {
        return json({ error: { message: 'bad key' } }, 401);
      }
      if (url.pathname === '/api/v1/stitches' && method === 'POST') {
        expect(typeof init?.body === 'string' ? init.body : '').toContain(
          '"imageUrl":"media/0.png"'
        );
        return json(
          {
            id: 'S1',
            url: `${url.origin}/stitch/S1`,
            _links: {
              upload: {
                href: '/api/storage/upload?bucket=stitches&path=organization/S1/{name}&contentType={type}',
                method: 'PUT',
                templated: true,
              },
              publish: {
                href: '/api/v1/stitches/S1/publish',
                method: 'POST',
              },
            },
          },
          201
        );
      }
      if (url.pathname === '/api/v1/stitches/S1/publish' && method === 'POST') {
        const body = typeof init?.body === 'string' ? init.body : '';
        published.push(JSON.parse(body));
        if (options.realPerson && !body.includes('authorizationBasis')) {
          return json(
            {
              error: {
                code: 'ATTESTATION_REQUIRED',
                message: 'Send portraitAttestation to publish this still.',
              },
            },
            400
          );
        }
        return json({ id: 'S1', url: `${url.origin}/stitch/S1` });
      }
      if (url.pathname === '/api/storage/upload' && method === 'PUT') {
        return json({ success: true });
      }
      return json({ error: 'not found' }, 404);
    };
    return { fetchFn, calls, published };
  }

  it('signs in once, uploads every file, and prints the link', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openstory-share-'));
    try {
      const cut = await cutIn(cwd);
      const home = join(cwd, 'home');
      const opened: string[] = [];
      const stderr: string[] = [];
      const first = fakeOpenStory({ approvedAfter: 1 });
      const url = await shareCut({
        cut,
        origin: 'https://os.test',
        portraitRights: null,
        home,
        stderr: { write: (t) => stderr.push(t) },
        open: (u) => opened.push(u),
        fetch: first.fetchFn,
      });
      expect(url).toBe('https://os.test/stitch/S1');
      expect(opened).toEqual(['https://os.test/device?user_code=ABCD-1234']);
      expect(stderr.join('')).toContain('ABCD-1234');
      expect(first.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        'POST /api/v1/device/code',
        'GET /api/v1/device/token?device_code=dev&wait=60s',
        'GET /api/v1/device/token?device_code=dev&wait=60s',
        'POST /api/v1/stitches',
        'PUT /api/storage/upload?bucket=stitches&path=organization/S1/0.png&contentType=image%2Fpng',
        'PUT /api/storage/upload?bucket=stitches&path=organization/S1/1.wav&contentType=audio%2Fwav',
        'PUT /api/storage/upload?bucket=stitches&path=organization/S1/2.mp4&contentType=video%2Fmp4',
        'POST /api/v1/stitches/S1/publish',
      ]);
      expect(first.calls[6]?.type).toBe('video/mp4');
      const stored = JSON.parse(
        await readFile(join(home, '.openstory', 'credentials.json'), 'utf8')
      );
      expect(stored.keys['https://os.test']).toBe('osk_1');

      // The second share reuses the key: no sign-in.
      const second = fakeOpenStory({ approvedAfter: 0 });
      await shareCut({
        cut,
        origin: 'https://os.test',
        portraitRights: null,
        home,
        stderr: { write: () => {} },
        open: () => {},
        fetch: second.fetchFn,
      });
      expect(second.calls[0]).toMatchObject({ url: '/api/v1/stitches' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('signs in again when the stored key is refused, then stops', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openstory-share-'));
    try {
      const cut = await cutIn(cwd);
      const home = join(cwd, 'home');
      await mkdir(join(home, '.openstory'), { recursive: true });
      await writeFile(
        join(home, '.openstory', 'credentials.json'),
        JSON.stringify({ keys: { 'https://os.test': 'osk_old' } })
      );
      const fake = fakeOpenStory({ approvedAfter: 0 });
      const url = await shareCut({
        cut,
        origin: 'https://os.test',
        portraitRights: null,
        home,
        stderr: { write: () => {} },
        open: () => {},
        fetch: fake.fetchFn,
      });
      expect(url).toBe('https://os.test/stitch/S1');
      expect(fake.calls.map((c) => c.url)).toContain('/api/v1/device/code');

      const rejecting = fakeOpenStory({ approvedAfter: 0, reject: true });
      await expect(
        shareCut({
          cut,
          origin: 'https://os.test',
          portraitRights: null,
          home,
          stderr: { write: () => {} },
          open: () => {},
          fetch: rejecting.fetchFn,
        })
      ).rejects.toThrow('refused the key');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('sends --portrait-rights to publish, and names the flag when a still is a person', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openstory-share-'));
    try {
      const cut = await cutIn(cwd);
      const home = join(cwd, 'home');
      const io = { home, stderr: { write: () => {} }, open: () => {} };
      const refusing = fakeOpenStory({ approvedAfter: 0, realPerson: true });
      await expect(
        shareCut({
          cut,
          origin: 'https://os.test',
          portraitRights: null,
          ...io,
          fetch: refusing.fetchFn,
        })
      ).rejects.toThrow('--portrait-rights <basis>');

      const signed = fakeOpenStory({ approvedAfter: 0, realPerson: true });
      await shareCut({
        cut,
        origin: 'https://os.test',
        portraitRights: 'self',
        ...io,
        fetch: signed.fetchFn,
      });
      expect(signed.published).toEqual([
        {
          portraitAttestation: {
            statementVersion: 'portrait-rights-v1',
            authorizationBasis: 'self',
          },
        },
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('refuses a file the shared player cannot play before talking to the server', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openstory-share-'));
    try {
      // A signed URL with no extension would be named media/0, which the
      // server cannot type: refused here, with the file named.
      const cut = {
        ...(await cutIn(cwd)),
        files: new Map([['0', 'https://cdn.test/still?sig=1']]),
      };
      const fake = fakeOpenStory({ approvedAfter: 0 });
      await expect(
        shareCut({
          cut,
          origin: 'https://os.test',
          portraitRights: null,
          home: join(cwd, 'home'),
          stderr: { write: () => {} },
          open: () => {},
          fetch: fake.fetchFn,
        })
      ).rejects.toThrow('https://cdn.test/still?sig=1 has no file extension');
      expect(fake.calls).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
