import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { escapeWideChars } from './latin1-server-chunks';

const WIDE_CHAR = /[Ā-￿]/;

describe('escapeWideChars', () => {
  it('leaves Latin-1 code as it is', () => {
    const code = 'const s = "café"; // ÿ';
    expect(escapeWideChars(code)).toBe(code);
  });

  it('escapes chars above U+00FF and keeps what the code means', () => {
    const code =
      'const s = "a—b 😀", t = `x→${1}`, r = /[а-я]/u; // …\n' +
      'JSON.stringify([s, t, r.test("ж")]);';
    const out = escapeWideChars(code);
    expect(out).not.toMatch(WIDE_CHAR);
    expect(runInNewContext(out)).toBe(runInNewContext(code));
  });

  it('leaves tagged templates alone so their .raw is unchanged', () => {
    const code = 'const x = "😀"; const a = String.raw`—`; const b = "—";';
    expect(escapeWideChars(code)).toBe(
      'const x = "\\ud83d\\ude00"; const a = String.raw`—`; const b = "\\u2014";'
    );
  });
});
