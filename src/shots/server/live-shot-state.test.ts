import { describe, expect, it } from 'vitest';
import { loadLiveShotInputs } from './live-shot-state';

const line = (character: string, text: string) => ({
  character,
  line: text,
  tone: 'calm',
});
const shot = (id: string, shotNumber: number, clipIds: string[] = []) => ({
  id,
  sceneId: 'scene-1',
  shotNumber,
  deletedAt: null,
  durationMs: 4000,
  audioClips: clipIds.map((clipId) => ({
    id: clipId,
    url: `/r2/${clipId}.wav`,
    token: '@Audio1',
    durationSeconds: 2,
  })),
});

const load = (rows: { shotId: string; lines: ReturnType<typeof line>[] }[]) =>
  loadLiveShotInputs(
    {
      shotDialogue: { getSelectedBySequence: () => Promise.resolve(rows) },
      shotPromptVersions: {
        getSelectedMotionByShots: () => Promise.resolve(new Map()),
      },
      sequenceLocations: { listWithReferences: () => Promise.resolve([]) },
      sequenceElements: { list: () => Promise.resolve([]) },
    },
    'seq-1',
    [shot('shot-1', 1, ['section-1']), shot('shot-2', 2)],
    [
      {
        id: 'char-1',
        name: 'Ana',
        voiceId: 'voice-ana',
        selectedSheetVersionId: null,
        sheetImageUrl: null,
      },
    ],
    new Map([
      [
        'scene-1',
        {
          script: {
            dialogue: [{ ...line('Ana', 'From the script.'), shotNumber: 2 }],
          },
        },
      ],
    ])
  );

describe('loadLiveShotInputs — dialogue (#1657)', () => {
  it("keys each shot off its OWN lines, so a neighbour's edit moves nothing", async () => {
    const before = await load([
      { shotId: 'shot-1', lines: [line('Ana', 'Hello.')] },
    ]);
    const after = await load([
      { shotId: 'shot-1', lines: [line('Ana', 'Hello there.')] },
    ]);
    expect(after.audioSourceKeyByShot.get('shot-1')).not.toBe(
      before.audioSourceKeyByShot.get('shot-1')
    );
    // shot-2 has no row: its key is derived from the script's stamped line.
    expect(before.audioSourceKeyByShot.get('shot-2')).toBeTruthy();
    expect(after.audioSourceKeyByShot.get('shot-2')).toBe(
      before.audioSourceKeyByShot.get('shot-2')
    );
  });
});
