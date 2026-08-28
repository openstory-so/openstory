import { describe, expect, it } from 'vitest';
import {
  libraryTalentGenerateDedupId,
  libraryTalentUploadDedupId,
} from './library-talent-sheet-dedup';

describe('library talent sheet dedup ids', () => {
  it('shares one generate id per talent', () => {
    expect(libraryTalentGenerateDedupId('tal1')).toBe(
      'library-talent-sheet:generate:tal1'
    );
  });

  it('keys uploaded sheets by the stored object name', () => {
    expect(
      libraryTalentUploadDedupId('tal1', '/r2/talent/team/tal1/abc.png')
    ).toBe('library-talent-sheet:upload:tal1:abc.png');
  });
});
