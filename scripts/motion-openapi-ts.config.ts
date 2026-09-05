// This file is manually maintained (not auto-generated)
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Filter out noisy warnings/logs from @hey-api/openapi-ts
const originalWarn = console.warn;
console.warn = (...args: Array<unknown>) => {
  const message = args[0];
  if (typeof message === 'string') {
    if (message.includes('Transformers warning:')) {
      return;
    }
  }
  originalWarn.apply(console, args);
};

const originalLog = console.log;
console.log = (...args: Array<unknown>) => {
  const message = args[0];
  if (typeof message === 'string') {
    if (message.includes('raw OpenAPI specification')) {
      return;
    }
  }
  originalLog.apply(console, args);
};

// -- Types for OpenAPI spec manipulation --------------------------------------

type SchemaObject = {
  type?: string;
  format?: string;
  enum?: Array<string | number | boolean | null>;
  description?: string;
  title?: string;
  default?: unknown;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  additionalProperties?: boolean | SchemaObject;
  required?: string[];
  allOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  $ref?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  'x-fal-file-input'?: boolean;
  [key: string]: unknown;
};

type OpenAPISpec = {
  openapi?: string;
  info?: {
    title?: string;
    version?: string;
    'x-fal-metadata'?: { endpointId?: string };
    [key: string]: unknown;
  };
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, unknown>;
  };
  paths?: Record<string, unknown>;
  servers?: unknown[];
  security?: unknown[];
};

// -- Known missing schemas ----------------------------------------------------

/**
 * Registry of known missing schemas that fal.ai references but doesn't define.
 *
 * fal.ai's OpenAPI specs sometimes contain $ref pointers to schemas that don't exist
 * in the components.schemas section. This is a data quality issue from their API.
 *
 * We resolve these missing $refs by injecting proper schema definitions BEFORE
 * @hey-api/openapi-ts sees the specs (since the parser fails on missing $refs).
 *
 * When console warnings show unknown placeholders, research the schema structure
 * and add proper definitions here to get correct TypeScript types.
 */
const KNOWN_MISSING_SCHEMAS: Record<string, SchemaObject> = {
  TrackPoint: {
    type: 'object',
    description: 'A coordinate point with x and y values for motion tracking',
    properties: {
      x: { type: 'number', description: 'X coordinate' },
      y: { type: 'number', description: 'Y coordinate' },
    },
    required: ['x', 'y'],
  },
};

// -- File field transforms ----------------------------------------------------

/**
 * Patterns that identify URL fields which should accept Blob/File uploads.
 * The fal SDK automatically uploads Blobs/Files via storage.transformInput().
 */
const FAL_FILE_FIELD_PATTERNS = [
  /_url$/,
  /_urls$/,
  /^image$/,
  /^images$/,
  /^video$/,
  /^audio$/,
  /^file$/,
];

function isFalFileField(propertyName: string): boolean {
  return FAL_FILE_FIELD_PATTERNS.some((pattern) => pattern.test(propertyName));
}

/**
 * Transform a string schema to accept string | Blob | File.
 * Uses OpenAPI anyOf to create a union type that TypeScript plugin understands.
 */
function transformToFalFileSchema(schema: SchemaObject): SchemaObject {
  const { type: _type, format: _format, ...rest } = schema;
  return {
    anyOf: [{ type: 'string' }, { type: 'string', format: 'binary' }],
    'x-fal-file-input': true,
    ...rest,
  };
}

/**
 * Transform URL fields on Input schemas to accept string | Blob | File.
 * Only transforms fields on Input schemas (schema names ending with 'Input')
 * so that Output schema URL fields remain as plain strings.
 */
function transformFalFileFields(spec: OpenAPISpec): void {
  const schemas = spec.components?.schemas;
  if (!schemas) return;

  for (const [schemaName, schema] of Object.entries(schemas)) {
    if (!schemaName.endsWith('Input')) continue;
    transformPropertiesRecursively(schema);
  }
}

/**
 * Recursively transform properties matching fal-file patterns to anyOf union.
 */
function transformPropertiesRecursively(schema: SchemaObject): void {
  if (schema.properties) {
    for (const [key, value] of Object.entries(schema.properties)) {
      if (
        isFalFileField(key) &&
        value.type === 'string' &&
        !value.enum &&
        !value.anyOf
      ) {
        schema.properties[key] = transformToFalFileSchema(value);
      } else if (isFalFileField(key) && value.type === 'array' && value.items) {
        if (
          value.items.type === 'string' &&
          !value.items.enum &&
          !value.items.anyOf
        ) {
          value.items['x-fal-file-input'] = true;
        }
      }
      transformPropertiesRecursively(value);
    }
  }

  for (const arr of [schema.allOf, schema.anyOf, schema.oneOf]) {
    if (arr) {
      for (const item of arr) transformPropertiesRecursively(item);
    }
  }

  if (schema.items) transformPropertiesRecursively(schema.items);

  if (typeof schema.additionalProperties === 'object') {
    transformPropertiesRecursively(schema.additionalProperties);
  }
}

// -- $ref resolution ----------------------------------------------------------

/**
 * Recursively find all $ref pointers in an OpenAPI spec object.
 */
function findAllRefs(obj: unknown, refs: Set<string> = new Set()): Set<string> {
  if (!obj || typeof obj !== 'object') return refs;

  if (Array.isArray(obj)) {
    for (const item of obj) findAllRefs(item, refs);
  } else {
    for (const [key, value] of Object.entries(obj)) {
      if (key === '$ref' && typeof value === 'string') {
        const match = value.match(/#\/components\/schemas\/(.+)/);
        if (match?.[1]) refs.add(match[1]);
      }
      if (typeof value === 'object' && value !== null) {
        findAllRefs(value, refs);
      }
    }
  }

  return refs;
}

/**
 * Resolve missing $refs by injecting schema definitions.
 */
function resolveMissingRefs(spec: OpenAPISpec): {
  fixed: number;
  unknown: Array<string>;
} {
  if (!spec.components?.schemas) return { fixed: 0, unknown: [] };

  const allRefs = findAllRefs(spec);
  const existingSchemas = new Set(Object.keys(spec.components.schemas));
  const missingRefs = [...allRefs].filter((ref) => !existingSchemas.has(ref));

  let fixed = 0;
  const unknown: Array<string> = [];

  for (const missingRef of missingRefs) {
    spec.components.schemas ??= {};

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- Record lookup returns undefined for missing keys
    if (KNOWN_MISSING_SCHEMAS[missingRef]) {
      spec.components.schemas[missingRef] = KNOWN_MISSING_SCHEMAS[missingRef];
      fixed++;
    } else {
      spec.components.schemas[missingRef] = {
        type: 'object',
        description:
          'Schema referenced but not defined by fal.ai (missing from source OpenAPI spec)',
        additionalProperties: true,
      };
      unknown.push(missingRef);
    }
  }

  return { fixed, unknown };
}

// -- Schema merging -----------------------------------------------------------

function hashSchema(schema: SchemaObject): string {
  const json = JSON.stringify(schema, Object.keys(schema).sort());
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

function generateUniqueSchemaName(baseName: string, index: number): string {
  return `${baseName}Type${index}`;
}

/**
 * Rewrite $ref pointers in an object using a name mapping.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rewriteRefs(obj: unknown, mapping: Map<string, string>): void {
  if (!isRecord(obj)) return;
  for (const [key, value] of Object.entries(obj)) {
    if (key === '$ref' && typeof value === 'string') {
      const match = value.match(/^#\/components\/schemas\/(.+)$/);
      const refName = match?.[1];
      if (refName && mapping.has(refName)) {
        obj[key] = `#/components/schemas/${mapping.get(refName) ?? ''}`;
      }
    } else if (Array.isArray(value)) {
      for (const item of value) rewriteRefs(item, mapping);
    } else {
      rewriteRefs(value, mapping);
    }
  }
}

/**
 * Merge multiple OpenAPI specs into a single spec.
 * Deduplicates identical schemas, renames conflicting ones.
 */
function mergeOpenAPISpecs(
  specs: Array<OpenAPISpec>,
  categoryName: string
): OpenAPISpec {
  const merged: OpenAPISpec = {
    openapi: '3.0.4',
    info: { title: `Fal.ai ${categoryName} API`, version: '1.0.0' },
    components: { schemas: {}, securitySchemes: {} },
    paths: {},
    servers: [],
    security: [],
  };

  const registry = new Map<
    string,
    Map<
      string,
      { schema: SchemaObject; endpointIds: string[]; finalName: string }
    >
  >();

  // First pass: collect schemas
  for (const spec of specs) {
    const endpointId = spec.info?.['x-fal-metadata']?.endpointId || 'unknown';
    for (const [name, schema] of Object.entries(
      spec.components?.schemas || {}
    )) {
      const hash = hashSchema(schema);
      if (!registry.has(name)) registry.set(name, new Map());
      const hashMap = registry.get(name);
      if (!hashMap) throw new Error(`Hash map not found for ${name}`);
      if (!hashMap.has(hash)) {
        hashMap.set(hash, { schema, endpointIds: [], finalName: name });
      }
      const hashMapEntry = hashMap.get(hash);
      if (!hashMapEntry)
        throw new Error(`Hash map entry not found for ${name}`);
      hashMapEntry.endpointIds.push(endpointId);
    }
  }

  // Assign final names (most common keeps original, others renamed)
  for (const [baseName, hashMap] of registry) {
    const variants = [...hashMap.values()].sort(
      (a, b) => b.endpointIds.length - a.endpointIds.length
    );
    const primary = variants[0];
    if (!primary) throw new Error(`No variants for schema ${baseName}`);
    primary.finalName = baseName;
    for (let i = 1; i < variants.length; i++) {
      const variant = variants[i];
      if (!variant) throw new Error(`Variant ${i} missing for ${baseName}`);
      variant.finalName = generateUniqueSchemaName(baseName, i + 1);
      console.log(
        'Generating unique schema name for',
        baseName,
        '->',
        variant.finalName
      );
    }
  }

  // Build ref mapping per endpoint
  const refMappings = new Map<string, Map<string, string>>();
  for (const [baseName, hashMap] of registry) {
    for (const variant of hashMap.values()) {
      for (const endpointId of variant.endpointIds) {
        if (!refMappings.has(endpointId))
          refMappings.set(endpointId, new Map());
        if (variant.finalName !== baseName) {
          const mapping = refMappings.get(endpointId);
          if (!mapping) throw new Error(`Mapping not found for ${endpointId}`);
          mapping.set(baseName, variant.finalName);
        }
      }
    }
  }

  // Add schemas to merged spec with ref rewriting
  for (const hashMap of registry.values()) {
    for (const variant of hashMap.values()) {
      const clonedSchema = structuredClone(variant.schema);
      const firstEndpoint = variant.endpointIds[0];
      if (!firstEndpoint)
        throw new Error(`Variant ${variant.finalName} has no endpointIds`);
      const mapping = refMappings.get(firstEndpoint);
      if (mapping?.size) {
        rewriteRefs(clonedSchema, mapping);
      }
      if (!merged.components?.schemas)
        throw new Error('Components schemas not found');
      merged.components.schemas[variant.finalName] = clonedSchema;
    }
  }

  // Second pass: merge paths with ref rewriting
  for (const spec of specs) {
    const endpointId = spec.info?.['x-fal-metadata']?.endpointId || 'unknown';
    const mapping = refMappings.get(endpointId);
    for (const [pathKey, pathItem] of Object.entries(spec.paths || {})) {
      const cloned = structuredClone(pathItem);
      if (mapping?.size) {
        console.log('Rewriting refs for', pathKey, '->', [
          ...mapping.entries(),
        ]);
        rewriteRefs(cloned, mapping);
      }
      if (!merged.paths) throw new Error('Paths not found');
      merged.paths[pathKey] = cloned;
    }
  }

  // Take security/servers from first spec
  const first = specs[0];
  if (!first) throw new Error('Cannot merge: specs array is empty');
  if (first.components?.securitySchemes) {
    if (!merged.components?.securitySchemes)
      throw new Error('Components security schemes not found');
    merged.components.securitySchemes = structuredClone(
      first.components.securitySchemes
    );
  }
  if (first.servers) merged.servers = structuredClone(first.servers);
  if (first.security) merged.security = structuredClone(first.security);

  return merged;
}

// -- Config -------------------------------------------------------------------

function getFalCategoryFilenames(): Array<string> {
  const categoryDir = join(__dirname, '..', 'json');
  const files = readdirSync(categoryDir)
    .filter((file) => file.endsWith('.json'))
    .sort();
  return files;
}

function getFalGroupedCategoryFilenames(): Array<{
  category: string;
  filenames: Array<string>;
}> {
  const categoryFilenames = getFalCategoryFilenames();
  return Object.entries(
    categoryFilenames.reduce<Record<string, Array<string>>>((acc, filename) => {
      const category = filename.replace(
        /fal\.models\.([^-.]+-to-([^.]+)|([^-.]+))\.json/,
        '$2$3'
      );
      acc[category] ??= [];
      acc[category].push(filename);
      return acc;
    }, {})
  ).map(([category, filenames]) => ({ category, filenames }));
}

function getFalModelOpenApiObjects(filename: string): Array<OpenAPISpec> {
  const fileContents = readFileSync(
    join(__dirname, '..', 'json', filename),
    'utf8'
  );
  const json = JSON.parse(fileContents);

  let totalFixed = 0;
  const allUnknown = new Set<string>();

  const specs = json.models.map((model: { openapi: OpenAPISpec }) => {
    const spec = model.openapi;
    const { fixed, unknown } = resolveMissingRefs(spec);

    totalFixed += fixed;
    unknown.forEach((u: string) => allUnknown.add(u));

    transformFalFileFields(spec);

    return spec;
  });

  if (totalFixed > 0 || allUnknown.size > 0) {
    console.log(`[${filename}] Resolved ${totalFixed} known missing refs`);
    if (allUnknown.size > 0) {
      console.warn(
        `[${filename}] Created placeholders for unknown refs: ${[...allUnknown].join(', ')}`
      );
    }
  }

  return specs;
}

/** Output path overrides by category. Default: ./libs/types/src/{category} */
const OUTPUT_PATH_OVERRIDES: Record<string, string> = {
  motion: './src/shared/motion/generated',
};

export default getFalGroupedCategoryFilenames().map(
  ({ category, filenames }) => {
    const allSpecs = filenames.map(getFalModelOpenApiObjects).flat();
    const mergedSpec = mergeOpenAPISpecs(allSpecs, category);

    return {
      input: mergedSpec,
      output: {
        path: OUTPUT_PATH_OVERRIDES[category] ?? `./libs/types/src/${category}`,
        indexFile: false,
      },
      plugins: [
        { name: '@hey-api/typescript' },
        { name: '@hey-api/schemas', type: 'json' },
        { name: 'zod', metadata: true },
      ],
      parser: {
        filters: {
          schemas: {
            include: '/Input$|Output$|^Post.*Data$/',
          },
          operations: {
            include: ['/post .*/'],
            exclude: ['/get .*/'],
          },
          orphans: false,
        },
      },
    };
  }
);
