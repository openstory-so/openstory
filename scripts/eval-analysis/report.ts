import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Effort } from './caller';

export type EvalRow = {
  key: string;
  model: string;
  modelName: string;
  family: string;
  candidate: boolean;
  vision: boolean;
  effort: Effort;
  call: string;
  ok: boolean;
  quality: number;
  structural: number;
  judge: number | undefined;
  totalMs: number;
  ttftMs: number | undefined;
  costUsd: number | undefined;
  promptTokens: number | undefined;
  completionTokens: number | undefined;
  error: string | undefined;
  details: Record<string, unknown>;
};

const CALL_LABEL: Record<string, string> = {
  'split-screenplay': 'Scene split (screenplay)',
  'split-prose': 'Scene split (prose)',
  bibles: 'Bibles',
  'auto-style': 'Auto style',
  talent: 'Talent match',
  location: 'Location match',
  visual: 'Visual prompt',
  motion: 'Motion prompt + vision',
  music: 'Music design',
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

type Agg = {
  model: string;
  modelName: string;
  family: string;
  candidate: boolean;
  effort: Effort;
  quality: number;
  latencyMs: number;
  costUsd: number;
  okRate: number;
  n: number;
};

function aggregate(rows: EvalRow[]): Agg[] {
  const map = new Map<string, EvalRow[]>();
  for (const row of rows) {
    const k = `${row.model}|${row.effort}`;
    const list = map.get(k) ?? [];
    list.push(row);
    map.set(k, list);
  }
  const out: Agg[] = [];
  for (const [, list] of map) {
    const first = list[0];
    if (!first) continue;
    const ok = list.filter((r) => r.ok);
    out.push({
      model: first.model,
      modelName: first.modelName,
      family: first.family,
      candidate: first.candidate,
      effort: first.effort,
      quality: mean(ok.map((r) => r.quality)),
      latencyMs: mean(list.map((r) => r.totalMs)),
      costUsd: mean(list.map((r) => r.costUsd ?? 0)),
      okRate: ok.length / list.length,
      n: list.length,
    });
  }
  return out.sort((a, b) => b.quality - a.quality);
}

function pareto(aggs: Agg[]): Set<string> {
  const ids = new Set<string>();
  for (const a of aggs) {
    const dominated = aggs.some(
      (b) =>
        b !== a &&
        b.quality >= a.quality &&
        b.latencyMs <= a.latencyMs &&
        (b.quality > a.quality || b.latencyMs < a.latencyMs)
    );
    if (!dominated) ids.add(`${a.model}|${a.effort}`);
  }
  return ids;
}

function scatterSvg(aggs: Agg[], title: string): string {
  const W = 720;
  const H = 420;
  const pad = { l: 56, r: 16, t: 36, b: 48 };
  const xs = aggs.map((a) => a.latencyMs / 1000);
  const minX = 0;
  const maxX = Math.max(8, ...xs) * 1.05;
  const minY = 0;
  const maxY = 100;
  const px = (x: number) =>
    pad.l + ((x - minX) / (maxX - minX)) * (W - pad.l - pad.r);
  const py = (y: number) =>
    pad.t + ((maxY - y) / (maxY - minY)) * (H - pad.t - pad.b);
  const colors: Record<string, string> = {
    Anthropic: '#d97706',
    Google: '#2563eb',
    OpenAI: '#16a34a',
    SpaceXAI: '#111827',
    'Z.ai': '#7c3aed',
    DeepSeek: '#0f766e',
    ByteDance: '#db2777',
    Mistral: '#ea580c',
    MoonshotAI: '#4f46e5',
    Qwen: '#9333ea',
    MiniMax: '#0891b2',
    Candidate: '#6b7280',
  };
  const frontier = pareto(aggs);
  const dots = aggs
    .map((a) => {
      const x = px(a.latencyMs / 1000);
      const y = py(a.quality);
      const fill = colors[a.family] ?? '#6b7280';
      const r = frontier.has(`${a.model}|${a.effort}`) ? 7 : 5;
      const stroke = a.candidate ? '#111827' : fill;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${fill}" fill-opacity="${a.candidate ? 0.45 : 0.85}" stroke="${stroke}" stroke-width="${a.candidate ? 2 : 0}"><title>${esc(a.modelName)} ${a.effort} — ${a.quality.toFixed(0)} / ${(a.latencyMs / 1000).toFixed(1)}s</title></circle>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">
  <rect width="${W}" height="${H}" fill="#fff"/>
  <text x="${W / 2}" y="22" text-anchor="middle" font-family="ui-sans-serif,system-ui" font-size="14" font-weight="600">${esc(title)}</text>
  <line x1="${pad.l}" y1="${H - pad.b}" x2="${W - pad.r}" y2="${H - pad.b}" stroke="#d1d5db"/>
  <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${H - pad.b}" stroke="#d1d5db"/>
  <text x="${W / 2}" y="${H - 12}" text-anchor="middle" font-family="ui-sans-serif,system-ui" font-size="11" fill="#6b7280">Latency (seconds) → faster is left</text>
  <text x="16" y="${H / 2}" transform="rotate(-90 16 ${H / 2})" text-anchor="middle" font-family="ui-sans-serif,system-ui" font-size="11" fill="#6b7280">Quality (0–100)</text>
  ${[0, 25, 50, 75, 100].map((v) => `<text x="${pad.l - 8}" y="${py(v) + 4}" text-anchor="end" font-size="10" font-family="ui-sans-serif,system-ui" fill="#6b7280">${v}</text>`).join('')}
  ${dots}
</svg>`;
}

export function writeReport(
  outDir: string,
  rows: EvalRow[]
): {
  htmlPath: string;
  jsonPath: string;
  mdPath: string;
} {
  const jsonPath = resolve(outDir, 'results.json');
  writeFileSync(
    jsonPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2)
  );

  const aggs = aggregate(rows);
  const frontier = pareto(aggs);
  const calls = [...new Set(rows.map((r) => r.call))];

  const perCallSvg = calls
    .map((call) => {
      const callRows = rows.filter((r) => r.call === call);
      const callAgg = aggregate(callRows);
      return `<section><h2>${esc(CALL_LABEL[call] ?? call)}</h2>${scatterSvg(callAgg, CALL_LABEL[call] ?? call)}</section>`;
    })
    .join('\n');

  const tableRows = aggs
    .map((a) => {
      const mark = frontier.has(`${a.model}|${a.effort}`) ? '★' : '';
      const cand = a.candidate ? 'candidate' : '';
      return `<tr>
        <td>${mark} ${esc(a.modelName)}</td>
        <td>${esc(a.effort)}</td>
        <td>${cand}</td>
        <td style="text-align:right">${a.quality.toFixed(1)}</td>
        <td style="text-align:right">${(a.latencyMs / 1000).toFixed(1)}s</td>
        <td style="text-align:right">${(a.okRate * 100).toFixed(0)}%</td>
        <td style="text-align:right">${a.costUsd.toFixed(4)}</td>
      </tr>`;
    })
    .join('\n');

  const chartData = JSON.stringify(
    aggs.map((a) => ({
      x: Number((a.latencyMs / 1000).toFixed(2)),
      y: Number(a.quality.toFixed(1)),
      label: `${a.modelName} (${a.effort})`,
      family: a.family,
      candidate: a.candidate,
    }))
  );

  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8"/>
<title>Analysis LLM speed vs quality</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #111827; }
  h1 { font-size: 1.4rem; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border-bottom: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; }
  .grid { display: grid; gap: 32px; }
  canvas { max-width: 900px; }
</style>
<h1>Analysis pipeline — speed vs quality</h1>
<p>Each point is one (model × reasoning effort) averaged across pipeline calls. ★ = Pareto frontier (nobody is both faster and better). Hollow/outlined = candidate not in the product catalog. Quality is 55% structural + 45% blinded judge where a judge ran; structural-only otherwise.</p>
<canvas id="overall" width="900" height="480"></canvas>
<script>
const points = ${chartData};
const families = [...new Set(points.map(p => p.family))];
const palette = ['#d97706','#2563eb','#16a34a','#111827','#7c3aed','#0f766e','#db2777','#ea580c','#4f46e5','#9333ea','#0891b2'];
new Chart(document.getElementById('overall'), {
  type: 'scatter',
  data: {
    datasets: families.map((f, i) => ({
      label: f,
      data: points.filter(p => p.family === f).map(p => ({ x: p.x, y: p.y, label: p.label })),
      backgroundColor: palette[i % palette.length],
    }))
  },
  options: {
    plugins: {
      tooltip: { callbacks: { label: (c) => c.raw.label + ': ' + c.raw.y + ' @ ' + c.raw.x + 's' } },
      title: { display: true, text: 'Overall: quality vs latency (seconds)' }
    },
    scales: {
      x: { title: { display: true, text: 'Latency (s) — faster is left' }, min: 0 },
      y: { title: { display: true, text: 'Quality (0–100)' }, min: 0, max: 100 }
    }
  }
});
</script>
<h2>Overall ranking</h2>
<table>
  <thead><tr><th>Model</th><th>Effort</th><th></th><th>Quality</th><th>Latency</th><th>OK</th><th>Cost USD</th></tr></thead>
  <tbody>${tableRows}</tbody>
</table>
<div class="grid">
${perCallSvg}
</div>
</html>`;

  const htmlPath = resolve(outDir, 'index.html');
  writeFileSync(htmlPath, html);

  const mdLines = [
    '# Analysis LLM speed vs quality',
    '',
    '★ = Pareto (not dominated on quality AND latency).',
    '',
    '| Model | Effort | Quality | Latency | OK | Cost |',
    '|---|---|---:|---:|---:|---:|',
    ...aggs.map((a) => {
      const star = frontier.has(`${a.model}|${a.effort}`) ? '★ ' : '';
      const cand = a.candidate ? ' *(candidate)*' : '';
      return `| ${star}${a.modelName}${cand} | ${a.effort} | ${a.quality.toFixed(1)} | ${(a.latencyMs / 1000).toFixed(1)}s | ${(a.okRate * 100).toFixed(0)}% | $${a.costUsd.toFixed(4)} |`;
    }),
    '',
  ];
  const mdPath = resolve(outDir, 'summary.md');
  writeFileSync(mdPath, mdLines.join('\n'));

  const svgPath = resolve(outDir, 'overall.svg');
  writeFileSync(svgPath, scatterSvg(aggs, 'Overall quality vs latency'));

  return { htmlPath, jsonPath, mdPath };
}
