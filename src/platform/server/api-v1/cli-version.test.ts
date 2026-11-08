import { describe, expect, it } from 'vitest';

import {
  CLI_VERSION_HEADER,
  cliVersionRefusal,
  MIN_CLI_VERSION,
} from './cli-version';

const withVersion = (version: string) =>
  new Headers({ [CLI_VERSION_HEADER]: version });

describe('cliVersionRefusal', () => {
  it('blocks nothing at the starting minimum', () => {
    expect(MIN_CLI_VERSION).toBe('0.0.0');
    expect(cliVersionRefusal(withVersion('0.0.1'))).toBeNull();
  });

  it('passes a request without the header (browsers, other clients)', () => {
    expect(cliVersionRefusal(new Headers(), '9.9.9')).toBeNull();
  });

  it('answers 426 to a lower version, naming the update', async () => {
    const response = cliVersionRefusal(withVersion('0.1.9'), '0.2.0');
    if (!response) throw new Error('expected a refusal');
    expect(response.status).toBe(426);
    const body: { error: { code: string; message: string } } =
      await response.json();
    expect(body.error.code).toBe('CLI_TOO_OLD');
    expect(body.error.message).toContain('Update @openstory/cli');
  });

  it('passes an equal or higher version, and an unreadable one', () => {
    expect(cliVersionRefusal(withVersion('0.2.0'), '0.2.0')).toBeNull();
    expect(cliVersionRefusal(withVersion('0.10.0'), '0.2.0')).toBeNull();
    expect(cliVersionRefusal(withVersion('dev'), '0.2.0')).toBeNull();
  });
});
