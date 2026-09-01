#!/usr/bin/env bun
/**
 * Memory profiling visualizer for workflow execution
 *
 * Usage:
 *   bun scripts/memory-profile.ts              # Fetch samples, generate chart, open in browser
 *   bun scripts/memory-profile.ts --watch      # Poll every 2s, regenerate chart
 *   bun scripts/memory-profile.ts --json       # Raw JSON output
 *   bun scripts/memory-profile.ts --clear      # Clear samples
 */

/**
 * Memory profiling visualizer for workflow execution
 *
 * Usage:
 *   bun scripts/memory-profile.ts              # Fetch samples, generate chart, open in browser
 *   bun scripts/memory-profile.ts --watch      # Poll every 2s, regenerate chart
 *   bun scripts/memory-profile.ts --json       # Raw JSON output
 *   bun scripts/memory-profile.ts --clear      # Clear samples
 */

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

// oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- env var can be undefined at runtime
const BASE_URL = process.env.VITE_APP_URL ?? 'http://localhost:3000';
const API_URL = `${BASE_URL}/api/dev/memory`;
const OUTPUT_PATH = '.output/memory-profile.html';
const CF_MEMORY_LIMIT_MB = 128;

type MemorySample = {
  timestamp: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  workflow: string;
  label: string;
};

async function fetchSamples(): Promise<MemorySample[]> {
  const res = await fetch(API_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch memory samples: ${res.status} ${res.statusText}`
    );
  }
  const data: { sampleCount: number; samples: MemorySample[] } =
    await res.json();
  return data.samples;
}

async function clearSamples(): Promise<void> {
  const res = await fetch(API_URL, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`Failed to clear samples: ${res.status} ${res.statusText}`);
  }
  console.log('Memory samples cleared.');
}

function toMB(bytes: number): number {
  return bytes / 1024 / 1024;
}

function generateHTML(samples: MemorySample[]): string {
  const samplesJSON = JSON.stringify(samples);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Memory Profile — Workflow Execution</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e5e5e5; padding: 24px; }
    h1 { font-size: 18px; font-weight: 500; margin-bottom: 4px; }
    .subtitle { font-size: 13px; color: #888; margin-bottom: 20px; }
    .stats { display: flex; gap: 24px; margin-bottom: 20px; font-size: 13px; }
    .stat { display: flex; flex-direction: column; gap: 2px; }
    .stat-label { color: #888; }
    .stat-value { font-variant-numeric: tabular-nums; font-weight: 600; }
    .chart-container { position: relative; background: #141414; border: 1px solid #262626; border-radius: 8px; padding: 16px; }
    canvas { width: 100%; height: 400px; }
    .legend { display: flex; gap: 16px; margin-top: 12px; font-size: 12px; }
    .legend-item { display: flex; align-items: center; gap: 6px; }
    .legend-dot { width: 10px; height: 10px; border-radius: 2px; }
    .samples-table { margin-top: 24px; font-size: 12px; width: 100%; border-collapse: collapse; }
    .samples-table th, .samples-table td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #262626; font-variant-numeric: tabular-nums; }
    .samples-table th { color: #888; font-weight: 500; position: sticky; top: 0; background: #0a0a0a; }
    .samples-table tr:hover td { background: #1a1a1a; }
    .empty { text-align: center; padding: 80px 0; color: #666; }
  </style>
</head>
<body>
  <h1>Memory Profile</h1>
  <div class="subtitle">Workflow execution memory usage over time</div>

  <div class="stats" id="stats"></div>

  <div class="chart-container">
    <canvas id="chart"></canvas>
    <div class="legend">
      <div class="legend-item"><div class="legend-dot" style="background:#ef4444"></div>RSS</div>
      <div class="legend-item"><div class="legend-dot" style="background:#3b82f6"></div>Heap Used</div>
      <div class="legend-item"><div class="legend-dot" style="background:#6366f1"></div>Heap Total</div>
      <div class="legend-item"><div class="legend-dot" style="background:#f59e0b;opacity:0.5"></div>External</div>
      <div class="legend-item"><div class="legend-dot" style="background:#ef4444;opacity:0.3"></div>${CF_MEMORY_LIMIT_MB}MB CF Limit</div>
    </div>
  </div>

  <table class="samples-table" id="table">
    <thead><tr>
      <th>Time</th><th>Workflow</th><th>Phase</th><th>RSS</th><th>Heap Used</th><th>Heap Total</th><th>External</th>
    </tr></thead>
    <tbody id="table-body"></tbody>
  </table>

  <script>
    const samples = ${samplesJSON};
    const CF_LIMIT_MB = ${CF_MEMORY_LIMIT_MB};

    function toMB(bytes) { return bytes / 1024 / 1024; }

    if (samples.length === 0) {
      document.querySelector('.chart-container').replaceChildren(
        Object.assign(document.createElement('div'), { className: 'empty', textContent: 'No samples yet. Generate a sequence and refresh.' })
      );
    } else {
      renderStats();
      renderChart();
      renderTable();
    }

    function createStat(label, value) {
      const div = document.createElement('div');
      div.className = 'stat';
      const labelEl = document.createElement('span');
      labelEl.className = 'stat-label';
      labelEl.textContent = label;
      const valueEl = document.createElement('span');
      valueEl.className = 'stat-value';
      valueEl.textContent = value;
      div.append(labelEl, valueEl);
      return div;
    }

    function renderStats() {
      const peakRSS = Math.max(...samples.map(s => s.rss));
      const peakHeap = Math.max(...samples.map(s => s.heapUsed));
      const duration = (samples[samples.length - 1].timestamp - samples[0].timestamp) / 1000;
      const workflows = [...new Set(samples.map(s => s.workflow))];

      const container = document.getElementById('stats');
      container.replaceChildren(
        createStat('Peak RSS', toMB(peakRSS).toFixed(1) + ' MB'),
        createStat('Peak Heap', toMB(peakHeap).toFixed(1) + ' MB'),
        createStat('Duration', duration.toFixed(1) + 's'),
        createStat('Samples', String(samples.length)),
        createStat('Workflows', workflows.join(', '))
      );
    }

    function renderChart() {
      const canvas = document.getElementById('chart');
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      const W = rect.width;
      const H = rect.height;
      const pad = { top: 20, right: 20, bottom: 40, left: 60 };
      const plotW = W - pad.left - pad.right;
      const plotH = H - pad.top - pad.bottom;

      const t0 = samples[0].timestamp;
      const tMax = samples[samples.length - 1].timestamp - t0;
      const allValues = samples.flatMap(s => [s.rss, s.heapTotal, s.heapUsed, s.external]);
      const yMaxBytes = Math.max(...allValues, CF_LIMIT_MB * 1024 * 1024) * 1.1;

      function xPos(ts) { return pad.left + (tMax > 0 ? ((ts - t0) / tMax) * plotW : plotW / 2); }
      function yPos(bytes) { return pad.top + plotH - (bytes / yMaxBytes) * plotH; }

      // Grid lines
      ctx.strokeStyle = '#262626';
      ctx.lineWidth = 1;
      const ySteps = 5;
      for (let i = 0; i <= ySteps; i++) {
        const y = pad.top + (plotH / ySteps) * i;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(W - pad.right, y);
        ctx.stroke();

        const mb = toMB(yMaxBytes * (1 - i / ySteps));
        ctx.fillStyle = '#666';
        ctx.font = '11px system-ui';
        ctx.textAlign = 'right';
        ctx.fillText(mb.toFixed(0) + ' MB', pad.left - 8, y + 4);
      }

      // Time axis labels
      const tSteps = Math.min(8, samples.length);
      ctx.textAlign = 'center';
      for (let i = 0; i <= tSteps; i++) {
        const t = (tMax / tSteps) * i;
        const x = xPos(t0 + t);
        ctx.fillStyle = '#666';
        ctx.fillText((t / 1000).toFixed(1) + 's', x, H - pad.bottom + 20);
      }

      // CF memory limit line
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.3)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const limitY = yPos(CF_LIMIT_MB * 1024 * 1024);
      ctx.moveTo(pad.left, limitY);
      ctx.lineTo(W - pad.right, limitY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.4)';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(CF_LIMIT_MB + ' MB limit', W - pad.right, limitY - 4);

      // Draw data lines
      function drawLine(key, color, width) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        samples.forEach((s, i) => {
          const x = xPos(s.timestamp);
          const y = yPos(s[key]);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }

      drawLine('external', 'rgba(245, 158, 11, 0.4)', 1);
      drawLine('heapTotal', '#6366f1', 1.5);
      drawLine('heapUsed', '#3b82f6', 2);
      drawLine('rss', '#ef4444', 2);

      // Workflow step markers
      let lastWorkflow = '';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'left';
      samples.forEach((s) => {
        if (s.label === 'before' && s.workflow !== lastWorkflow) {
          lastWorkflow = s.workflow;
          const x = xPos(s.timestamp);
          ctx.strokeStyle = 'rgba(255,255,255,0.15)';
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 3]);
          ctx.beginPath();
          ctx.moveTo(x, pad.top);
          ctx.lineTo(x, pad.top + plotH);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.save();
          ctx.translate(x + 3, pad.top + 4);
          ctx.rotate(Math.PI / 4);
          ctx.fillText(s.workflow, 0, 0);
          ctx.restore();
        }
      });
    }

    function renderTable() {
      const t0 = samples[0].timestamp;
      const tbody = document.getElementById('table-body');
      const fragment = document.createDocumentFragment();

      for (const s of samples) {
        const tr = document.createElement('tr');
        const cells = [
          ((s.timestamp - t0) / 1000).toFixed(2) + 's',
          s.workflow,
          s.label,
          toMB(s.rss).toFixed(1) + ' MB',
          toMB(s.heapUsed).toFixed(1) + ' MB',
          toMB(s.heapTotal).toFixed(1) + ' MB',
          toMB(s.external).toFixed(1) + ' MB',
        ];
        for (const text of cells) {
          const td = document.createElement('td');
          td.textContent = text;
          tr.appendChild(td);
        }
        fragment.appendChild(tr);
      }

      tbody.appendChild(fragment);
    }
  </script>
</body>
</html>`;
}

async function mainLoop() {
  const args = process.argv.slice(2);
  const mode = args[0];

  if (mode === '--clear') {
    await clearSamples();
    return;
  }

  if (mode === '--json') {
    const samples = await fetchSamples();
    console.log(JSON.stringify(samples, null, 2));
    return;
  }

  if (mode === '--watch') {
    await watchLoop();
    return;
  }

  // Default: fetch, generate, open
  await runOnce();
}

async function watchLoop() {
  console.log('Watching memory profile (Ctrl+C to stop)...');
  let opened = false;
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- intentional infinite loop
  while (true) {
    try {
      const samples = await fetchSamples();
      const html = generateHTML(samples);
      await writeFile(OUTPUT_PATH, html);
      const peakRSS = samples.length
        ? toMB(Math.max(...samples.map((s) => s.rss))).toFixed(1)
        : '0';
      console.log(
        `[${new Date().toLocaleTimeString()}] ${samples.length} samples, peak RSS: ${peakRSS} MB`
      );
      if (!opened) {
        spawn('open', [OUTPUT_PATH], { detached: true, stdio: 'ignore' });
        opened = true;
      }
    } catch (error) {
      console.error(
        'Fetch error:',
        error instanceof Error ? error.message : error
      );
    }
    await sleep(2000);
  }
}

async function runOnce() {
  const samples = await fetchSamples();
  if (samples.length === 0) {
    console.log('No memory samples collected yet.');
    console.log('Start a sequence generation, then run this again.');
    return;
  }

  const html = generateHTML(samples);
  await writeFile(OUTPUT_PATH, html);
  console.log(`Generated ${OUTPUT_PATH} with ${samples.length} samples.`);
  console.log(
    `Peak RSS: ${toMB(Math.max(...samples.map((s) => s.rss))).toFixed(1)} MB`
  );
  spawn('open', [OUTPUT_PATH], { detached: true, stdio: 'ignore' });
}

void mainLoop();
