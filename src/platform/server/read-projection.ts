import { z } from 'zod';
import { toShareableUrl } from '@/platform/server/storage/buckets';
import { ValidationError } from '@/platform/errors';

export const readDate = z.string();
export const textWindowInput = z.object({
  offset: z.int().min(0).default(0),
  length: z.int().min(1).max(16000).default(8000),
});
export const textWindowSchema = z.object({
  text: z.string(),
  offset: z.number(),
  totalLength: z.number(),
  nextOffset: z.number().nullable(),
});

/** UTF-16 offsets, as used by JavaScript strings; no silent text truncation. */
export function textWindow(
  text: string,
  input: { offset: number; length: number }
) {
  if (input.offset > text.length)
    throw new ValidationError(
      'Offset exceeds document length. Restart at offset 0.'
    );
  const end = Math.min(input.offset + input.length, text.length);
  return {
    text: text.slice(input.offset, end),
    offset: input.offset,
    totalLength: text.length,
    nextOffset: end < text.length ? end : null,
  };
}

function wire(
  value: unknown,
  origin: string,
  key = ''
): z.infer<ReturnType<typeof z.json>> {
  if (value instanceof Date) return value.toISOString();
  if (value === undefined || value === null) return null;
  if (typeof value === 'string')
    return /url$/i.test(key) && value ? toShareableUrl(value, origin) : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => wire(item, origin));
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, wire(v, origin, k)])
    );
  throw new Error('Unsupported production read value');
}

/** Schemas explicitly allowlist public fields; DB-only fields never reach callers. */
export function projectRead<S extends z.ZodType>(
  schema: S,
  value: unknown,
  origin: string
): z.output<S> {
  return schema.parse(wire(value, origin));
}
