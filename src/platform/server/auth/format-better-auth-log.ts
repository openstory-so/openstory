import { serializeError, type SerializedError } from '@/platform/logger';

/** Better Auth sends the useful exception as an extra argument, which the dev
 * console does not render from structured properties. Put each error and its
 * bounded cause chain into the log message itself. */
export function formatBetterAuthLog(message: string, args: unknown[]): string {
  const errors = args.filter((arg): arg is Error => arg instanceof Error);
  if (errors.length === 0) return message;

  return [
    message,
    ...errors.map((error) => formatError(serializeError(error))),
  ].join(' ');
}

function formatError(error: SerializedError | string): string {
  if (typeof error === 'string') return error;
  const label = `${error.name ?? 'Error'}: ${error.message}`;
  return error.cause
    ? `${label} — caused by ${formatError(error.cause)}`
    : label;
}
