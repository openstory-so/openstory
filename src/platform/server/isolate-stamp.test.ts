import { describe, expect, it } from 'vitest';
import {
  isolateId,
  isolateStampMessage,
  requestRouteClass,
} from './isolate-stamp';

const SEQUENCE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TEAM_ID = '01KJRCQMN7K8RP6NPV37MC7XYS';
const SHOT_ID = '01M3JFQ9GX8ST6Y1VM6FCNSAKJ';

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
    ).toBe('r2');
  });

  it('returns unknown for a url that cannot be parsed', () => {
    expect(requestRouteClass('not a url')).toBe('unknown');
  });
});

describe('isolateStampMessage', () => {
  it('keeps the isolate id and the route class, and drops path ids', () => {
    const url = `https://openstory.so/sequences/${SEQUENCE_ID}/scenes?shot=${SHOT_ID}`;
    const message = isolateStampMessage(requestRouteClass(url));

    expect(message).toBe(`[isolate] ${isolateId} /sequences/:id/scenes`);
    expect(message).not.toContain(SEQUENCE_ID);
    expect(message).not.toContain(SHOT_ID);
  });

  it('does not copy a realtime channel id into the message', () => {
    const url = `https://openstory.so/api/realtime?channels=${encodeURIComponent(`billing:${TEAM_ID}`)}`;
    const message = isolateStampMessage(requestRouteClass(url));

    expect(message).toBe(`[isolate] ${isolateId} realtime-billing`);
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
