import { describe, expect, it } from 'vitest';
import {
  createStreamingSceneParser,
  stripCodeFences,
} from './streaming-scene-parser';

const script = [
  'INT. OFFICE - DAY',
  '',
  'Sarah sits at her desk, typing furiously.',
  '',
  'SARAH',
  "I can't believe this is happening.",
  '',
  'EXT. PARKING LOT - NIGHT',
  '',
  'Sarah walks to her car, looking over her shoulder.',
  '',
  'INT. CAR - CONTINUOUS',
  '',
  'She locks the doors and starts the engine.',
].join('\n');

const boundaries = [
  { hintLine: 1, quote: 'INT. OFFICE - DAY' },
  { hintLine: 8, quote: 'EXT. PARKING LOT - NIGHT' },
  { hintLine: 12, quote: 'INT. CAR - CONTINUOUS' },
];

const fullResponse = {
  projectMetadata: { title: 'Test Film' },
  boundaries,
};

function makeParser() {
  let n = 0;
  return createStreamingSceneParser(script, () => `scene-id-${++n}`);
}

describe('createStreamingSceneParser', () => {
  it('emits the title once, as soon as it appears', () => {
    const parser = makeParser();
    const partial = '{"projectMetadata": {"title": "Test Film"}, "bound';
    const events = parser.feed(partial);
    expect(events).toEqual([{ type: 'title', title: 'Test Film' }]);
    expect(parser.feed(partial)).toEqual([]);
  });

  it('finalizes scene k when boundary k+1 has settled', () => {
    const parser = makeParser();
    const json = JSON.stringify(fullResponse);
    const cut = json.indexOf('INT. CAR') + 4;
    const events = parser.feed(json.slice(0, cut));
    const sceneEvents = events.filter((e) => e.type === 'scene');
    expect(sceneEvents).toHaveLength(1);
    const [first] = sceneEvents;
    expect(first?.scene.sceneId).toBe('scene-id-1');
    expect(first?.scene.sceneNumber).toBe(1);
    expect(first?.scene.originalScript.extract).toBe(
      script.slice(0, script.indexOf('EXT. PARKING LOT'))
    );
    expect(first?.scene.metadata.title).toBe('OFFICE');
    expect(first?.scene.metadata.location).toBe('INT. OFFICE - DAY');
    expect(first?.scene.originalScript.dialogue).toEqual([
      {
        character: 'SARAH',
        line: "I can't believe this is happening.",
        tone: '',
      },
    ]);
  });

  it('inherits location onto a continuation slice with no slugline', () => {
    const continuation = [
      'EXT. BONDI BEACH CAR PARK - EARLY MORNING',
      'A tote slams onto the bonnet.',
      '',
      'She leans into the wing mirror.',
    ].join('\n');
    const parser = createStreamingSceneParser(
      continuation,
      (() => {
        let n = 0;
        return () => `id-${++n}`;
      })()
    );
    const events = parser.feed(
      JSON.stringify({
        projectMetadata: { title: 'Bondi' },
        boundaries: [
          { hintLine: 1, quote: 'EXT. BONDI BEACH CAR PARK - EARLY MORNING' },
          { hintLine: 4, quote: 'She leans into the wing mirror.' },
        ],
      }),
      true
    );
    const sceneEvents = events.filter((e) => e.type === 'scene');
    expect(sceneEvents[1]?.scene.metadata.location).toBe(
      'EXT. BONDI BEACH CAR PARK - EARLY MORNING'
    );
    expect(sceneEvents[1]?.scene.metadata.timeOfDay).toBe('early morning');
  });

  it('finalizes every scene on the done feed', () => {
    const parser = makeParser();
    const events = parser.feed(JSON.stringify(fullResponse), true);
    const sceneEvents = events.filter((e) => e.type === 'scene');
    expect(sceneEvents).toHaveLength(3);
    const extracts = sceneEvents.map((e) => e.scene.originalScript.extract);
    expect(extracts.join('')).toBe(script);
    expect(sceneEvents.map((e) => e.scene.metadata.title)).toEqual([
      'OFFICE',
      'PARKING LOT',
      'CAR',
    ]);
  });

  it('emits only title and scene events', () => {
    const parser = makeParser();
    const events = parser.feed(JSON.stringify(fullResponse), true);
    expect(events.map((e) => e.type)).toEqual([
      'title',
      'scene',
      'scene',
      'scene',
    ]);
  });

  it('drops an unresolvable boundary — the scene merges into its predecessor', () => {
    const parser = makeParser();
    const response = {
      ...fullResponse,
      boundaries: [
        boundaries[0],
        { hintLine: 8, quote: 'THIS TEXT EXISTS NOWHERE IN THE SCRIPT' },
        boundaries[2],
      ],
    };
    const events = parser.feed(JSON.stringify(response), true);
    const sceneEvents = events.filter((e) => e.type === 'scene');
    expect(sceneEvents).toHaveLength(2);
    expect(
      sceneEvents.map((e) => e.scene.originalScript.extract).join('')
    ).toBe(script);
    expect(sceneEvents[1]?.scene.originalScript.extract).toBe(
      script.slice(script.indexOf('INT. CAR'))
    );
    expect(sceneEvents[1]?.scene.metadata.title).toBe('CAR');
  });

  it('anchors quotes tolerantly (smart quotes / whitespace drift)', () => {
    const parser = makeParser();
    const response = {
      ...fullResponse,
      boundaries: [
        boundaries[0],
        { hintLine: 8, quote: 'EXT. PARKING LOT – NIGHT' },
        boundaries[2],
      ],
    };
    const events = parser.feed(JSON.stringify(response), true);
    const sceneEvents = events.filter((e) => e.type === 'scene');
    expect(sceneEvents).toHaveLength(3);
    expect(
      sceneEvents.map((e) => e.scene.originalScript.extract).join('')
    ).toBe(script);
  });

  it('handles responses wrapped in code fences', () => {
    const parser = makeParser();
    const fenced = '```json\n' + JSON.stringify(fullResponse) + '\n```';
    const events = parser.feed(fenced, true);
    expect(events.filter((e) => e.type === 'scene')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'title')).toHaveLength(1);
  });

  it('returns no events for non-JSON garbage', () => {
    const parser = makeParser();
    expect(parser.feed('The scenes are as follows:')).toEqual([]);
  });
});

describe('stripCodeFences', () => {
  it('strips ```json fences', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('strips bare ``` fences', () => {
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('leaves unfenced text alone', () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
  });
});
