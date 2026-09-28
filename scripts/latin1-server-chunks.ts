/**
 * Keep every server chunk Latin-1 (#1893).
 *
 * workerd keeps the source text of every module in the bundle on the V8 heap
 * from boot, lazy chunks included, and V8 stores a string with even one char
 * above U+00FF at two bytes per char. One em-dash in a comment doubled its
 * chunk: the server JS held ~60 MB of the 128 MB isolate at boot. Escaping
 * those chars as `\uXXXX` keeps every chunk one byte per char.
 */
import { parseAst, type Plugin } from 'vite';

const WIDE_CHAR = /[\u0100-\uffff]/g;

/**
 * `\uXXXX` for each char above U+00FF. Tagged templates are left alone:
 * escaping would change their `.raw`.
 */
export function escapeWideChars(code: string): string {
  if (code.search(WIDE_CHAR) === -1) return code;
  const keep: Array<[number, number]> = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (
      'type' in node &&
      node.type === 'TaggedTemplateExpression' &&
      'start' in node &&
      'end' in node &&
      typeof node.start === 'number' &&
      typeof node.end === 'number'
    ) {
      keep.push([node.start, node.end]);
      return;
    }
    Object.values(node).forEach(visit);
  };
  visit(parseAst(code));
  keep.push([code.length, code.length]);
  let out = '';
  let from = 0;
  for (const [start, end] of keep) {
    out += code
      .slice(from, start)
      .replace(
        WIDE_CHAR,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
      );
    out += code.slice(start, end);
    from = end;
  }
  return out;
}

/**
 * Runs in `generateBundle`, not `renderChunk`: a later plugin's `renderChunk`
 * re-prints the escapes as raw chars.
 */
export function latin1ServerChunks(): Plugin {
  return {
    name: 'latin1-server-chunks',
    apply: 'build',
    applyToEnvironment: (environment) => environment.name === 'ssr',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk') chunk.code = escapeWideChars(chunk.code);
      }
    },
  };
}
