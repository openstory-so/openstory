/**
 * ID Generation Utilities
 * Centralized ID generation for all database entities using ULIDs
 */

import { monotonicFactory, ulid } from 'ulid';

/**
 * Monotonic ULID factory. Unlike the plain `ulid()`, calls within the same
 * millisecond increment the random component so IDs are *strictly* increasing
 * within a process. This makes `ORDER BY id` a reliable insertion order for
 * rows created back-to-back (e.g. the `sequence_events` timeline read via
 * `desc(id)`), instead of the non-deterministic same-ms ordering plain ULIDs
 * give. Output is still a valid, sortable, globally-unique ULID.
 */
const monotonicUlid = monotonicFactory();

/**
 * Generate a ULID (Universally Unique Lexicographically Sortable Identifier)
 *
 * Format: 01ARZ3NDEKTSV4RRFFQ69G5FAV (26 characters)
 *
 * Benefits over UUID v4:
 * - Lexicographically sortable (better index performance)
 * - Timestamp prefix (can extract creation time)
 * - Shorter (26 vs 36 characters)
 * - Still globally unique
 *
 * @returns ULID string
 *
 * @example
 * ```ts
 * const id = generateId();
 * // "01HF5Z8XKQYC5N8Z3KQXR6TBQM"
 * ```
 */
export function generateId(): string {
  return monotonicUlid();
}

/**
 * A ULID that sorts at `time` (ms) rather than now: for a row recording
 * something that happened earlier, e.g. a run that failed before opening its
 * row sorts at its click, not after runs clicked since. Not monotonic: the
 * monotonic factory clamps an earlier time up to the last one it issued.
 */
export function generateIdAt(time: number): string {
  return ulid(time);
}

/**
 * Validate if a string is a valid ULID
 *
 * @param id - String to validate
 * @returns true if valid ULID
 *
 * @example
 * ```ts
 * isValidId('01ARZ3NDEKTSV4RRFFQ69G5FAV'); // true
 * isValidId('invalid'); // false
 * ```
 */
export function isValidId(id: string): boolean {
  // ULID is exactly 26 characters, Crockford's Base32 alphabet
  const ulidRegex = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
  return ulidRegex.test(id);
}
