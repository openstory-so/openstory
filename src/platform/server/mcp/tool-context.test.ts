import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { coerceScalars } from './tool-context';

const schema = z.object({
  count: z.number().optional(),
  flag: z.boolean().default(false),
  confirm: z.literal(true),
  duration: z.union([z.number().positive(), z.literal('auto')]).optional(),
  title: z.string().optional(),
});

describe('coerceScalars', () => {
  it('turns numeric and boolean strings into what the schema asks for', () => {
    expect(
      coerceScalars(schema, { count: ' 3 ', flag: 'false', confirm: 'true' })
    ).toEqual({ count: 3, flag: false, confirm: true });
  });

  it('turns a numeric string into a number inside a union', () => {
    expect(coerceScalars(schema, { duration: '5' })).toEqual({ duration: 5 });
  });

  it('keeps a string the schema already accepts', () => {
    expect(coerceScalars(schema, { duration: 'auto', title: '42' })).toEqual({
      duration: 'auto',
      title: '42',
    });
  });

  it('leaves values the schema would still reject for zod to report', () => {
    expect(
      coerceScalars(schema, { confirm: 'false', duration: '-2', count: 'x' })
    ).toEqual({ confirm: 'false', duration: '-2', count: 'x' });
  });
});
