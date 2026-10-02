import { describe, expect, it } from 'vitest';
import { formatBetterAuthLog } from './format-better-auth-log';

describe('formatBetterAuthLog', () => {
  it('puts Better Auth errors and their causes in the visible message', () => {
    const cause = new Error('Multiple accounts match the same accountId');
    const wrapper = new Error('Unable to query your database', { cause });

    expect(formatBetterAuthLog('Error:', [wrapper])).toBe(
      'Error: Error: Unable to query your database — caused by Error: Multiple accounts match the same accountId'
    );
  });

  it('leaves logs without errors unchanged', () => {
    expect(formatBetterAuthLog('Warning', [{ context: 'auth' }])).toBe(
      'Warning'
    );
  });

  it('bounds cyclic cause chains', () => {
    const error = new Error('cycle');
    error.cause = error;
    expect(formatBetterAuthLog('Error:', [error]).match(/cycle/g)).toHaveLength(
      5
    );
  });
});
