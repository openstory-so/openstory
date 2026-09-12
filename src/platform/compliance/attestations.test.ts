import { describe, expect, it } from 'vitest';
import { sha256Hex } from './hash';
import {
  attestationMatchesShippedText,
  PORTRAIT_RIGHTS_V1,
  ASSET_RIGHTS_V1,
  LIKENESS_CLEARED_V1,
  LIKENESS_DETECTED_V1,
  statementHash,
} from './attestations';

describe('attestations', () => {
  it('demands an authorization basis for the portrait statement only', () => {
    expect(PORTRAIT_RIGHTS_V1.requiresBasis).toBe(true);
    expect(LIKENESS_CLEARED_V1.requiresBasis).toBe(false);
    expect(LIKENESS_DETECTED_V1.requiresBasis).toBe(false);
  });

  it('verifies every statement version the ledger can hold', async () => {
    for (const statement of [
      PORTRAIT_RIGHTS_V1,
      ASSET_RIGHTS_V1,
      LIKENESS_CLEARED_V1,
      LIKENESS_DETECTED_V1,
    ]) {
      expect(
        await attestationMatchesShippedText({
          statementVersion: statement.version,
          statementSha256: await statementHash(statement),
        })
      ).toBe(true);
    }
  });

  it('hashes the statement text verbatim', async () => {
    expect(await statementHash(PORTRAIT_RIGHTS_V1)).toBe(
      await sha256Hex(PORTRAIT_RIGHTS_V1.text)
    );
  });

  it('confirms a stored attestation still matches the shipped wording', async () => {
    const stored = {
      statementVersion: PORTRAIT_RIGHTS_V1.version,
      statementSha256: await statementHash(PORTRAIT_RIGHTS_V1),
    };
    expect(await attestationMatchesShippedText(stored)).toBe(true);
  });

  it('detects wording that was edited in place after being agreed to', async () => {
    expect(
      await attestationMatchesShippedText({
        statementVersion: PORTRAIT_RIGHTS_V1.version,
        statementSha256: await sha256Hex('some older wording'),
      })
    ).toBe(false);
  });

  it('reports a mismatch for an unknown version', async () => {
    expect(
      await attestationMatchesShippedText({
        statementVersion: 'portrait-rights-v99',
        statementSha256: 'deadbeef',
      })
    ).toBe(false);
  });

  it('covers the substance a provider ownership declaration requires', () => {
    expect(ASSET_RIGHTS_V1.text).toContain(
      'similar to the likeness of any real person'
    );
    expect(PORTRAIT_RIGHTS_V1.text).toContain(
      'specifically permits AI generation'
    );
  });
});
