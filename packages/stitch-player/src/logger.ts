/** Where the player reports a non-fatal problem (a failed prefetch, a clip whose sound would not decode). Defaults to `console`. */
export type StitchLogger = {
  warn: (message: string, context?: Record<string, unknown>) => void;
};
