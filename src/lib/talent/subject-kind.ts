import { z } from 'zod';

export const talentSubjectKindSchema = z.enum(['human', 'animated', 'other']);
export type TalentSubjectKind = z.infer<typeof talentSubjectKindSchema>;

/** Human wins: mixed uploads take the stronger likeness warrant. */
export function strongestSubjectKind(
  kinds: readonly TalentSubjectKind[]
): TalentSubjectKind {
  if (kinds.includes('human')) return 'human';
  if (kinds.includes('animated')) return 'animated';
  return 'other';
}
