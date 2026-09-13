import { describe, expect, it } from 'vitest';

import { createServerFnIdGenerator } from './server-fn-id';

describe('createServerFnIdGenerator', () => {
  it('gives the same id after a file move', () => {
    const generate = createServerFnIdGenerator();
    const before = generate({
      filename: 'src/old/place.fn.ts',
      functionName: 'listSequencesFn_createServerFn_handler',
    });
    const after = createServerFnIdGenerator()({
      filename: 'src/new/place.fn.ts',
      functionName: 'listSequencesFn_createServerFn_handler',
    });
    expect(after).toBe(before);
  });

  it('gives different ids to different function names', () => {
    const generate = createServerFnIdGenerator();
    expect(
      generate({
        filename: 'a.fn.ts',
        functionName: 'aFn_createServerFn_handler',
      })
    ).not.toBe(
      generate({
        filename: 'a.fn.ts',
        functionName: 'bFn_createServerFn_handler',
      })
    );
  });

  it('is stable when the same file is compiled twice (client + ssr)', () => {
    const generate = createServerFnIdGenerator();
    const opts = {
      filename: 'a.fn.ts',
      functionName: 'aFn_createServerFn_handler',
    };
    expect(generate(opts)).toBe(generate(opts));
  });

  it('throws when two files share a function name', () => {
    const generate = createServerFnIdGenerator();
    generate({
      filename: 'a.fn.ts',
      functionName: 'dupFn_createServerFn_handler',
    });
    expect(() =>
      generate({
        filename: 'b.fn.ts',
        functionName: 'dupFn_createServerFn_handler',
      })
    ).toThrow(/Duplicate server function name "dupFn_createServerFn_handler"/);
  });
});
