import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './openapi';

/** Every `$ref` the document emits must resolve to a component it defines. */
describe('buildOpenApiDocument', () => {
  const doc = buildOpenApiDocument();

  const asObject = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : {};

  const schemas = asObject(asObject(doc.components).schemas);

  const refs = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') refs.add(value);
      else walk(value);
    }
  };
  walk(doc);

  it('resolves every $ref', () => {
    const dangling = [...refs].filter(
      (ref) => !(ref.replace('#/components/schemas/', '') in schemas)
    );
    expect(dangling).toEqual([]);
  });

  it('publishes the response components the paths reference', () => {
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining([
        'CreateSequenceRequest',
        'CreateSequenceResult',
        'CreateSequenceWaitResult',
        'Error',
        'HalLink',
        'HalLinks',
        'RootDocument',
        'SequenceExport',
        'SequenceExportAccepted',
        'SequenceExportsResult',
        'SequenceListResult',
        'SequenceState',
        'SequenceStateShot',
        'StyleDocument',
        'StyleListResult',
      ])
    );
  });
});
