/**
 * MCP Apps view for `get_sequence` (#1673): one self-contained HTML document,
 * no bundle and no SDK. It speaks the MCP Apps postMessage protocol
 * (`ui/initialize` → `ui/notifications/initialized`, then
 * `ui/notifications/tool-result`) and renders the tool's structured result
 * with the DOM API only (text via `textContent`, never `innerHTML`). Media
 * load by URL; the resource's CSP declares their origins.
 *
 * While the run is processing, the card polls `get_sequence_status` through
 * the host (`tools/call`, so no model turns) and, when the run ends, posts one
 * `ui/message` so the agent picks up without polling. It writes nothing.
 */

export const SEQUENCE_CARD_URI = 'ui://openstory/sequence-card.html';

// ponytail: each open card polls and announces on its own; two cards of one
// run post two messages. Share a watcher if hosts start keeping many open.
const POLL_MS = 10_000;
/** An hour of polling, then the card stops and shows the last status. */
const POLL_LIMIT = 360;

/** The page's bridge, exported so a test can run it against a fake window. */
export const SEQUENCE_CARD_SCRIPT = `(() => {
  const post = (message) => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const byId = (id) => document.getElementById(id);
  let lastHeight = -1;
  let nextId = 2;
  const pending = new Map();
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      post({ id, method, params });
    });
  let canCallTools = false;
  let canOpenLinks = false;
  let current = null;
  let watching = false;

  const reportSize = () => {
    const height = Math.ceil(document.documentElement.scrollHeight);
    if (height === lastHeight) return;
    lastHeight = height;
    post({ method: 'ui/notifications/size-changed', params: { height } });
  };
  const watchSize = () => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => requestAnimationFrame(reportSize));
    observer.observe(document.documentElement);
    observer.observe(document.body);
  };

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

  const showError = (text) => {
    byId('title').textContent = 'Sequence unavailable';
    const error = byId('error');
    error.textContent = text;
    error.hidden = false;
    reportSize();
  };

  const render = (data) => {
    byId('title').textContent = data.title || 'Untitled sequence';
    const style = data.style && data.style.name;
    byId('meta').textContent = [data.status, style, data.aspectRatio].filter(Boolean).join(' · ');
    const poster = byId('poster');
    if (data.poster && data.poster.url) {
      poster.onload = reportSize;
      // A row on a host the CSP does not allow: hide it, not a broken image.
      poster.onerror = () => { poster.hidden = true; reportSize(); };
      poster.src = data.poster.url;
      poster.alt = 'Poster for ' + (data.title || 'the sequence');
      poster.hidden = false;
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
    const open = byId('open');
    if (data.appUrl) {
      open.href = data.appUrl;
      open.hidden = false;
    }
    const music = byId('music');
    if (data.music && data.music.url && music.src !== data.music.url) {
      music.src = data.music.url;
      music.hidden = false;
    }
    reportSize();
  };

  const POLL_MS = ${POLL_MS};
  const POLL_LIMIT = ${POLL_LIMIT};
  const announce = (data) => {
    const counts = data.counts || {};
    const text =
      'OpenStory: "' + (current.title || 'Untitled sequence') + '" (' + current.id + ') finished: ' +
      data.status + '. ' + (counts.videosReady || 0) + '/' + (counts.shots || 0) + ' videos ready.';
    request('ui/message', { role: 'user', content: [{ type: 'text', text }] }).catch(() => {});
  };
  // Stops on any failed call: a host that refuses once will refuse again, and
  // the card keeps showing the last status it read.
  const watch = () => {
    if (watching || !canCallTools || !current || !current.id) return;
    if (current.sequenceStatus !== 'processing') return;
    watching = true;
    let polls = 0;
    const tick = () =>
      request('tools/call', {
        name: 'openstory.get_sequence_status',
        arguments: { sequenceId: current.id },
      }).then((result) => {
        const data = result && result.structuredContent;
        if (!data || result.isError) return;
        current = { ...current, status: data.status, sequenceStatus: data.sequenceStatus, counts: data.counts };
        render(current);
        if (data.sequenceStatus !== 'processing') return announce(data);
        if (++polls < POLL_LIMIT) setTimeout(tick, POLL_MS);
      }, () => {});
    setTimeout(tick, POLL_MS);
  };

  const onToolResult = (result) => {
    const data = result && result.structuredContent;
    if (!result || result.isError || !data || typeof data !== 'object') {
      const text =
        (data && data.error && data.error.message) ||
        (result && result.content && result.content[0] && result.content[0].text) ||
        'The sequence could not be loaded.';
      showError(text);
      return;
    }
    current = data;
    render(data);
    watch();
  };

  // A sandboxed frame may not navigate: ask the host to open the app.
  byId('open').addEventListener('click', (event) => {
    if (!canOpenLinks) return;
    event.preventDefault();
    request('ui/open-link', { url: byId('open').href }).catch(() => {});
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (!message.method && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(message.error);
      else resolve(message.result);
      return;
    }
    if (message.id === 1 && !message.method) {
      if (message.error) {
        showError('This host could not start the view.');
        return;
      }
      applyHost(message.result && message.result.hostContext);
      const host = message.result && message.result.hostCapabilities;
      canCallTools = Boolean(host && host.serverTools);
      canOpenLinks = Boolean(host && host.openLinks);
      post({ method: 'ui/notifications/initialized', params: {} });
      watchSize();
      watch();
      return;
    }
    if (message.method && message.id !== undefined) {
      // Host -> View requests: teardown and ping need an answer.
      if (message.method === 'ui/resource-teardown' || message.method === 'ping') {
        post({ id: message.id, result: {} });
      } else {
        post({ id: message.id, error: { code: -32601, message: 'Method not found' } });
      }
      return;
    }
    if (message.method === 'ui/notifications/tool-result') {
      onToolResult(message.params);
    } else if (message.method === 'ui/notifications/tool-cancelled') {
      showError('The request was cancelled.');
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
})();`;

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
  img { width: 100%; height: auto; border-radius: 8px; }
  h1 { margin: 0; font-size: 1.1rem; }
  .muted { color: var(--color-text-secondary, GrayText); font-size: 0.875rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; font-size: 0.875rem; font-variant-numeric: tabular-nums; }
  dt { color: var(--color-text-secondary, GrayText); }
  dd { margin: 0; }
  audio { width: 100%; }
  a { color: var(--color-text-info, LinkText); font-size: 0.875rem; }
  .error { color: var(--color-text-danger, #b00020); }
</style>
</head>
<body>
<div class="card">
  <img id="poster" alt="" hidden>
  <div>
    <h1 id="title">Loading…</h1>
    <div class="muted" id="meta"></div>
    <div class="error" id="error" role="alert" hidden></div>
  </div>
  <dl id="counts"></dl>
  <a id="open" target="_blank" rel="noopener" hidden>Open in OpenStory</a>
  <audio id="music" controls preload="none" hidden></audio>
</div>
<script>
${SEQUENCE_CARD_SCRIPT}
</script>
</body>
</html>
`;
