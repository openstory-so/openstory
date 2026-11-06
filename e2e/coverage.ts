/**
 * E2E coverage (#2243): browser code via Playwright V8 coverage, server code via
 * the Istanbul plugin in vite.config.ts. Each run dumps to e2e/coverage/raw;
 * `bun e2e/coverage-report.ts` merges every dump. Run with `bun test:e2e:coverage`.
 *
 * A file can load on both sides with different statement maps, so the combined
 * figure is a per-line union, not an Istanbul merge.
 */
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import libCoverage, { type CoverageMap } from 'istanbul-lib-coverage';
import { createInstrumenter } from 'istanbul-lib-instrument';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import libSourceMaps from 'istanbul-lib-source-maps';
import MCR, { type CoverageReportOptions } from 'monocart-coverage-reports';

export const E2E_COVERAGE = process.env.E2E_COVERAGE === 'true';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, 'e2e/coverage');
const rawDir = join(outDir, 'raw');
const BASE = 'http://localhost:3020';

/** Files under src/ that count toward coverage. */
export function isMeasured(path: string): boolean {
  return (
    /^src\/.+\.[jt]sx?$/.test(path) &&
    !/\.(test|stories|d)\.[jt]sx?$/.test(path) &&
    !path.endsWith('routeTree.gen.ts') &&
    !path.startsWith('src/test/')
  );
}

/** `src/…` for any spelling of a repo file (absolute, `/@fs`, `localhost-3020/…`). */
const toRepoPath = (p: string): string => {
  const clean = p.split('?')[0] ?? '';
  if (clean.includes('node_modules')) return clean;
  return /(?:^|\/)(src\/.+)$/.exec(clean)?.[1] ?? clean;
};

const clientOptions: CoverageReportOptions = {
  name: 'e2e client',
  outputDir: join(outDir, '.client-run'),
  reports: ['json'],
  entryFilter: (entry) =>
    entry.url.startsWith(BASE) && !entry.url.includes('/node_modules/'),
  // Vite dev maps name a source by its bare filename; resolve it beside its module.
  sourcePath: (p, { distFile }) =>
    toRepoPath(p.includes('/') || !distFile ? p : join(dirname(distFile), p)),
};

export async function addClientCoverage(
  entries: Parameters<ReturnType<typeof MCR>['add']>[0]
): Promise<void> {
  await MCR(clientOptions).add(entries);
}

export function cleanClientCoverage(): void {
  MCR(clientOptions).cleanCache();
}

function rekey(map: CoverageMap): CoverageMap {
  const out = libCoverage.createCoverageMap({});
  for (const file of map.files()) {
    const path = toRepoPath(file);
    if (!isMeasured(path)) continue;
    const { data } = map.fileCoverageFor(file);
    out.addFileCoverage({ ...data, path: resolve(root, path) });
  }
  return out;
}

function listSrc(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = join(dir, d.name);
    return d.isDirectory() ? listSrc(full) : [relative(root, full)];
  });
}

/** Empty coverage for a file neither side loaded, so it counts as 0%. */
function emptyCoverage(path: string) {
  const instrumenter = createInstrumenter({
    esModules: true,
    parserPlugins: ['typescript', 'jsx', 'decorators-legacy'],
  });
  const file = resolve(root, path);
  try {
    instrumenter.instrumentSync(readFileSync(file, 'utf8'), file);
    return instrumenter.lastFileCoverage();
  } catch {
    return null;
  }
}

function writeReports(map: CoverageMap, dir: string): void {
  const context = libReport.createContext({
    dir,
    coverageMap: map,
    defaultSummarizer: 'nested',
  });
  for (const name of ['html', 'json-summary'] as const) {
    reports.create(name).execute(context);
  }
}

type LineTally = { covered: number; total: number };

/** Save this run's server counters and browser coverage to e2e/coverage/raw. */
export async function dumpCoverage(): Promise<void> {
  const stamp = `${Date.now()}-${process.pid}`;
  mkdirSync(rawDir, { recursive: true });
  const res = await fetch(`${BASE}/api/test/coverage`);
  const server = rekey(
    await libSourceMaps
      .createSourceMapStore()
      .transformCoverage(libCoverage.createCoverageMap(await res.json()))
  );
  writeFileSync(join(rawDir, `${stamp}-server.json`), JSON.stringify(server));
  await MCR(clientOptions).generate();
  copyFileSync(
    join(outDir, '.client-run/coverage-final.json'),
    join(rawDir, `${stamp}-client.json`)
  );
}

function readRaw(side: 'server' | 'client'): CoverageMap[] {
  return readdirSync(rawDir)
    .filter((f) => f.endsWith(`-${side}.json`))
    .map((f) =>
      rekey(
        libCoverage.createCoverageMap(
          JSON.parse(readFileSync(join(rawDir, f), 'utf8'))
        )
      )
    );
}

/** Merge every dump in e2e/coverage/raw and write the reports. */
export function writeCoverageReport(): void {
  const maps = { server: readRaw('server'), client: readRaw('client') };
  for (const [side, list] of Object.entries(maps)) {
    const merged = libCoverage.createCoverageMap({});
    for (const map of list) merged.merge(map);
    writeReports(merged, join(outDir, side));
  }
  const all = [...maps.server, ...maps.client];

  const perFile: Record<string, LineTally> = {};
  const unparsed: string[] = [];
  for (const path of listSrc(join(root, 'src')).filter(isMeasured)) {
    const empty = emptyCoverage(path);
    if (!empty) {
      unparsed.push(path);
      continue;
    }
    // One denominator for both sides: the statement lines of the TS source.
    const lines = Object.keys(
      libCoverage.createFileCoverage(empty).getLineCoverage()
    );
    if (lines.length === 0) continue;
    const file = resolve(root, path);
    const hit = new Set<string>();
    for (const map of all) {
      if (!map.files().includes(file)) continue;
      for (const [line, hits] of Object.entries(
        map.fileCoverageFor(file).getLineCoverage()
      )) {
        if (hits > 0) hit.add(line);
      }
    }
    perFile[path] = {
      covered: lines.filter((l) => hit.has(l)).length,
      total: lines.length,
    };
  }

  const byDir: Record<string, LineTally> = {};
  let covered = 0;
  let total = 0;
  for (const [path, t] of Object.entries(perFile)) {
    covered += t.covered;
    total += t.total;
    const dir = path.split('/').slice(0, 3).join('/');
    const d = (byDir[dir] ??= { covered: 0, total: 0 });
    d.covered += t.covered;
    d.total += t.total;
  }
  const pct = (t: LineTally) =>
    t.total ? Math.round((1000 * t.covered) / t.total) / 10 : 100;
  const gaps = Object.entries(byDir)
    .map(([dir, t]) => ({
      dir,
      ...t,
      pct: pct(t),
      missed: t.total - t.covered,
    }))
    .sort((a, b) => b.missed - a.missed);
  writeFileSync(
    join(outDir, 'summary.json'),
    JSON.stringify(
      {
        lines: { covered, total, pct: pct({ covered, total }) },
        gaps,
        perFile,
      },
      null,
      2
    )
  );
  process.stdout.write(
    `\nE2E line coverage (browser ∪ server): ${pct({ covered, total })}% (${covered}/${total})\n` +
      (unparsed.length
        ? `Not counted (parse failed): ${unparsed.length} files\n`
        : '') +
      `Reports: e2e/coverage/{summary.json,client/index.html,server/index.html}\n`
  );
}
