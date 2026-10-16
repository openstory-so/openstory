/**
 * The `readAheadSeconds` a host passes when it has no reason to choose
 * (#2124): seconds of media fetched ahead of the playhead before play starts
 * and after a stall. Suits clips of a few seconds on an ordinary link; a slow
 * link wants more, at the cost of a longer first wait.
 */
export const DEFAULT_READ_AHEAD_SECONDS = 6;
