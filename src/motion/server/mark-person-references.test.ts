import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@/platform/compliance/hash';
import { asStub } from '@/test/as-stub';
import { markPersonReferences } from './mark-person-references';

const asStubAttestations = (listForSubjects: unknown) =>
  asStub<
    Parameters<typeof markPersonReferences>[0]['compliance']['attestations']
  >({ listForSubjects });

describe('markPersonReferences', () => {
  it('marks the element and location stills the ledger saw a person in, nothing else (#2238)', async () => {
    const person = '/r2/elements/org/uploads/portrait.png';
    const cleared = '/r2/elements/org/uploads/logo.png';
    const rows = [
      {
        subjectId: await sha256Hex(person),
        statementVersion: 'likeness-detected-v1',
      },
      {
        subjectId: await sha256Hex(cleared),
        statementVersion: 'likeness-cleared-v1',
      },
    ];
    const listForSubjects = vi.fn(async (_type: string, ids: string[]) =>
      rows.filter((row) => ids.includes(row.subjectId))
    );
    const refs = [
      {
        referenceImageUrl: 'https://cdn/sarah.png',
        description: 'Sarah',
        role: 'character' as const,
        isPerson: false,
      },
      {
        referenceImageUrl: person,
        description: 'photo',
        role: 'element' as const,
      },
      {
        referenceImageUrl: cleared,
        description: 'logo',
        role: 'element' as const,
      },
      {
        referenceImageUrl: '/r2/elements/org/uploads/new.png',
        description: 'unchecked',
        role: 'element' as const,
      },
      {
        referenceImageUrl: '/r2/elements/org/uploads/walk.mp4',
        description: 'clip',
        role: 'element' as const,
        kind: 'video' as const,
      },
    ];
    const marked = await markPersonReferences(
      { compliance: { attestations: asStubAttestations(listForSubjects) } },
      refs
    );
    expect(marked).toEqual([
      refs[0],
      { ...refs[1], isPerson: true },
      refs[2],
      refs[3],
      refs[4],
    ]);
    // One batched read, stills only: a clip has its own check.
    expect(listForSubjects).toHaveBeenCalledTimes(1);
    expect(listForSubjects.mock.calls[0][1]).toHaveLength(3);
  });

  it('reads nothing when no element or location still is attached', async () => {
    const listForSubjects = vi.fn(async () => []);
    await markPersonReferences(
      { compliance: { attestations: asStubAttestations(listForSubjects) } },
      [
        {
          referenceImageUrl: 'https://cdn/sarah.png',
          description: 'Sarah',
          role: 'character',
        },
      ]
    );
    expect(listForSubjects).not.toHaveBeenCalled();
  });
});
