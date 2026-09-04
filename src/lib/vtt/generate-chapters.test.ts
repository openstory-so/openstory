import type { SceneRow } from '@/lib/db/schema';
import type { Shot } from '@/types/database';
import { describe, expect, test } from 'vitest';
import { generateChaptersVTT, type ShotChapter } from './generate-chapters';

// Helper to create test shots with minimal required fields
const createTestShot = (overrides: Partial<Shot>): Shot => ({
  id: '1',
  sequenceId: 'seq-1',
  sceneId: null,
  shotNumber: 1,
  durationMs: 3000,
  useStartFrame: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  selectedMotionPromptVersionId: null,
  renderSegmentId: null,
  deletedAt: null,
  ...overrides,
});

const scene = (
  orderIndex: number,
  title: string
): Pick<SceneRow, 'title' | 'orderIndex'> => ({ orderIndex, title });

const chapter = (
  shot: Partial<Shot>,
  sceneRow: Pick<SceneRow, 'title' | 'orderIndex'> | null = null
): ShotChapter => ({ shot: createTestShot(shot), scene: sceneRow });

describe('generateChaptersVTT', () => {
  test('generates valid WebVTT chapters with metadata', () => {
    const chapters: ShotChapter[] = [
      chapter({ id: '1', durationMs: 5000 }, scene(0, 'Opening Scene')),
      chapter({ id: '2', durationMs: 3000 }, scene(1, 'Conflict Arises')),
    ];

    const vtt = generateChaptersVTT(chapters);

    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('Scene 1: Opening Scene');
    expect(vtt).toContain('Scene 2: Conflict Arises');
    expect(vtt).toContain('00:00:00.000 --> 00:00:05.000');
    expect(vtt).toContain('00:00:05.000 --> 00:00:08.000');
  });

  test('handles shots without a scene', () => {
    const chapters: ShotChapter[] = [
      chapter({ id: '1', durationMs: 3000 }),
      chapter({ id: '2', durationMs: 2000 }),
    ];

    const vtt = generateChaptersVTT(chapters);

    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('Scene 1');
    expect(vtt).toContain('Scene 2');
  });

  test('defaults to 3 seconds when durationMs is null', () => {
    const vtt = generateChaptersVTT([chapter({ durationMs: null })]);

    expect(vtt).toContain('00:00:00.000 --> 00:00:03.000');
  });

  test('calculates cumulative time correctly', () => {
    const chapters: ShotChapter[] = [
      chapter({ id: '1', durationMs: 5000 }),
      chapter({ id: '2', durationMs: 7000 }),
      chapter({ id: '3', durationMs: 4000 }),
    ];

    const vtt = generateChaptersVTT(chapters);

    // First chapter: 0-5 seconds
    expect(vtt).toContain('00:00:00.000 --> 00:00:05.000');
    // Second chapter: 5-12 seconds
    expect(vtt).toContain('00:00:05.000 --> 00:00:12.000');
    // Third chapter: 12-16 seconds
    expect(vtt).toContain('00:00:12.000 --> 00:00:16.000');
  });

  test('formats timestamps correctly for hours', () => {
    const chapters: ShotChapter[] = [
      chapter({ id: '1', durationMs: 3600000 }),
      chapter({ id: '2', durationMs: 125000 }),
    ];

    const vtt = generateChaptersVTT(chapters);

    expect(vtt).toContain('00:00:00.000 --> 01:00:00.000');
    expect(vtt).toContain('01:00:00.000 --> 01:02:05.000');
  });

  test('handles empty shots array', () => {
    const vtt = generateChaptersVTT([]);

    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('NOTE Generated chapters from shots');
    // Should not contain any chapter markers
    const lines = vtt.split('\n').filter((line) => line.includes('-->'));
    expect(lines).toHaveLength(0);
  });

  test('numbers chapters from the scene order index', () => {
    const vtt = generateChaptersVTT([
      chapter({ durationMs: 3000 }, scene(4, 'The Great Revelation')),
    ]);

    expect(vtt).toContain('Scene 5: The Great Revelation');
  });

  test('escapes XSS vectors in scene titles', () => {
    const xssVectors = [
      {
        input: "<script>alert('XSS')</script>",
        expected: "&lt;script&gt;alert('XSS')&lt;/script&gt;",
      },
      {
        input: '<img src=x onerror=alert(1)>',
        expected: '&lt;img src=x onerror=alert(1)&gt;',
      },
      {
        input: 'Scene --> 00:05:00',
        expected: 'Scene —&gt; 00:05:00',
      },
      {
        input: 'Title with &amp; entity',
        expected: 'Title with &amp;amp; entity',
      },
      {
        input: 'Line one\nLine two',
        expected: 'Line one Line two',
      },
    ];

    for (const { input, expected } of xssVectors) {
      const vtt = generateChaptersVTT([
        chapter({ durationMs: 3000 }, scene(0, input)),
      ]);
      expect(vtt).toContain(`Scene 1: ${expected}`);
      expect(vtt).not.toContain(input !== expected ? input : '<<impossible>>');
    }
  });

  test('handles fractional seconds in timestamps', () => {
    const vtt = generateChaptersVTT([chapter({ durationMs: 1234 })]);

    expect(vtt).toContain('00:00:00.000 --> 00:00:01.234');
  });
});
