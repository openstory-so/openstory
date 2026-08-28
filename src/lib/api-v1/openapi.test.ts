import { describe, expect, it } from 'vitest';
import { apiEnhanceScriptSchema } from './enhance-input-schema';
import { apiCreateSequenceSchema } from './input-schema';
import { apiCreateStyleSchema } from './style-input-schema';
import { buildOpenApiDocument } from './openapi';

/** Collect every `$ref` string anywhere in the document. */
function collectRefs(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, acc);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') acc.push(value);
      else collectRefs(value, acc);
    }
  }
  return acc;
}

describe('buildOpenApiDocument', () => {
  const doc = buildOpenApiDocument() as Record<string, any>;

  it('is an OpenAPI 3.1 document with info and servers', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toMatchObject({ title: 'OpenStory API', version: 'v1' });
    expect(Array.isArray(doc.servers)).toBe(true);
  });

  it('documents the operations', () => {
    expect(doc.paths['/api/v1'].get).toBeDefined();
    expect(doc.paths['/api/v1/sequences'].get).toBeDefined();
    expect(doc.paths['/api/v1/sequences'].post).toBeDefined();
    expect(doc.paths['/api/v1/sequences/{id}'].get).toBeDefined();
    expect(doc.paths['/api/v1/openapi.json'].get).toBeDefined();
    expect(doc.paths['/api/v1/scripts/enhance'].post).toBeDefined();
    expect(doc.paths['/api/v1/device/code'].post).toBeDefined();
    expect(doc.paths['/api/v1/device/token'].get).toBeDefined();
    expect(doc.paths['/api/v1/styles'].get).toBeDefined();
    expect(doc.paths['/api/v1/styles'].post).toBeDefined();
    expect(doc.paths['/api/v1/styles/{id}'].get).toBeDefined();
  });

  it('documents the create-style endpoint with a valid example and a 409', () => {
    const op = doc.paths['/api/v1/styles'].post;
    expect(op.responses['201']).toBeDefined();
    expect(op.responses['409']).toBeDefined();
    expect(doc.components.schemas).toHaveProperty('CreateStyleRequest');
    expect(doc.components.schemas).toHaveProperty('StyleDocument');
    const styleDoc = doc.components.schemas.StyleDocument;
    expect(styleDoc.properties.config.properties).toHaveProperty('look');
    expect(styleDoc.required).toContain('_links');
    expect(styleDoc.properties._links.$ref).toBe(
      '#/components/schemas/HalLinks'
    );
    const example = op.requestBody.content['application/json'].example;
    expect(() => apiCreateStyleSchema.parse(example)).not.toThrow();
  });

  it('documents the list endpoint with limit/cursor params and a result schema', () => {
    const op = doc.paths['/api/v1/sequences'].get;
    const paramNames = op.parameters.map((p: { name: string }) => p.name);
    expect(paramNames).toEqual(expect.arrayContaining(['limit', 'cursor']));
    expect(op.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/SequenceListResult',
    });
    expect(doc.components.schemas).toHaveProperty('SequenceListItem');
    expect(doc.components.schemas).toHaveProperty('SequenceListResult');
  });

  it('documents the enhance endpoint as an SSE stream with a valid example', () => {
    const op = doc.paths['/api/v1/scripts/enhance'].post;
    expect(op.responses['200'].content).toHaveProperty('text/event-stream');
    expect(doc.components.schemas).toHaveProperty('EnhanceScriptRequest');
    const example = op.requestBody.content['application/json'].example;
    expect(() => apiEnhanceScriptSchema.parse(example)).not.toThrow();
  });

  it('every $ref resolves to a defined component schema (no dangling refs)', () => {
    const schemas = doc.components.schemas;
    const refs = collectRefs(doc);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('#/components/schemas/')).toBe(true);
      const name = ref.replace('#/components/schemas/', '');
      expect(schemas, `missing component for ${ref}`).toHaveProperty(name);
    }
  });

  it('lifts the request schema $defs into components (no #/$defs/ refs remain)', () => {
    const refs = collectRefs(doc);
    expect(refs.some((r) => r.includes('/$defs/'))).toBe(false);
    // The lifted defs are present as their own components.
    expect(doc.components.schemas).toHaveProperty('CharacterRef');
    expect(doc.components.schemas).toHaveProperty('CreateSequenceRequest');
  });

  it('declares both API-key security schemes and a default requirement', () => {
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
    expect(doc.components.securitySchemes.apiKeyHeader.name).toBe('x-api-key');
    expect(doc.security).toEqual([{ bearerAuth: [] }, { apiKeyHeader: [] }]);
  });

  it('leaves discovery endpoints unauthenticated', () => {
    expect(doc.paths['/api/v1'].get.security).toEqual([]);
    expect(doc.paths['/api/v1/openapi.json'].get.security).toEqual([]);
  });

  it('advertises the create example as a valid request body', () => {
    const example =
      doc.paths['/api/v1/sequences'].post.requestBody.content[
        'application/json'
      ].example;
    expect(() => apiCreateSequenceSchema.parse(example)).not.toThrow();
  });

  it('SequenceState exposes videosFailed in counts', () => {
    const counts = doc.components.schemas.SequenceState.properties.counts;
    expect(counts.required).toContain('videosFailed');
  });

  it('exposes style and models on both the status document and list item', () => {
    for (const name of ['SequenceState', 'SequenceListItem']) {
      const schema = doc.components.schemas[name];
      expect(schema.required, name).toEqual(
        expect.arrayContaining(['style', 'models'])
      );
      expect(schema.properties.style.properties).toMatchObject({
        id: { type: 'string' },
      });
      expect(schema.properties.models.required).toEqual(
        expect.arrayContaining(['analysis', 'image', 'video', 'music'])
      );
    }
  });
});
