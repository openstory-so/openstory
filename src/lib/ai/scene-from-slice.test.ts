import { describe, expect, it } from 'vitest';
import {
  buildSceneFromSlice,
  extractDialogueFromSlice,
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
