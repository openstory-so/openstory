/**
 * Renders an email template to HTML + plain text.
 *
 * Deliberately NOT @react-email/render's `render()`: its edge build resolves
 * react-dom via `import("react-dom/server.edge").catch(() => import("react-dom/server"))`,
 * and Rolldown rewrites both dynamic imports to the worker entry chunk,
 * unwrapping the wrong export — `renderToReadableStream is not a function` at
 * runtime on deployed workers (#841). A static import of react-dom/server.edge
 * bundles correctly (TanStack Router's SSR uses the same pattern).
 *
 * Templates no longer suspend (inline styles, no `<Tailwind>`). The stream
 * API is kept so the import of `react-dom/server.edge` stays static.
 */

import { toPlainText } from '@react-email/components';
import type { ReactElement } from 'react';
import { renderToReadableStream } from 'react-dom/server.edge';

// Same doctype @react-email/render emits — XHTML transitional renders most
// consistently across email clients.
const DOCTYPE =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">';

export async function renderEmail(element: ReactElement): Promise<{
  html: string;
  text: string;
}> {
  const stream = await renderToReadableStream(element, {
    // Emit in one chunk — no progressive-rendering placeholders in the HTML.
    progressiveChunkSize: Number.POSITIVE_INFINITY,
  });
  // Start consuming before awaiting allReady so rendering can't stall on
  // stream backpressure.
  const consumed = new Response(stream).text();
  await stream.allReady;
  // React's streaming renderer auto-emits an HTML5 doctype before <html> —
  // strip it so the XHTML doctype isn't doubled up.
  const markup = (await consumed).replace(/<!DOCTYPE.*?>/, '');
  return { html: `${DOCTYPE}${markup}`, text: toPlainText(markup) };
}
