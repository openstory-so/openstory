import { describe, expect, it } from 'vitest';
import { dialogueForShot } from './shot-dialogue';

describe('dialogueForShot', () => {
  it("keeps the shot's own lines plus unstamped ones", () => {
    const lines = [
      { character: 'A', line: 'one', tone: '', shotNumber: 1 },
      { character: 'B', line: 'two', tone: '', shotNumber: 2 },
      { character: 'C', line: 'any', tone: '' },
    ];
    expect(dialogueForShot(lines, 2).map((l) => l.line)).toEqual([
      'two',
      'any',
    ]);
    expect(dialogueForShot(undefined, 1)).toEqual([]);
  });
});
