import { describe, expect, it } from 'vitest';
import {
  buildRootDocument,
  createSequenceLink,
  enhanceScriptLink,
} from './discovery';
import { apiEnhanceScriptSchema } from './enhance-input-schema';
import { apiCreateSequenceSchema } from './input-schema';
import { apiCreateStyleSchema } from './style-input-schema';

describe('buildRootDocument', () => {
  it('reads like MCP-style instructions and self-describes the API', () => {
    const doc = buildRootDocument();
    expect(doc.name).toBe('OpenStory API');
    expect(doc.version).toBe('v1');
    // Narrative covers the create→poll workflow, auth, and conventions.
    expect(doc.instructions).toMatch(/POST \/api\/v1\/sequences/);
    expect(doc.instructions).toMatch(/Authorization: Bearer/);
    expect(doc.instructions).toMatch(/\?wait=/);
    expect(doc.instructions).toMatch(/_links/);
    expect(doc.instructions).toMatch(/POST\s+\/api\/v1\/device\/code/);
    expect(doc.instructions).toMatch(/428 authorization_pending/);
  });

  it('advertises style create/list/get with a parseable create example', () => {
    const doc = buildRootDocument();
    expect(doc.instructions).toMatch(/POST \/api\/v1\/styles/);
    const create = doc._links['create-style'];
    expect(create?.method).toBe('POST');
    expect(() =>
      apiCreateStyleSchema.parse(create?.examples?.[0])
    ).not.toThrow();
    expect(doc._links['list-styles']?.href).toBe('/api/v1/styles');
    expect(doc._links.style?.templated).toBe(true);
  });

  it('embeds the request JSON Schema for tool callers', () => {
    const doc = buildRootDocument();
    expect(doc.requestSchema).toMatchObject({ type: 'object' });
    // Nested named defs stay in $defs; the root CreateSequenceRequest is inlined.
    expect(doc.requestSchema).toMatchObject({
      $defs: { CharacterRef: expect.any(Object) },
    });
  });

  it('links every operation with a method (and write links with examples)', () => {
    const { _links } = buildRootDocument();
    expect(_links.self?.method).toBe('GET');
    expect(_links['device-authorize']).toMatchObject({
      method: 'POST',
      href: '/api/v1/device/code',
    });
    expect(_links['sequence-status']?.templated).toBe(true);

    const create = _links['create-sequence'];
    expect(create?.method).toBe('POST');
    expect(create?.contentType).toBe('application/json');
    expect(create?.examples).toHaveLength(1);

    const enhance = _links['enhance-script'];
    expect(enhance?.method).toBe('POST');
    expect(enhance?.href).toBe('/api/v1/scripts/enhance');

    const list = _links['list-sequences'];
    expect(list?.method).toBe('GET');
    expect(list?.templated).toBe(true);
    expect(list?.href).toBe('/api/v1/sequences{?limit,cursor}');
  });

  it('documents the streaming enhance endpoint in the narrative', () => {
    const { instructions } = buildRootDocument();
    expect(instructions).toMatch(/POST \/api\/v1\/scripts\/enhance/);
    expect(instructions).toMatch(/Server-Sent Events/);
  });
});

describe('createSequenceLink', () => {
  it('carries an example body that satisfies the input schema', () => {
    const [example] = createSequenceLink().examples ?? [];
    // The advertised example must actually be a valid request.
    expect(() => apiCreateSequenceSchema.parse(example)).not.toThrow();
  });
});

describe('enhanceScriptLink', () => {
  it('carries an example body that satisfies the enhance schema', () => {
    const [example] = enhanceScriptLink().examples ?? [];
    expect(() => apiEnhanceScriptSchema.parse(example)).not.toThrow();
  });
});
