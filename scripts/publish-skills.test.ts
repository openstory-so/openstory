import { describe, expect, it } from 'vitest';
import {
  fileChanges,
  nextVersion,
  readJsonString,
  setJsonString,
} from './publish-skills';

describe('nextVersion', () => {
  it('bumps the patch, or the minor for a new skill', () => {
    expect(nextVersion('1.3.9', false)).toBe('1.3.10');
    expect(nextVersion('1.3.9', true)).toBe('1.4.0');
    expect(() => nextVersion('1.3', false)).toThrow();
  });
});

describe('setJsonString', () => {
  const manifest = `{
  "version": "1.3.3",
  "keywords": ["a", "b"],
  "publication": { "release_notes": "old \\"quoted\\" notes" }
}
`;

  it('replaces one value and keeps the formatting', () => {
    const next = setJsonString(manifest, 'version', '1.3.4');
    expect(next).toBe(manifest.replace('1.3.3', '1.3.4'));
  });

  it('writes any notes as a valid JSON string', () => {
    const notes = 'Fix "setup" & $1 $HOME | \\ (#1)';
    const next = setJsonString(manifest, 'release_notes', notes);
    expect(readJsonString(next, 'release_notes')).toBe(notes);
    expect(next).toContain('"keywords": ["a", "b"]');
  });

  it('refuses a missing or repeated key', () => {
    expect(() => setJsonString(manifest, 'name', 'x')).toThrow();
    expect(() =>
      setJsonString(`{"version": "1", "a": {"version": "2"}}`, 'version', '3')
    ).toThrow();
  });
});

describe('fileChanges', () => {
  it('splits a -z name-status into additions and deletions', () => {
    expect(
      fileChanges(
        'M\0plugin.json\0A\0skills/a b/SKILL.md\0D\0skills/old.md\0',
        (f) => `<${f}>`
      )
    ).toEqual({
      additions: [
        { path: 'plugin.json', contents: '<plugin.json>' },
        { path: 'skills/a b/SKILL.md', contents: '<skills/a b/SKILL.md>' },
      ],
      deletions: [{ path: 'skills/old.md' }],
    });
  });
});
