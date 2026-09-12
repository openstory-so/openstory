import { describe, expect, it } from 'vitest';
import { PORTRAIT_RIGHTS_V1 } from '@/platform/compliance/attestations';
import { requireUploadAttestation } from './likeness-upload';
import { AttestationRequiredError, ValidationError } from '@/platform/errors';

describe('requireUploadAttestation', () => {
  it('requires a portrait statement and basis for a human', () => {
    expect(() =>
      requireUploadAttestation({
        depictsRealPerson: true,
        attestation: undefined,
      })
    ).toThrow(AttestationRequiredError);

    expect(() =>
      requireUploadAttestation({
        depictsRealPerson: true,
        attestation: {
          statementVersion: PORTRAIT_RIGHTS_V1.version,
          authorizationBasis: '   ',
        },
      })
    ).toThrow(AttestationRequiredError);

    expect(
      requireUploadAttestation({
        depictsRealPerson: true,
        attestation: {
          statementVersion: PORTRAIT_RIGHTS_V1.version,
          authorizationBasis: ' signed release ',
        },
      })
    ).toEqual({
      statementVersion: PORTRAIT_RIGHTS_V1.version,
      authorizationBasis: 'signed release',
    });
  });

  it('asks nothing of animated/other uploads (#1581)', () => {
    expect(
      requireUploadAttestation({
        depictsRealPerson: false,
        attestation: undefined,
      })
    ).toBeNull();
    // A stale client still sending the retired asset statement is ignored.
    expect(
      requireUploadAttestation({
        depictsRealPerson: false,
        attestation: { statementVersion: 'asset-rights-v1' },
      })
    ).toBeNull();
  });

  it('rejects the wrong statement version', () => {
    expect(() =>
      requireUploadAttestation({
        depictsRealPerson: true,
        attestation: {
          statementVersion: 'asset-rights-v1',
          authorizationBasis: 'n/a',
        },
      })
    ).toThrow(ValidationError);
  });
});
