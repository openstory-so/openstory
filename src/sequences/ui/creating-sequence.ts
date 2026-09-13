/**
 * In-flight Generate (#1601).
 *
 * The click leaves the composer immediately for `/sequences/new/scenes`,
 * which paints the script while `createSequenceFn` runs. The id is not
 * minted on the client — when create returns, the creating page
 * `replace`s the URL with `/sequences/$id/scenes`.
 *
 * Memory for the same tick; sessionStorage so a fast remount still has it.
 * Short expiry: a stale park must not fire a generation the user no longer
 * expects.
 */
import type { GenerationStage } from '@/sequences/pipeline';
import type { CreateSequenceInput } from '@/sequences/server/sequence.schemas';

const STORAGE_KEY = 'openstory:creating-sequence:v1';
const EXPIRY_MS = 10 * 60 * 1000;

export type CreatingSequence = {
  payload: CreateSequenceInput;
  script: string;
  stopAt: GenerationStage;
  generateStartFrames: boolean;
  parkedAt: number;
};

let memory: CreatingSequence | null = null;
let createStarted = false;

function isCreatingSequence(value: unknown): value is CreatingSequence {
  if (typeof value !== 'object' || value === null) return false;
  if (!('script' in value) || !('parkedAt' in value) || !('payload' in value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.script === 'string' &&
    typeof record.parkedAt === 'number' &&
    typeof record.payload === 'object' &&
    record.payload !== null
  );
}

function readStorage(): CreatingSequence | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      !isCreatingSequence(parsed) ||
      Date.now() - parsed.parkedAt > EXPIRY_MS
    ) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function parkCreatingSequence(
  input: Omit<CreatingSequence, 'parkedAt'>
): void {
  const next: CreatingSequence = { ...input, parkedAt: Date.now() };
  memory = next;
  createStarted = false;
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // sessionStorage unavailable — memory still holds it for this tick.
  }
}

export function peekCreatingSequence(): CreatingSequence | null {
  if (memory && Date.now() - memory.parkedAt <= EXPIRY_MS) return memory;
  memory = readStorage();
  return memory;
}

export function clearCreatingSequence(): void {
  memory = null;
  createStarted = false;
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing stored to clear
  }
}

/** True the first time; false if create was already kicked off (Strict Mode). */
export function claimCreatingSequenceStart(): boolean {
  if (createStarted) return false;
  createStarted = true;
  return true;
}
