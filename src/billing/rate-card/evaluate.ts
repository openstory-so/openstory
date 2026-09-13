/**
 * Deterministic rate-card evaluator (#1605). ~100 lines of JSONLogic over
 * the closed vocabulary in `rate-card.schema.ts` — smaller than json-logic-js,
 * no `eval`, and it refuses instead of coercing: an unknown op, an unbound
 * input, a missing table key or a non-numeric operand throws, and so does a
 * price that is not a finite positive number. A refusal is an honest
 * "unknown"; a made-up number is a wrong credit gate.
 */
import {
  CORE_OPS,
  type CoreOp,
  type Expr,
  type RateCard,
  type RateCardExample,
  type Table,
} from './rate-card.schema';

export type RateCardErrorCode =
  | 'unknown-op'
  | 'unbound-var'
  | 'bad-input'
  | 'missing-key'
  | 'not-a-number'
  | 'bad-result';

export class RateCardError extends Error {
  constructor(
    readonly code: RateCardErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'RateCardError';
  }
}

type Vars = Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isCoreOp = (op: string): op is CoreOp =>
  (CORE_OPS as readonly string[]).includes(op);

/** `{var: 'image_size.width'}` walks dotted paths. */
function readVar(vars: Vars, path: string): unknown {
  let value: unknown = vars;
  for (const key of path.split('.')) {
    if (!isRecord(value) || !(key in value)) return undefined;
    value = value[key];
  }
  return value;
}

const truthy = (v: unknown): boolean =>
  Array.isArray(v) ? v.length > 0 : Boolean(v);

function lookup(
  tables: Record<string, Table>,
  table: string,
  path: string[]
): number | undefined {
  let node: number | Table | undefined = tables[table];
  for (const key of path) {
    node = typeof node === 'object' ? node[key] : undefined;
  }
  return typeof node === 'number' ? node : undefined;
}

function evaluate(
  expr: Expr,
  vars: Vars,
  tables: Record<string, Table>
): unknown {
  if (typeof expr !== 'object') return expr;
  const ev = (e: Expr) => evaluate(e, vars, tables);
  const num = (e: Expr): number => {
    const v = ev(e);
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new RateCardError(
        'not-a-number',
        `${JSON.stringify(e)} → ${JSON.stringify(v)}`
      );
    }
    return v;
  };

  if ('lookup' in expr) {
    const { table, keys, default: fallback } = expr.lookup;
    const path = keys.map((k) => {
      const key = ev(k);
      if (typeof key === 'string') return key;
      if (typeof key === 'number') return String(key);
      throw new RateCardError(
        'missing-key',
        `${table}: key ${JSON.stringify(key)}`
      );
    });
    const hit = lookup(tables, table, path);
    if (hit !== undefined) return hit;
    if (fallback !== undefined) return ev(fallback);
    throw new RateCardError('missing-key', `${table}[${path.join('][')}]`);
  }

  const keys = Object.keys(expr);
  const op = keys[0];
  if (keys.length !== 1 || op === undefined || !isCoreOp(op)) {
    throw new RateCardError('unknown-op', keys.join(','));
  }
  const raw = expr[op];
  const args: Expr[] = Array.isArray(raw)
    ? raw
    : raw === undefined
      ? []
      : [raw];
  const arg = (i: number): Expr => {
    const e = args[i];
    if (e === undefined) {
      throw new RateCardError('unknown-op', `${op}: missing operand ${i}`);
    }
    return e;
  };
  const name = (e: Expr): string => {
    if (typeof e !== 'string') {
      throw new RateCardError('unbound-var', JSON.stringify(e));
    }
    return e;
  };

  switch (op) {
    case 'var': {
      const v = readVar(vars, name(arg(0)));
      if (v === undefined) throw new RateCardError('unbound-var', name(arg(0)));
      return v;
    }
    case 'missing':
      return args.map(name).filter((n) => readVar(vars, n) === undefined);
    case '+':
      return args.reduce<number>((sum, e) => sum + num(e), 0);
    case '*':
      return args.reduce<number>((product, e) => product * num(e), 1);
    case '-':
      return args.length === 1 ? -num(arg(0)) : num(arg(0)) - num(arg(1));
    case '/':
      return num(arg(0)) / num(arg(1));
    case 'max':
      return Math.max(...args.map(num));
    case 'min':
      return Math.min(...args.map(num));
    case 'ceil':
      return Math.ceil(num(arg(0)));
    case 'floor':
      return Math.floor(num(arg(0)));
    case '==':
      return ev(arg(0)) === ev(arg(1));
    case '!=':
      return ev(arg(0)) !== ev(arg(1));
    case '<':
      return num(arg(0)) < num(arg(1));
    case '<=':
      return num(arg(0)) <= num(arg(1));
    case '>':
      return num(arg(0)) > num(arg(1));
    case '>=':
      return num(arg(0)) >= num(arg(1));
    case 'and': {
      let last: unknown = true;
      for (const e of args) {
        last = ev(e);
        if (!truthy(last)) return last;
      }
      return last;
    }
    case 'or': {
      let last: unknown = false;
      for (const e of args) {
        last = ev(e);
        if (truthy(last)) return last;
      }
      return last;
    }
    case 'if': {
      // [cond, then, cond, then, ..., else]
      for (let i = 0; i + 1 < args.length; i += 2) {
        if (truthy(ev(arg(i)))) return ev(arg(i + 1));
      }
      return args.length % 2 === 1 ? ev(arg(args.length - 1)) : null;
    }
  }
}

const isNumeric = (v: unknown): v is number | string =>
  (typeof v === 'number' && Number.isFinite(v)) ||
  (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));

/** Bind every card input from the request body by param name, with defaults. */
export function bindInputs(
  card: RateCard,
  params: Record<string, unknown>
): Vars {
  const vars: Vars = {};
  for (const [name, input] of Object.entries(card.inputs)) {
    const raw = params[input.param];
    const bad = (why: string, value?: unknown) =>
      new RateCardError(
        'bad-input',
        `${name} (${input.param}): ${why}${value === undefined ? '' : ` ${JSON.stringify(value)}`}`
      );
    switch (input.kind) {
      case 'count':
        if (raw === undefined) vars[name] = 0;
        else if (Array.isArray(raw)) vars[name] = raw.length;
        else throw bad('expected a list, got', raw);
        break;
      case 'number': {
        const value = raw ?? input.default;
        if (value === undefined) throw bad('required');
        // Enum-typed durations arrive as strings ("5").
        if (!isNumeric(value)) throw bad('not a number:', value);
        vars[name] = Number(value);
        break;
      }
      case 'boolean': {
        const value = raw ?? input.default;
        if (typeof value !== 'boolean')
          throw bad('expected a boolean, got', value);
        vars[name] = value;
        break;
      }
      case 'enum': {
        const value = raw ?? input.default;
        if (typeof value !== 'string' || !input.values.includes(value)) {
          throw bad(`not one of ${input.values.join('|')}:`, value);
        }
        vars[name] = value;
        break;
      }
      case 'dimensions': {
        const value = raw ?? input.default;
        if (
          isRecord(value) &&
          isNumeric(value.width) &&
          isNumeric(value.height)
        ) {
          vars[name] = {
            width: Number(value.width),
            height: Number(value.height),
          };
          break;
        }
        const preset =
          typeof value === 'string' ? input.presets?.[value] : undefined;
        if (!preset) throw bad('unknown size:', value);
        vars[name] = { width: preset[0], height: preset[1] };
        break;
      }
    }
  }
  return vars;
}

export type RateCardTrace = {
  /** The bound inputs the price was computed from. */
  inputs: Vars;
};

/**
 * USD for one request. Throws `RateCardError` rather than returning a number
 * it cannot stand behind.
 */
export function evaluateRateCard(
  card: RateCard,
  requestParams: Record<string, unknown>
): { usd: number; trace: RateCardTrace } {
  const inputs = bindInputs(card, requestParams);
  const usd = evaluate(card.price, inputs, card.tables);
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) {
    throw new RateCardError(
      'bad-result',
      `price evaluated to ${JSON.stringify(usd)}`
    );
  }
  return { usd, trace: { inputs } };
}

/** Relative tolerance when reproducing a source's worked example. */
const EXAMPLE_TOLERANCE = 0.01;

export type ExampleResult = {
  example: RateCardExample;
  ok: boolean;
  usd?: number;
  error?: string;
};

/** Every worked example must reproduce within 1% or the card is rejected. */
export function verifyRateCardExamples(card: RateCard): ExampleResult[] {
  return card.examples.map((example) => {
    try {
      const { usd } = evaluateRateCard(card, example.params);
      const ok = Math.abs(usd - example.usd) <= example.usd * EXAMPLE_TOLERANCE;
      return ok
        ? { example, ok, usd }
        : { example, ok, usd, error: `expected ${example.usd}, got ${usd}` };
    } catch (error) {
      const message =
        error instanceof RateCardError
          ? `${error.code}: ${error.message}`
          : String(error);
      return { example, ok: false, error: message };
    }
  });
}
