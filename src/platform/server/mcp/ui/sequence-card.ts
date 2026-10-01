/**
 * MCP Apps view for `get_sequence` (#1673): one self-contained HTML document,
 * no bundle and no SDK. It speaks the MCP Apps postMessage protocol
 * (`ui/initialize` → `ui/notifications/initialized`, then
 * `ui/notifications/tool-result`) and renders the tool's structured result
 * with the DOM API only (text via `textContent`, never `innerHTML`). It calls
 * no tools and writes nothing. Media load by URL; the resource's CSP declares
 * their origins.
 */

export const SEQUENCE_CARD_URI = 'ui://openstory/sequence-card.html';

export const SEQUENCE_CARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sequence</title>
<style>
  :root { color-scheme: light dark; font-family: var(--font-sans, system-ui, sans-serif); }
  body { margin: 0; padding: 12px; background: var(--color-background-primary, transparent); color: var(--color-text-primary, CanvasText); }
  .card { display: flex; flex-direction: column; gap: 12px; }
  img { width: 100%; height: auto; border-radius: 8px; display: block; }
  h1 { margin: 0; font-size: 1.1rem; }
  .muted { color: var(--color-text-secondary, GrayText); font-size: 0.875rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; font-size: 0.875rem; font-variant-numeric: tabular-nums; }
  dt { color: var(--color-text-secondary, GrayText); }
  dd { margin: 0; }
  audio { width: 100%; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<div class="card">
  <img id="poster" alt="" hidden>
  <div>
    <h1 id="title">Loading…</h1>
    <div class="muted" id="meta"></div>
  </div>
  <dl id="counts"></dl>
  <audio id="music" controls preload="none" hidden></audio>
</div>
<script>
(() => {
  const post = (message) => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const byId = (id) => document.getElementById(id);

  const applyHost = (context) => {
    if (!context) return;
    if (context.theme) document.documentElement.style.colorScheme = context.theme;
    const variables = context.styles && context.styles.variables;
    if (variables) {
      for (const [name, value] of Object.entries(variables)) {
        if (typeof value === 'string') document.documentElement.style.setProperty(name, value);
      }
    }
  };

  const reportSize = () => post({
    method: 'ui/notifications/size-changed',
    params: { width: document.body.scrollWidth, height: document.body.scrollHeight },
  });

  const render = (data) => {
    if (!data || typeof data !== 'object') return;
    byId('title').textContent = data.title || 'Untitled sequence';
    const style = data.style && data.style.name;
    byId('meta').textContent = [data.status, style, data.aspectRatio].filter(Boolean).join(' · ');
    const poster = byId('poster');
    if (data.poster && data.poster.url) {
      poster.src = data.poster.url;
      poster.alt = 'Poster for ' + (data.title || 'the sequence');
      poster.hidden = false;
      poster.onload = reportSize;
    }
    const counts = byId('counts');
    counts.replaceChildren();
    for (const [key, value] of Object.entries(data.counts || {})) {
      if (typeof value !== 'number') continue;
      const dt = document.createElement('dt');
      dt.textContent = key.replace(/([A-Z])/g, ' $1').toLowerCase();
      const dd = document.createElement('dd');
      dd.textContent = String(value);
      counts.append(dt, dd);
    }
    const music = byId('music');
    if (data.music && data.music.url) {
      music.src = data.music.url;
      music.hidden = false;
    }
    reportSize();
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id === 1 && message.result) {
      applyHost(message.result.hostContext);
      post({ method: 'ui/notifications/initialized', params: {} });
      return;
    }
    if (message.method === 'ui/notifications/tool-result') {
      render(message.params && message.params.structuredContent);
    } else if (message.method === 'ui/notifications/host-context-changed') {
      applyHost(message.params);
    }
  });

  post({
    id: 1,
    method: 'ui/initialize',
    params: {
      appInfo: { name: 'openstory-sequence-card', version: '1' },
      appCapabilities: {},
      protocolVersion: '2026-01-26',
    },
  });
})();
</script>
</body>
</html>
`;
