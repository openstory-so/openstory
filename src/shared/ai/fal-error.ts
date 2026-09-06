/**
 * Extract a meaningful error message from fal.ai API errors.
 *
 * The `@fal-ai/client` throws `ApiError`/`ValidationError` with the full
 * response body on `error.body`, but `.message` only contains
 * `body.message || statusText` — which for 422s is just "Unprocessable Entity".
 *
 * The actual detail lives in `error.body.detail` (FastAPI/Pydantic format).
 * Some fal endpoints (and the aimock fal handler used in e2e replay) instead
 * return an OpenAI-style `{ error: { message } }` body, so we also fall back to
 * that shape — otherwise the fal client surfaces only `statusText`
 * ("Unprocessable Entity") and the real reason is lost.
 */
type FalErrorBody = {
  detail?: Array<{ msg: string; type?: string; loc?: string[] }> | string;
  error?: { message?: string } | string;
  message?: string;
};

export function extractFalErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  // Check for fal-ai client error shape: { body: { detail: ... }, status: number }
  const falError = error as Error & {
    body?: FalErrorBody;
    status?: number;
  };
  const body = falError.body;

  if (body?.detail) {
    const { detail } = body;

    if (typeof detail === 'string') {
      return detail;
    }

    if (Array.isArray(detail) && detail.length > 0) {
      // Join all detail messages, each prefixed by the input it names
      // (`body.prompt: …; body.image_url: …`). A content flag on the still
      // and one on the prompt read identically without it (#1373); the
      // prefix is what `flaggedInputs` classifies on.
      return detail
        .map((d) => (d.loc?.length ? `${d.loc.join('.')}: ${d.msg}` : d.msg))
        .join('; ');
    }
  }

  // OpenAI-style `{ error: { message } }` / `{ error: "..." }`.
  if (body?.error) {
    const bodyError = body.error;
    if (typeof bodyError === 'string') return bodyError;
    if (typeof bodyError.message === 'string') return bodyError.message;
  }

  if (typeof body?.message === 'string') return body.message;

  return error.message;
}
