import { describe, expect, it } from 'vitest';
import {
  buildSceneFromSlice,
  estimateUnlabelledScriptSeconds,
  extractDialogueFromSlice,
  filmableSlices,
  inheritMissingLocation,
  parseSceneHeading,
} from './scene-from-slice';

const OFFICE = [
  'INT. OFFICE - DAY',
  '',
  'Sarah sits at her desk, typing furiously.',
  '',
  'SARAH',
  "I can't believe this is happening.",
  '',
].join('\n');

const PARKING_LOT = [
  '           PADUA HIGH PARKING LOT - DAY',
  '           ',
  '           KAT STRATFORD, eighteen, pretty -- but trying hard not to be',
  '           -- in a baggy granny dress and glasses, balances a cup of',
  '           coffee and a backpack as she climbs out of her battered,',
  "           baby blue '75 Dodge Dart.",
  '           ',
  '           A stray SKATEBOARD clips her.',
  '           ',
  '                                  RIDER',
  '                     Hey -- sorry.',
  '           ',
  '           Cowering in fear, he attempts to scoop up her scattered',
  '           belongings.',
  '           ',
  '                                  KAT',
  '                     Leave it',
  '           ',
  '           He persists.',
  '           ',
  '                                  KAT (continuing)',
  '                     I said, leave it!',
].join('\n');

describe('parseSceneHeading', () => {
  it('parses INT./EXT. headings', () => {
    expect(parseSceneHeading('INT. OFFICE - DAY')).toEqual({
      title: 'OFFICE',
      location: 'INT. OFFICE - DAY',
      timeOfDay: 'day',
    });
    expect(parseSceneHeading("EXT. GIRLS' ROOM - NIGHT")).toEqual({
      title: "GIRLS' ROOM",
      location: "EXT. GIRLS' ROOM - NIGHT",
      timeOfDay: 'night',
    });
  });

  it('parses location lines that only carry a time suffix', () => {
    expect(parseSceneHeading('PADUA HIGH PARKING LOT - DAY')).toEqual({
      title: 'PADUA HIGH PARKING LOT',
      location: 'PADUA HIGH PARKING LOT - DAY',
      timeOfDay: 'day',
    });
  });

  it('parses EARLY/LATE modifiers on the time of day', () => {
    expect(
      parseSceneHeading('EXT. BONDI BEACH CAR PARK - EARLY MORNING')
    ).toEqual({
      title: 'BONDI BEACH CAR PARK',
      location: 'EXT. BONDI BEACH CAR PARK - EARLY MORNING',
      timeOfDay: 'early morning',
    });
  });

  it('falls back to the first line when there is no heading', () => {
    expect(parseSceneHeading('Sarah sits at her desk.')).toEqual({
      title: 'Sarah sits at her desk.',
      location: '',
      timeOfDay: '',
    });
  });

  it('strips markdown from a derived title', () => {
    expect(parseSceneHeading('**INT. OFFICE - DAY**')).toEqual({
      title: 'OFFICE',
      location: 'INT. OFFICE - DAY',
      timeOfDay: 'day',
    });
    expect(parseSceneHeading('## The Reveal')).toEqual({
      title: 'The Reveal',
      location: '',
      timeOfDay: '',
    });
  });
});

describe('extractDialogueFromSlice', () => {
  it('extracts left-aligned screenplay cues', () => {
    expect(extractDialogueFromSlice(OFFICE)).toEqual([
      {
        character: 'SARAH',
        line: "I can't believe this is happening.",
        tone: '',
      },
    ]);
  });

  it('extracts indented cues, strips (continuing), skips action', () => {
    expect(extractDialogueFromSlice(PARKING_LOT)).toEqual([
      { character: 'RIDER', line: 'Hey -- sorry.', tone: '' },
      { character: 'KAT', line: 'Leave it', tone: '' },
      { character: 'KAT', line: 'I said, leave it!', tone: '' },
    ]);
  });

  it('extracts inline CHARACTER: line', () => {
    expect(extractDialogueFromSlice('JACK: We ship tonight.')).toEqual([
      { character: 'JACK', line: 'We ship tonight.', tone: '' },
    ]);
  });

  it('does not treat scene headings as character cues', () => {
    expect(
      extractDialogueFromSlice('INT. OFFICE - DAY\n\nSarah types.')
    ).toEqual([]);
  });
});

describe('buildSceneFromSlice', () => {
  it('fills metadata and dialogue from the verbatim slice', () => {
    const scene = buildSceneFromSlice('scene_1', 0, OFFICE);
    expect(scene.sceneId).toBe('scene_1');
    expect(scene.sceneNumber).toBe(1);
    expect(scene.originalScript.extract).toBe(OFFICE);
    expect(scene.originalScript.dialogue).toHaveLength(1);
    expect(scene.metadata.title).toBe('OFFICE');
    expect(scene.metadata.location).toBe('INT. OFFICE - DAY');
    expect(scene.metadata.timeOfDay).toBe('day');
    expect(scene.metadata.storyBeat).toBe('');
    expect(scene.metadata.durationSeconds).toBeGreaterThanOrEqual(3);
    expect(scene.continuity.characterTags).toEqual([]);
  });

  it('skips enhancer duration labels and reads the seconds from them', () => {
    const slice = [
      'Scene 1 — 5s',
      'EXT. BONDI BEACH CAR PARK - EARLY MORNING',
      'A tote slams onto the bonnet.',
    ].join('\n');
    const scene = buildSceneFromSlice('scene_1', 0, slice);
    expect(scene.metadata.title).toBe('BONDI BEACH CAR PARK');
    expect(scene.metadata.location).toBe(
      'EXT. BONDI BEACH CAR PARK - EARLY MORNING'
    );
    expect(scene.metadata.timeOfDay).toBe('early morning');
    expect(scene.metadata.durationSeconds).toBe(5);
  });

  it('keeps the scene total; a stray "Shot N — Xs" line is just prose now (#1621)', () => {
    const slice = [
      'Scene 1 — 10s',
      'INT. HALLWAY - NIGHT',
      'Shot 1 — 4s',
      'She opens the door.',
      'Shot 2 — 6s',
      'Cut to the hallway beyond.',
    ].join('\n');
    const scene = buildSceneFromSlice('scene_1', 0, slice);
    expect(scene.metadata.title).toBe('HALLWAY');
    expect(scene.metadata.durationSeconds).toBe(10);
    expect('shotLabelSeconds' in scene).toBe(false);
  });

  it('no scene label and only stray shot-shaped lines: those lines are action, not durations (#1621)', () => {
    // Slugline is free. The four remaining lines are 13 action words at six
    // a second, which rounds under the 3s floor. The "4s" / "6s" are not read.
    const scene = buildSceneFromSlice(
      'scene_1',
      0,
      'INT. HALLWAY - NIGHT\nShot 1 — 4s\nShe opens the door.\nShot 2 — 6s\nBeyond.'
    );
    expect(scene.metadata.durationSeconds).toBe(3);
  });

  it('unlabelled scene length is its word count at three words a second, uncapped (#1593)', () => {
    const page = Array.from(
      { length: 30 },
      () => 'She walks the long hall.'
    ).join('\n');
    // 150 words → 50s; the old 10s ceiling made every pasted feature scene one shot.
    expect(
      buildSceneFromSlice('scene_1', 0, page).metadata.durationSeconds
    ).toBe(50);
    expect(
      buildSceneFromSlice('scene_1', 0, 'Dawn.').metadata.durationSeconds
    ).toBe(3);
  });

  it('has no shotLabelSeconds when the slice is unlabelled', () => {
    const scene = buildSceneFromSlice('scene_1', 0, 'A man walks in.');
    expect('shotLabelSeconds' in scene).toBe(false);
  });

  it('drops front matter and times a dialogue-light scene below its raw word count (#2077)', () => {
    const front = [
      'THE RAIN SHIFT',
      'Episode 4',
      'A format note: keep it quiet.',
      '',
      'CHARACTERS',
      'SARAH — a detective who has not slept.',
      'JOHN — her partner, always early.',
    ].join('\n');
    const light = [
      'INT. KITCHEN - NIGHT',
      '',
      'Sarah fills the kettle and watches rain streak the dark window, the street below empty, the clock over the stove stuck at a minute she does not trust.',
      '',
      'SARAH',
      'Tea?',
      '',
      'JOHN',
      'Please.',
    ].join('\n');
    const next = ['EXT. STREET - NIGHT', '', 'They step into the rain.'].join(
      '\n'
    );
    const script = [front, '', light, '', next].join('\n');
    // The boundary call pinned the title page to slice 1 and opened the
    // street scene at its heading — the same cut that used to film the
    // character list.
    const slices = filmableSlices(script, [
      0,
      script.indexOf('EXT. STREET - NIGHT'),
    ]);

    expect(slices).toHaveLength(2);
    expect(slices[0]?.startsWith('INT. KITCHEN - NIGHT')).toBe(true);
    expect(slices.join('')).not.toContain('CHARACTERS');
    expect(slices.join('')).not.toContain('THE RAIN SHIFT');

    const scene = buildSceneFromSlice('kitchen', 0, slices[0] ?? '');
    const rawWords = (slices[0] ?? '').split(/\s+/).filter(Boolean).length;
    expect(scene.metadata.durationSeconds).toBeLessThan(
      Math.round(rawWords / 3)
    );
    expect(scene.metadata.location).toBe('INT. KITCHEN - NIGHT');
    expect(scene.metadata.durationSeconds).toBe(6);

    const body = [light, '', next].join('\n');
    expect(estimateUnlabelledScriptSeconds(script)).toBe(
      estimateUnlabelledScriptSeconds(body)
    );
  });

  it('keeps a prose split with no scene heading, timed as its word count (#2077)', () => {
    const prose = 'She walks in and sits.\n\nHe looks up from the paper.';
    const cut = prose.indexOf('He looks');
    expect(filmableSlices(prose, [0, cut])).toEqual([
      prose.slice(0, cut),
      prose.slice(cut),
    ]);
    expect(
      buildSceneFromSlice('scene_1', 0, prose).metadata.durationSeconds
    ).toBe(Math.round(prose.split(/\s+/).filter(Boolean).length / 3));
  });
});

describe('inheritMissingLocation', () => {
  it('copies location and time from the previous scene when the slice has no heading', () => {
    const first = buildSceneFromSlice(
      's1',
      0,
      'EXT. BONDI BEACH CAR PARK - EARLY MORNING\nA tote slams down.'
    );
    const second = inheritMissingLocation(
      buildSceneFromSlice('s2', 1, 'She leans into the wing mirror.'),
      first
    );
    expect(second.metadata.location).toBe(
      'EXT. BONDI BEACH CAR PARK - EARLY MORNING'
    );
    expect(second.metadata.timeOfDay).toBe('early morning');
    expect(second.metadata.title).toBe('She leans into the wing mirror.');
  });
});
