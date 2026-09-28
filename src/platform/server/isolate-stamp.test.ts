import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ROUTE_FULL_PATHS,
  getIsolateId,
  isolateStampMessage,
  requestRouteClass,
} from './isolate-stamp';

const SEQUENCE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TEAM_ID = '01KJRCQMN7K8RP6NPV37MC7XYS';
const SHOT_ID = '01M3JFQ9GX8ST6Y1VM6FCNSAKJ';
const GIFT_CODE = 'ABC123';

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

function fullPathsFromRouteTree(): string[] {
  const text = readFileSync(
    resolve(__dirname, '../../routeTree.gen.ts'),
    'utf8'
  );
  return [
    ...new Set(
      [...text.matchAll(/fullPath: '([^']*)'/g)].map((match) =>
        normalizePath(match[1] ?? '')
      )
    ),
  ].sort();
}

/** Fill `$param` with a non-ULID token and a splat with two segments. */
function fillTemplate(fullPath: string): {
  pathname: string;
  expected: string;
} {
  const pathSegments: string[] = [];
  const expectedSegments: string[] = [];
  for (const segment of fullPath.split('/').filter((part) => part.length > 0)) {
    if (segment === '$') {
      pathSegments.push(GIFT_CODE, 'more');
      expectedSegments.push('*');
      break;
    }
    if (segment.startsWith('$')) {
      pathSegments.push(GIFT_CODE);
      expectedSegments.push(`:${segment.slice(1)}`);
    } else {
      pathSegments.push(segment);
      expectedSegments.push(segment);
    }
  }
  return {
    pathname: `/${pathSegments.join('/')}`,
    expected: `/${expectedSegments.join('/')}`,
  };
}

describe('requestRouteClass', () => {
  it('classifies the pages and streams that show up on memory deaths', () => {
    expect(requestRouteClass('https://openstory.so/')).toBe('home');
    expect(
      requestRouteClass('https://openstory.so/?utm_source=web-note.cn')
    ).toBe('home');
    expect(requestRouteClass('https://openstory.so/sequences')).toBe(
      '/sequences'
    );
    expect(
      requestRouteClass(
        `https://openstory.so/sequences/${SEQUENCE_ID}/scenes?shot=${SHOT_ID}`
      )
    ).toBe('/sequences/:id/scenes');
    expect(
      requestRouteClass(
        `https://openstory.so/sequences/${GIFT_CODE}/scenes?shot=${SHOT_ID}`
      )
    ).toBe('/sequences/:id/scenes');
    expect(requestRouteClass(`https://openstory.so/gift/${GIFT_CODE}`)).toBe(
      '/gift/:code'
    );
    expect(
      requestRouteClass(
        `https://openstory.so/api/realtime?channels=${encodeURIComponent(`billing:${TEAM_ID}`)}`
      )
    ).toBe('realtime-billing');
    expect(
      requestRouteClass(
        `https://openstory.so/api/realtime?channels=${encodeURIComponent(`${SEQUENCE_ID},shot-prompt:${SHOT_ID}`)}`
      )
    ).toBe('realtime-shot');
    expect(
      requestRouteClass(
        `https://openstory.so/api/realtime?channels=${encodeURIComponent(SEQUENCE_ID)}`
      )
    ).toBe('realtime-other');
    expect(
      requestRouteClass(
        `https://openstory.so/api/realtime?channels=${encodeURIComponent(`billing:${TEAM_ID},shot-prompt:${SHOT_ID}`)}`
      )
    ).toBe('realtime-mixed');
    expect(
      requestRouteClass(
        `https://openstory.so/_serverFn/abcdef?sequenceIds=${SEQUENCE_ID}`
      )
    ).toBe('serverFn');
    expect(requestRouteClass('https://openstory.so/assets/index-abc.js')).toBe(
      'asset'
    );
    expect(
      requestRouteClass(
        `https://openstory.so/r2/teams/${TEAM_ID}/studio/${SHOT_ID}/image.png`
      )
    ).toBe('/r2/*');
  });

  it('keeps a static route ahead of a splat that would swallow it', () => {
    expect(requestRouteClass('https://openstory.so/docs/faq')).toBe(
      '/docs/faq'
    );
    expect(requestRouteClass('https://openstory.so/docs/guide/intro')).toBe(
      '/docs/*'
    );
    expect(
      requestRouteClass('https://openstory.so/models/family/seedance')
    ).toBe('/models/family/*');
  });

  it('returns unknown for a url that cannot be parsed', () => {
    expect(requestRouteClass('not a url')).toBe('unknown');
  });

  it('lists every file-route path from the generated route tree', () => {
    expect([...ROUTE_FULL_PATHS].sort()).toEqual(fullPathsFromRouteTree());
  });

  it('templates every dynamic file route, including non-ULID params', () => {
    for (const fullPath of ROUTE_FULL_PATHS) {
      if (!fullPath.includes('$')) continue;
      const { pathname, expected } = fillTemplate(fullPath);
      const routeClass = requestRouteClass(`https://openstory.so${pathname}`);
      expect(routeClass, fullPath).toBe(expected);
      expect(routeClass, fullPath).not.toContain(GIFT_CODE);
    }
  });
});

describe('isolateStampMessage', () => {
  it('keeps the isolate id and the route class, and drops path ids', () => {
    const url = `https://openstory.so/gift/${GIFT_CODE}`;
    const message = isolateStampMessage(requestRouteClass(url));

    expect(message).toBe(`[isolate] ${getIsolateId()} /gift/:code`);
    expect(message).not.toContain(GIFT_CODE);
    expect(message).not.toContain(SEQUENCE_ID);
  });

  it('does not copy a realtime channel id into the message', () => {
    const url = `https://openstory.so/api/realtime?channels=${encodeURIComponent(`billing:${TEAM_ID}`)}`;
    const message = isolateStampMessage(requestRouteClass(url));

    expect(message).toBe(`[isolate] ${getIsolateId()} realtime-billing`);
    expect(message).not.toContain(TEAM_ID);
  });

  it('uses the same isolate id on every call', () => {
    const home = isolateStampMessage('home');
    const serverFn = isolateStampMessage('serverFn');
    expect(home.slice(0, home.lastIndexOf(' '))).toBe(
      serverFn.slice(0, serverFn.lastIndexOf(' '))
    );
  });
});

describe('getIsolateId', () => {
  it('mints the id on the first call, not when the module loads', async () => {
    vi.resetModules();
    const randomUUID = vi.spyOn(crypto, 'randomUUID');
    const loaded = await import('./isolate-stamp');

    expect(randomUUID).not.toHaveBeenCalled();
    const first = loaded.getIsolateId();
    expect(loaded.getIsolateId()).toBe(first);
    expect(randomUUID).toHaveBeenCalledOnce();
    randomUUID.mockRestore();
  });
});
