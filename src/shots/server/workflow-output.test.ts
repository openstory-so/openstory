import { describe, expect, it } from 'vitest';
import { readTalentMatchingWorkflowOutput } from './workflow-output';

const match = {
  characterId: 'char-1',
  talentId: 'talent-1',
  talentName: 'Ada',
  sheetImageUrl: '/r2/talent/ada.png',
};

describe('readTalentMatchingWorkflowOutput', () => {
  it('reads a talent with no default sheet, whose sheetMetadata is present but undefined', () => {
    const output = readTalentMatchingWorkflowOutput({
      matches: [{ ...match, sheetMetadata: undefined }],
    });

    expect(output.matches).toHaveLength(1);
    expect(output.matches[0]).not.toHaveProperty('sheetMetadata');
  });

  it('rejects sheetMetadata that is present but not a character bible entry', () => {
    expect(() =>
      readTalentMatchingWorkflowOutput({
        matches: [{ ...match, sheetMetadata: 'not-an-entry' }],
      })
    ).toThrow();
  });
});
