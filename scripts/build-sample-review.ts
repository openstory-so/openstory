/**
 * Build a self-contained `sample-review.html` for eyeballing every style's
 * sample video across all rendered sets side by side.
 *
 * For each style it gathers, per set (sample-videos-v1 … sample-videos):
 *   - the canonical .mp4 (referenced by relative path — not inlined)
 *   - that set's eval score (flash) + note
 *   - the enhanced script that produced it (<set>/<slug>/canonical.enhanced.txt)
 * plus the current brief, and for the current set the 4-judge scores
 * (flash / gemini-pro / grok / claude) from eval-judges/.
 *
 * The page lets you ✓/✗ each video; marks persist in localStorage so you can
 * walk the whole library and export the "redo" list.
 *
 * Usage:  bun scripts/build-sample-review.ts
 *         # then open sample-review.html (or: python3 -m http.server, then
 *         #   http://localhost:8000/sample-review.html if file:// blocks video)
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_STYLE_TEMPLATES } from '@/shared/style/style-templates';
import { briefForStyle } from '@/lib/style/sample-videos';
import { styleSlug } from '@/shared/style/style-slug';

const ROOT = process.cwd();

const evalSchema = z.object({
  model: z.string(),
  results: z.array(
    z.object({
      slug: z.string(),
      kind: z.string(),
      verdict: z
        .object({
          overall: z.number(),
          note: z.string().nullish(),
        })
        .nullable(),
    })
  ),
});

type ScoreEntry = { overall: number; note: string | null };

/** slug -> canonical score for one eval-scores.json, or empty if absent. */
function loadCanonicalScores(file: string): Map<string, ScoreEntry> {
  const out = new Map<string, ScoreEntry>();
  if (!existsSync(file)) return out;
  const data = evalSchema.parse(JSON.parse(readFileSync(file, 'utf-8')));
  for (const r of data.results) {
    if (r.kind !== 'canonical' || r.verdict === null) continue;
    if (!out.has(r.slug)) {
      out.set(r.slug, {
        overall: r.verdict.overall,
        note: r.verdict.note ?? null,
      });
    }
  }
  return out;
}

/** Sets (dirs holding canonical.mp4s), ordered v1 < … < vN < bare current. */
function discoverSets(): { dir: string; label: string }[] {
  const versionOf = (d: string): number => {
    const m = /-v(\d+)$/.exec(d);
    return m ? Number(m[1]) : Infinity;
  };
  return readdirSync(ROOT)
    .filter((d) => d === 'sample-videos' || d.startsWith('sample-videos-v'))
    .filter((d) => {
      // The live `sample-videos` set is always a column (the "cur" / newest),
      // even when it holds just a handful of freshly re-rendered fixes.
      if (d === 'sample-videos') return true;
      // Keep any set we deliberately evaluated (has judge files), even if it
      // holds only a partial render — e.g. v8's 9 fully-judged clips.
      const inner = path.join(ROOT, d);
      try {
        const judgeDir = path.join(inner, 'eval-judges');
        const judged = existsSync(judgeDir) && readdirSync(judgeDir).length > 0;
        if (judged) return true;
        // Otherwise skip near-empty versioned sets (e.g. v3/v4 test runs).
        const count = readdirSync(inner).filter((slug) =>
          existsSync(path.join(inner, slug, 'canonical.mp4'))
        ).length;
        return count >= 10;
      } catch {
        return false;
      }
    })
    .sort((a, b) => versionOf(a) - versionOf(b))
    .map((d) => ({
      dir: d,
      label: (/-v(\d+)$/.exec(d)?.[1] ?? 'cur').replace(/^(\d)/, 'v$1'),
    }));
}

type JudgeScore = {
  judge: string;
  overall: number | null;
  note: string | null;
};

type Cell = {
  set: string;
  video: string | null;
  score: number | null;
  note: string | null;
  script: string | null;
  judges: JudgeScore[];
  /** True when this set has its own multi-judge files → render the full block. */
  multi: boolean;
  /** Link to this render's sequence in the main app, if recorded. */
  seqUrl: string | null;
};

type StyleRow = {
  slug: string;
  name: string;
  category: string;
  brief: string;
  /** Current style thumbnail on the public R2 assets bucket. */
  preview: string;
  cells: Cell[];
};

// Same default the upload script uses; override via VITE_R2_PUBLIC_ASSETS_DOMAIN.
const ASSETS_DOMAIN =
  process.env.VITE_R2_PUBLIC_ASSETS_DOMAIN || 'assets.openstory.so';
const previewUrlFor = (slug: string): string =>
  `https://${ASSETS_DOMAIN}/styles/${slug}/thumbnail.webp`;

function readScript(dir: string, slug: string): string | null {
  const f = path.join(ROOT, dir, slug, 'canonical.enhanced.txt');
  return existsSync(f) ? readFileSync(f, 'utf-8').trim() : null;
}

const seqMetaSchema = z.object({
  id: z.string(),
  baseUrl: z.string().url(),
});

/** Link to the rendered sequence on the main app (<baseUrl>/sequences/<id>). */
function readSeqUrl(dir: string, slug: string): string | null {
  const f = path.join(ROOT, dir, slug, 'canonical.sequence.json');
  if (!existsSync(f)) return null;
  const parsed = seqMetaSchema.safeParse(JSON.parse(readFileSync(f, 'utf-8')));
  if (!parsed.success) return null;
  const { id, baseUrl } = parsed.data;
  return `${baseUrl.replace(/\/$/, '')}/sequences/${id}/script`;
}

function main(): void {
  const sets = discoverSets();
  if (sets.length === 0) {
    console.error('No sample-videos*/ dirs with canonical.mp4 found.');
    process.exit(1);
  }

  // Scores are stored PER SET inside that set's own dir, so re-scoring one set
  // can never clobber another:
  //   flash:               <setdir>/eval-scores.json
  //   gemini-pro/grok/…:   <setdir>/eval-judges/<judge>.json
  const JUDGES: { judge: string; file: (dir: string) => string }[] = [
    { judge: 'flash', file: (d) => path.join(ROOT, d, 'eval-scores.json') },
    {
      judge: 'gemini-pro',
      file: (d) => path.join(ROOT, d, 'eval-judges', 'gemini-pro.json'),
    },
    {
      judge: 'grok',
      file: (d) => path.join(ROOT, d, 'eval-judges', 'grok.json'),
    },
    {
      judge: 'sonnet',
      file: (d) => path.join(ROOT, d, 'eval-judges', 'claude.json'),
    },
    {
      judge: 'opus',
      file: (d) => path.join(ROOT, d, 'eval-judges', 'opus.json'),
    },
  ];
  // Per set: each judge's slug→score map, plus whether it has any non-flash
  // judge file (→ render the full multi-judge block rather than flash alone).
  const setJudges = new Map<
    string,
    { judge: string; scores: Map<string, ScoreEntry> }[]
  >();
  const setHasMulti = new Map<string, boolean>();
  for (const s of sets) {
    setJudges.set(
      s.label,
      JUDGES.map((j) => ({
        judge: j.judge,
        scores: loadCanonicalScores(j.file(s.dir)),
      }))
    );
    setHasMulti.set(
      s.label,
      JUDGES.some((j) => j.judge !== 'flash' && existsSync(j.file(s.dir)))
    );
  }
  const curLabel = sets[sets.length - 1]?.label ?? 'cur';

  const styles: StyleRow[] = DEFAULT_STYLE_TEMPLATES.map((style) => {
    const slug = styleSlug(style.name);
    const cells: Cell[] = sets.map((s) => {
      const videoFull = path.join(ROOT, s.dir, slug, 'canonical.mp4');
      const has = existsSync(videoFull);
      const perSet = setJudges.get(s.label) ?? [];
      const flash =
        perSet.find((j) => j.judge === 'flash')?.scores.get(slug) ?? null;
      const judges: JudgeScore[] = perSet.map((j) => {
        const e = j.scores.get(slug);
        return {
          judge: j.judge,
          overall: e?.overall ?? null,
          note: e?.note ?? null,
        };
      });
      return {
        set: s.label,
        video: has ? path.relative(ROOT, videoFull) : null,
        score: flash?.overall ?? null,
        note: flash?.note ?? null,
        script: readScript(s.dir, slug),
        judges,
        multi: setHasMulti.get(s.label) ?? false,
        seqUrl: readSeqUrl(s.dir, slug),
      };
    });
    return {
      slug,
      name: style.name,
      category: style.category ?? '—',
      brief: briefForStyle({ name: style.name, category: style.category }),
      preview: previewUrlFor(slug),
      cells,
    };
  });

  const data = {
    sets: sets.map((s) => s.label),
    curLabel,
    styles,
  };

  const html = render(data);
  const outPath = path.join(ROOT, 'sample-review.html');
  writeFileSync(outPath, html);
  console.log(
    `📄 ${path.relative(ROOT, outPath)} — ${styles.length} styles × ${sets.length} sets (${sets
      .map((s) => s.label)
      .join(', ')})`
  );
  console.log(
    '   open it directly, or: python3 -m http.server  →  http://localhost:8000/sample-review.html'
  );
}

function render(data: unknown): string {
  // Escape `<` so an enhanced script containing "</script>" can't end the tag.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sample video review</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.45 system-ui, sans-serif; background: #121212; color: #e6e6e6; }
  header { position: sticky; top: 0; z-index: 5; background: #1c1c1c; border-bottom: 1px solid #333; padding: 10px 14px; display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  header b { font-size: 15px; }
  .counts span { margin-right: 10px; }
  .ok { color: #5bd66f; } .bad { color: #ff6b6b; } .un { color: #aaa; }
  button { background: #2a2a2a; color: #e6e6e6; border: 1px solid #444; border-radius: 5px; padding: 4px 9px; cursor: pointer; font: inherit; }
  button:hover { background: #333; }
  button.active { border-color: #6aa9ff; color: #6aa9ff; }
  main { padding: 12px; }
  .style { display: flex; gap: 12px; border: 1px solid #2c2c2c; border-radius: 8px; margin-bottom: 14px; background: #181818; }
  .style > .preview { flex: 0 0 240px; width: 240px; height: 240px; object-fit: cover; border-radius: 8px 0 0 8px; background: #000; align-self: flex-start; position: sticky; top: 56px; }
  .style > .body { flex: 1 1 auto; min-width: 0; }
  .style .head { display: flex; gap: 12px; align-items: center; padding: 9px 12px 9px 0; cursor: pointer; }
  .style .name { font-weight: 600; font-size: 14px; }
  .style .cat { color: #888; }
  .style .gradetag { margin-left: auto; color: #bbb; }
  .brief { display: none; padding: 0 12px 10px 12px; color: #cbb; white-space: pre-wrap; border-bottom: 1px solid #262626; }
  .brief.show { display: block; }
  .cols { display: flex; gap: 10px; overflow-x: auto; padding: 10px 12px 14px; }
  .cell { flex: 0 0 300px; border: 2px solid #2c2c2c; border-radius: 7px; padding: 7px; background: #141414; }
  .cell.keep { border-color: #2e7d3a; background: #14210f; }
  .cell.redo { border-color: #a13030; background: #210f0f; }
  .cell.win { border-color: #d4af37; box-shadow: 0 0 0 1px #d4af37 inset; }
  .cell .setlabel { font-weight: 700; display: flex; align-items: center; gap: 7px; }
  .cell .winbadge { margin-right: -3px; }
  .cell .avg { color: #d4af37; font-weight: 600; }
  .cell .seqlink { margin-left: auto; font-weight: 500; color: #6aa9ff; text-decoration: none; }
  .cell .seqlink:hover { text-decoration: underline; }
  .cell .scorerow { color: #bbb; margin: 2px 0 5px; }
  .cell video { width: 284px; height: 284px; object-fit: contain; background: #000; border-radius: 4px; display: block; cursor: pointer; }
  .cell .none { width: 284px; height: 284px; display: flex; align-items: center; justify-content: center; color: #555; background: #0d0d0d; border-radius: 4px; }
  .judges { font-size: 12px; color: #cbb; margin: 2px 0 5px; }
  .judges b { color: #e6e6e6; }
  .jrow { margin: 1px 0; }
  .jnote { color: #c2a; }
  .marks { display: flex; gap: 6px; margin-top: 6px; }
  .marks button { flex: 1; }
  .marks .keepb.on { background: #2e7d3a; border-color: #2e7d3a; color: #fff; }
  .marks .redob.on { background: #a13030; border-color: #a13030; color: #fff; }
  .scriptbtn { margin-top: 5px; font-size: 12px; }
  .script { display: none; margin-top: 6px; max-height: 220px; overflow: auto; white-space: pre-wrap; font-size: 12px; color: #cdc7bd; background: #0d0d0d; padding: 6px; border-radius: 4px; }
  .script.show { display: block; }
  .note { color: #c99; font-size: 12px; }
  dialog { background: #1c1c1c; color: #e6e6e6; border: 1px solid #444; border-radius: 8px; max-width: 700px; width: 90%; }
  dialog textarea { width: 100%; height: 320px; background: #0d0d0d; color: #e6e6e6; border: 1px solid #333; font: 12px monospace; }
</style>
</head>
<body>
<header>
  <b>Sample review</b>
  <span class="counts" id="counts"></span>
  <span style="margin-left:auto"></span>
  <button data-filter="all" class="active">All</button>
  <button data-filter="redo">Redo only</button>
  <button data-filter="unmarked">Unmarked</button>
  <button id="sortBtn" data-sort="cat">Sort: category</button>
  <button id="exportBtn">Export redo list</button>
  <button id="clearBtn">Clear marks</button>
</header>
<main id="main"></main>
<dialog id="exportDlg"><form method="dialog"><h3>Redo list</h3><textarea id="exportTxt" readonly></textarea><br><button>Close</button></form></dialog>
<script>
const DATA = ${json};
const KEY = (slug, set) => 'rev:' + slug + ':' + set;
const get = (slug, set) => localStorage.getItem(KEY(slug, set));
const set_ = (slug, set, v) => { v ? localStorage.setItem(KEY(slug, set), v) : localStorage.removeItem(KEY(slug, set)); };
let filter = 'all', sortMode = 'cat';

function curGrade(s) {
  const cur = s.cells.find(c => c.set === DATA.curLabel);
  const g = cur && cur.judges ? cur.judges.find(j => j.judge === 'grok') : null;
  return g && g.overall != null ? g.overall : (cur && cur.score != null ? cur.score : 99);
}

// A single comparable score for a cell: mean of its non-null judge overalls
// (multi-judge sets), else the flash score. null when nothing was scored.
function cellScore(c) {
  const vals = (c.judges || []).map(j => j.overall).filter(v => v != null);
  if (vals.length) return vals.reduce((a, b) => a + b, 0) / vals.length;
  return c.score != null ? c.score : null;
}

// The set label(s) with the highest cellScore for a style — the version that won.
function winningSets(s) {
  let best = -Infinity;
  for (const c of s.cells) {
    if (!c.video) continue;
    const v = cellScore(c);
    if (v != null && v > best) best = v;
  }
  if (best === -Infinity) return new Set();
  return new Set(
    s.cells.filter(c => c.video && cellScore(c) === best).map(c => c.set)
  );
}

function render() {
  const main = document.getElementById('main');
  let rows = DATA.styles.slice();
  if (sortMode === 'grade') rows.sort((a,b) => curGrade(a) - curGrade(b));
  else rows.sort((a,b) => (a.category+a.name).localeCompare(b.category+b.name));

  main.innerHTML = '';
  for (const s of rows) {
    const marks = s.cells.map(c => get(s.slug, c.set));
    const anyRedo = marks.some(m => m === 'redo');
    const anyUnmarked = s.cells.some((c,i) => c.video && !marks[i]);
    if (filter === 'redo' && !anyRedo) continue;
    if (filter === 'unmarked' && !anyUnmarked) continue;

    const el = document.createElement('div');
    el.className = 'style';
    const cur = s.cells.find(c => c.set === DATA.curLabel);
    const gradeTxt = cur && cur.multi
      ? cur.judges.filter(j=>j.overall!=null).map(j => j.judge[0] + ':' + j.overall).join('  ')
      : (cur && cur.score != null ? 'f:' + cur.score : '');
    el.innerHTML =
      '<img class="preview" loading="lazy" src="'+encodeURI(s.preview)+'" alt="" onerror="this.style.visibility=&#39;hidden&#39;">'
      + '<div class="body">'
      + '<div class="head"><span class="name">'+esc(s.name)+'</span>'
      + '<span class="cat">'+esc(s.category)+'</span>'
      + '<span class="gradetag">'+gradeTxt+'</span></div>'
      + '<div class="brief">BRIEF: '+esc(s.brief)+'</div>'
      + '<div class="cols"></div>'
      + '</div>';
    el.querySelector('.head').onclick = () => el.querySelector('.brief').classList.toggle('show');
    const cols = el.querySelector('.cols');
    const winners = winningSets(s);
    s.cells.forEach((c, i) => cols.appendChild(cellEl(s, c, marks[i], winners.has(c.set))));
    main.appendChild(el);
  }
  updateCounts();
}

function cellEl(s, c, mark, isWin) {
  const d = document.createElement('div');
  d.className = 'cell' + (mark ? ' ' + mark : '') + (isWin ? ' win' : '');
  const video = c.video
    ? '<video src="'+encodeURI(c.video)+'" controls preload="none" muted playsinline></video>'
    : '<div class="none">no video</div>';
  const jrow = (label, overall, note) =>
    '<div class="jrow"><b>'+esc(label)+'</b> '+(overall==null?'—':overall)
    + (note ? ' <span class="jnote">'+esc(note)+'</span>' : '')+'</div>';
  const scoreBlock = c.multi
    ? '<div class="judges">'+c.judges.map(j=>jrow(j.judge, j.overall, j.note)).join('')+'</div>'
    : '<div class="judges">'+jrow('flash', c.score, c.note)+'</div>';
  const avg = cellScore(c);
  const seqLink = c.seqUrl
    ? '<a class="seqlink" href="'+encodeURI(c.seqUrl)+'" target="_blank" rel="noopener" title="Open sequence in app">↗ app</a>'
    : '';
  d.innerHTML =
    '<div class="setlabel">'+(isWin?'<span class="winbadge">🏆</span> ':'')+esc(c.set)
    + (avg!=null?' <span class="avg">avg '+avg.toFixed(1)+'</span>':'')
    + seqLink+'</div>'
    + scoreBlock
    + video
    + '<div class="marks"><button class="keepb'+(mark==='keep'?' on':'')+'">✓ keep</button>'
    + '<button class="redob'+(mark==='redo'?' on':'')+'">✗ redo</button></div>'
    + (c.script ? '<button class="scriptbtn">script</button><div class="script">'+esc(c.script)+'</div>' : '');
  const vid = d.querySelector('video');
  if (vid) {
    vid.addEventListener('mouseenter', () => vid.play().catch(() => {}));
    vid.addEventListener('mouseleave', () => { vid.pause(); vid.currentTime = 0; });
  }
  const keepB = d.querySelector('.keepb'), redoB = d.querySelector('.redob');
  keepB.onclick = () => toggle(s.slug, c.set, 'keep');
  redoB.onclick = () => toggle(s.slug, c.set, 'redo');
  const sb = d.querySelector('.scriptbtn');
  if (sb) sb.onclick = () => d.querySelector('.script').classList.toggle('show');
  return d;
}

function toggle(slug, set, v) {
  set_(slug, set, get(slug, set) === v ? null : v);
  render();
}

function updateCounts() {
  let keep=0, redo=0, total=0;
  for (const s of DATA.styles) for (const c of s.cells) if (c.video) {
    total++; const m = get(s.slug, c.set);
    if (m==='keep') keep++; else if (m==='redo') redo++;
  }
  document.getElementById('counts').innerHTML =
    '<span class="ok">✓ '+keep+'</span><span class="bad">✗ '+redo+'</span>'
    + '<span class="un">unmarked '+(total-keep-redo)+'</span><span>of '+total+'</span>';
}

function esc(s){ return String(s).replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }

for (const b of document.querySelectorAll('[data-filter]')) b.onclick = () => {
  filter = b.dataset.filter;
  for (const x of document.querySelectorAll('[data-filter]')) x.classList.toggle('active', x===b);
  render();
};
document.getElementById('sortBtn').onclick = (e) => {
  sortMode = sortMode === 'cat' ? 'grade' : 'cat';
  e.target.textContent = 'Sort: ' + (sortMode === 'cat' ? 'category' : 'worst grok first');
  render();
};
document.getElementById('clearBtn').onclick = () => {
  if (!confirm('Clear all ✓/✗ marks?')) return;
  for (const s of DATA.styles) for (const c of s.cells) set_(s.slug, c.set, null);
  render();
};
document.getElementById('exportBtn').onclick = () => {
  const bySet = {};
  for (const s of DATA.styles) for (const c of s.cells)
    if (get(s.slug, c.set) === 'redo') (bySet[c.set] = bySet[c.set] || []).push(s.slug);
  let txt = '';
  for (const set of DATA.sets) if (bySet[set]) txt += '# '+set+' — redo ('+bySet[set].length+')\\n' + bySet[set].sort().join('\\n') + '\\n\\n';
  document.getElementById('exportTxt').value = txt || '(nothing marked redo)';
  document.getElementById('exportDlg').showModal();
};
render();
</script>
</body>
</html>`;
}

main();
