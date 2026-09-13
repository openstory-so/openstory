import { describe, expect, it } from 'vitest';
import {
  RateCardError,
  bindInputs,
  evaluateRateCard,
  verifyRateCardExamples,
} from './evaluate';
import { type Expr, type RateCard, rateCardSchema } from './rate-card.schema';

const source = {
  url: 'https://example.test/llms.txt',
  hash: 'a'.repeat(64),
  extractedAt: '2026-09-13T00:00:00Z',
};

/** A card whose price is `expr`, over number inputs `x` (default 4) and `y` (default 2). */
const cardFor = (price: Expr, extra: Partial<RateCard> = {}): RateCard => ({
  inputs: {
    x: { param: 'x', kind: 'number', default: 4 },
    y: { param: 'y', kind: 'number', default: 2 },
  },
  tables: { t: { a: { p: 1.5 }, b: { p: 3 } } },
  price,
  examples: [],
  source,
  ...extra,
});

const usd = (price: Expr, params: Record<string, unknown> = {}) =>
  evaluateRateCard(cardFor(price), params).usd;

describe('ops', () => {
  it.each<[string, Expr, number]>([
    ['+ variadic', { '+': [{ var: 'x' }, { var: 'y' }, 1] }, 7],
    ['- binary', { '-': [{ var: 'x' }, { var: 'y' }] }, 2],
    ['* variadic', { '*': [{ var: 'x' }, { var: 'y' }, 0.5] }, 4],
    ['/', { '/': [{ var: 'x' }, { var: 'y' }] }, 2],
    ['max', { max: [1, { var: 'x' }, 3] }, 4],
    ['min', { min: [{ var: 'x' }, 3, { var: 'y' }] }, 2],
    ['ceil', { ceil: [{ '/': [{ var: 'x' }, 3] }] }, 2],
    ['floor', { floor: [{ '/': [{ var: 'x' }, 3] }] }, 1],
    [
      'if chain',
      {
        if: [
          { '<': [{ var: 'x' }, 2] },
          10,
          { '<': [{ var: 'x' }, 5] },
          20,
          30,
        ],
      },
      20,
    ],
    ['== literal', { if: [{ '==': [{ var: 'x' }, 4] }, 1, 2] }, 1],
    ['!=', { if: [{ '!=': [{ var: 'x' }, 4] }, 1, 2] }, 2],
    ['<=', { if: [{ '<=': [{ var: 'x' }, 4] }, 1, 2] }, 1],
    ['>', { if: [{ '>': [{ var: 'x' }, 4] }, 1, 2] }, 2],
    ['>=', { if: [{ '>=': [{ var: 'x' }, 4] }, 1, 2] }, 1],
    ['and', { if: [{ and: [true, { '>': [{ var: 'x' }, 1] }] }, 1, 2] }, 1],
    ['or', { if: [{ or: [false, { '>': [{ var: 'x' }, 1] }] }, 1, 2] }, 1],
    [
      'missing → falsy when nothing is missing',
      { if: [{ missing: ['x'] }, 1, 2] },
      2,
    ],
    [
      'missing → truthy when something is',
      { if: [{ missing: ['x', 'nope'] }, 1, 2] },
      1,
    ],
    ['lookup nested', { lookup: { table: 't', keys: ['b', 'p'] } }, 3],
    [
      'lookup default',
      { lookup: { table: 't', keys: ['zzz'], default: 9 } },
      9,
    ],
  ])('%s', (_name, price, expected) => {
    expect(usd(price)).toBe(expected);
  });
});

describe('binding', () => {
  const card: RateCard = {
    inputs: {
      duration: { param: 'duration', kind: 'number', default: 5 },
      res: {
        param: 'resolution',
        kind: 'enum',
        values: ['480p', '720p'],
        default: '480p',
      },
      audio: { param: 'generate_audio', kind: 'boolean', default: true },
      refs: { param: 'image_urls', kind: 'count' },
      size: {
        param: 'image_size',
        kind: 'dimensions',
        presets: { square_hd: [1024, 1024] },
        default: 'square_hd',
      },
    },
    tables: {},
    price: 1,
    examples: [],
    source,
  };

  it('binds by request param name, falling back to defaults', () => {
    expect(bindInputs(card, {})).toEqual({
      duration: 5,
      res: '480p',
      audio: true,
      refs: 0,
      size: { width: 1024, height: 1024 },
    });
  });

  it('reads a numeric string duration, a list length and explicit pixels', () => {
    expect(
      bindInputs(card, {
        duration: '8',
        resolution: '720p',
        generate_audio: false,
        image_urls: ['a', 'b'],
        image_size: { width: 1920, height: 1080 },
      })
    ).toEqual({
      duration: 8,
      res: '720p',
      audio: false,
      refs: 2,
      size: { width: 1920, height: 1080 },
    });
  });

  it('var walks dotted paths into dimensions', () => {
    const c: RateCard = {
      ...card,
      price: { '*': [{ var: 'size.width' }, 0.001] },
    };
    expect(evaluateRateCard(c, {}).usd).toBe(1.024);
  });

  it.each<[string, Record<string, unknown>]>([
    ['enum outside values', { resolution: '1080p' }],
    ['non-numeric number', { duration: 'five' }],
    ['non-boolean boolean', { generate_audio: 'yes' }],
    ['non-list count', { image_urls: 'a' }],
    ['unknown size preset', { image_size: 'portrait_4_3' }],
  ])('refuses %s', (_name, params) => {
    expect(() => evaluateRateCard(card, params)).toThrow(RateCardError);
  });
});

/** Outside the vocabulary; parsed so no assertion has to lie about its type. */
const unknownOp: Expr = JSON.parse('{"cat":[1,2]}');

describe('refusals', () => {
  it.each<[string, Expr, string]>([
    ['unknown op', unknownOp, 'unknown-op'],
    ['unbound var', { var: 'nope' }, 'unbound-var'],
    [
      'missing lookup key without default',
      { lookup: { table: 't', keys: ['zzz', 'p'] } },
      'missing-key',
    ],
    ['non-numeric operand', { '+': [{ var: 'x' }, 'text'] }, 'not-a-number'],
    // JSONLogic's == is loose; ours refuses a type mismatch instead of returning false.
    [
      '== across types',
      { if: [{ '==': [{ var: 'x' }, '4'] }, 1, 2] },
      'not-comparable',
    ],
    [
      '!= across types',
      { if: [{ '!=': [{ var: 'x' }, '4'] }, 1, 2] },
      'not-comparable',
    ],
    [
      '== on a list',
      { if: [{ '==': [{ missing: ['x'] }, 0] }, 1, 2] },
      'not-comparable',
    ],
    ['zero price', { '-': [{ var: 'x' }, 4] }, 'bad-result'],
    ['negative price', { '-': [1, { var: 'x' }] }, 'bad-result'],
    ['non-finite price', { '/': [{ var: 'x' }, 0] }, 'bad-result'],
    ['non-numeric price', { '<': [1, 2] }, 'bad-result'],
  ])('%s', (_name, price, code) => {
    expect(() => usd(price)).toThrow(expect.objectContaining({ code }));
  });

  it('schema rejects an op outside the vocabulary', () => {
    expect(rateCardSchema.safeParse(cardFor(unknownOp)).success).toBe(false);
  });

  it('schema rejects a lookup node carrying a sibling op (would be stripped silently)', () => {
    const price: Expr = JSON.parse(
      '{"lookup":{"table":"t","keys":["a","p"]},"+":[1,2]}'
    );
    expect(rateCardSchema.safeParse(cardFor(price)).success).toBe(false);
  });

  it.each<[string, Partial<RateCard>]>([
    [
      'enum default outside values',
      {
        inputs: {
          r: { param: 'r', kind: 'enum', values: ['a'], default: 'zzz' },
        },
      },
    ],
    [
      'dimensions default that is not a preset',
      {
        inputs: {
          s: { param: 's', kind: 'dimensions', presets: {}, default: 'nope' },
        },
      },
    ],
    [
      'extractedAt that is not a date',
      { source: { ...source, extractedAt: 'yesterday' } },
    ],
    [
      'expiresAt that is not a date',
      { source: { ...source, expiresAt: 'soon' } },
    ],
  ])('schema rejects %s', (_name, extra) => {
    expect(rateCardSchema.safeParse(cardFor(1, extra)).success).toBe(false);
  });
});

describe('verifyRateCardExamples', () => {
  const price: Expr = { '*': [{ var: 'x' }, 0.1] };
  it('passes within 1% and fails outside it, reporting the evaluated price', () => {
    const card = cardFor(price, {
      examples: [
        { params: { x: 10 }, usd: 1.0, quote: 'ten' },
        { params: { x: 10 }, usd: 1.009, quote: 'ten-ish' },
        { params: { x: 10 }, usd: 1.02, quote: 'not ten' },
      ],
    });
    const [exact, close, off] = verifyRateCardExamples(card);
    expect(exact).toMatchObject({ ok: true, usd: 1 });
    expect(close).toMatchObject({ ok: true });
    expect(off).toMatchObject({
      ok: false,
      usd: 1,
      error: expect.stringContaining('1.02'),
    });
  });

  it('reports a refusal as a failed example instead of throwing', () => {
    const card = cardFor(price, {
      examples: [{ params: { x: 'many' }, usd: 1, quote: 'bad input' }],
    });
    expect(verifyRateCardExamples(card)[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining('bad-input'),
    });
  });
});
