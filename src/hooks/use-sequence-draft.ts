import { useCallback, useEffect, useState } from 'react';
import {
  clearSequenceDraft,
  EMPTY_SEQUENCE_DRAFT,
  readSequenceDraft,
  writeSequenceDraft,
  type PersistableSequenceDraft,
  type SequenceDraft,
} from '@/lib/sequences/sequence-draft';

export function useSequenceDraft() {
  const [draft, setDraft] = useState<SequenceDraft>(EMPTY_SEQUENCE_DRAFT);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const loaded = readSequenceDraft();
    if (loaded) {
      setDraft(loaded);
    }
    setIsLoaded(true);
  }, []);

  const saveDraft = useCallback((data: PersistableSequenceDraft) => {
    setDraft({ ...data, savedAt: Date.now() });
    writeSequenceDraft(data);
  }, []);

  const clearDraft = useCallback(() => {
    setDraft(EMPTY_SEQUENCE_DRAFT);
    clearSequenceDraft();
  }, []);

  return { draft, isLoaded, saveDraft, clearDraft };
}
