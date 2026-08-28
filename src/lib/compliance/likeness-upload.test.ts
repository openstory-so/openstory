import { describe, expect, it } from 'vitest';
import { ASSET_RIGHTS_V1, PORTRAIT_RIGHTS_V1 } from './attestations';
import { requireUploadAttestation } from './likeness-upload';
import { AttestationRequiredError, ValidationError } from '@/lib/errors';

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

  it('requires the asset statement and no basis for animated/other', () => {
    expect(
      requireUploadAttestation({
        depictsRealPerson: false,
        attestation: { statementVersion: ASSET_RIGHTS_V1.version },
      })
    ).toEqual({
      statementVersion: ASSET_RIGHTS_V1.version,
      authorizationBasis: '',
    });
  });

  it('rejects the wrong statement version', () => {
    expect(() =>
      requireUploadAttestation({
        depictsRealPerson: false,
        attestation: {
          statementVersion: PORTRAIT_RIGHTS_V1.version,
          authorizationBasis: 'n/a',
        },
      })
    ).toThrow(ValidationError);
  });
});
