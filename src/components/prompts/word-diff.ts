import { diffWords } from 'diff';

export type WordDiffSegment = {
  kind: 'eq' | 'add' | 'del';
  text: string;
};

export function computeWordDiff(
  before: string,
  after: string
): WordDiffSegment[] {
  return diffWords(before, after).map((part) => ({
    kind: part.added ? 'add' : part.removed ? 'del' : 'eq',
    text: part.value,
  }));
}
