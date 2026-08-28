/**
 * Lab measurement for `/` first paint + images.
 *
 * Usage:
 *   bun scripts/measure-front-page.ts [url] [label]
 *
 * Writes JSON to /tmp/openstory-perf/<label>.json
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const url = process.argv[2] ?? 'http://localhost:3000/';
const label = process.argv[3] ?? 'run';
const runs = Number(process.argv[4] ?? 3);

type Run = {
  ttfbMs: number;
  fcpMs: number;
  lcpMs: number;
  lcpTag: string;
  lcpUrl: string;
  firstMediaMs: number;
  firstMediaCompleteMs: number;
  imgCount: number;
  videoCount: number;
  posterCount: number;
  htmlImg: number;
  htmlVideo: number;
  htmlPoster: number;
  htmlHasHeading: boolean;
  htmlHasShowcaseHeading: boolean;
  htmlSkeletonCount: number;
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted[mid];
  return value ?? 0;
}

async function oneRun(): Promise<Run> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  let html = '';
  page.on('response', (response) => {
    const request = response.request();
    if (request.resourceType() !== 'document') return;
    if (new URL(response.url()).pathname !== '/') return;
    void response.text().then((body) => {
      html = body;
    });
  });

  await page.addInitScript(() => {
    const state = {
      fcp: 0,
      lcp: 0,
      lcpTag: '',
      lcpUrl: '',
      firstMedia: 0,
      firstMediaComplete: 0,
    };
    (
      globalThis as typeof globalThis & { __frontPagePerf?: typeof state }
    ).__frontPagePerf = state;

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'first-contentful-paint') {
          state.fcp = entry.startTime;
        }
      }
    }).observe({ type: 'paint', buffered: true });

    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (!last) return;
      state.lcp = last.startTime;
      const element = 'element' in last ? last.element : undefined;
      state.lcpTag = element instanceof Element ? element.tagName : '';
      state.lcpUrl =
        'url' in last && typeof last.url === 'string' ? last.url : '';
    }).observe({ type: 'largest-contentful-paint', buffered: true });

    const markMedia = () => {
      const nodes = [
        ...document.querySelectorAll<HTMLImageElement>('img'),
        ...document.querySelectorAll<HTMLVideoElement>('video[poster]'),
      ];
      if (nodes.length > 0 && state.firstMedia === 0) {
        state.firstMedia = performance.now();
      }
      const ready = nodes.some((node) => {
        if (node instanceof HTMLImageElement) {
          return node.complete && node.naturalWidth > 0;
        }
        return Boolean(node.getAttribute('poster'));
      });
      if (ready && state.firstMediaComplete === 0) {
        state.firstMediaComplete = performance.now();
      }
    };

    new MutationObserver(markMedia).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'poster'],
    });
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page
    .waitForSelector('img, video[poster]', { timeout: 8_000 })
    .catch(() => undefined);
  // Settle LCP after first media (or the timeout if none arrived).
  await page.waitForTimeout(2_000);

  const client = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const ttfbMs =
      nav && 'responseStart' in nav && typeof nav.responseStart === 'number'
        ? nav.responseStart
        : 0;
    const state = (
      globalThis as typeof globalThis & {
        __frontPagePerf?: {
          fcp: number;
          lcp: number;
          lcpTag: string;
          lcpUrl: string;
          firstMedia: number;
          firstMediaComplete: number;
        };
      }
    ).__frontPagePerf;
    return {
      ttfbMs,
      fcpMs: state?.fcp ?? 0,
      lcpMs: state?.lcp ?? 0,
      lcpTag: state?.lcpTag ?? '',
      lcpUrl: state?.lcpUrl ?? '',
      firstMediaMs: state?.firstMedia ?? 0,
      firstMediaCompleteMs: state?.firstMediaComplete ?? 0,
      imgCount: document.querySelectorAll('img').length,
      videoCount: document.querySelectorAll('video').length,
      posterCount: document.querySelectorAll('video[poster]').length,
    };
  });

  await browser.close();

  const htmlImg = (html.match(/<img/gi) ?? []).length;
  const htmlVideo = (html.match(/<video/gi) ?? []).length;
  const htmlPoster = (html.match(/poster=/gi) ?? []).length;
  const htmlSkeletonCount = (html.match(/animate-pulse/gi) ?? []).length;

  return {
    ...client,
    htmlImg,
    htmlVideo,
    htmlPoster,
    htmlHasHeading: html.includes('Tell your whole story'),
    htmlHasShowcaseHeading: html.includes('See what you can create'),
    htmlSkeletonCount,
  };
}

const results: Run[] = [];
for (let i = 0; i < runs; i++) {
  const run = await oneRun();
  results.push(run);
  console.log(`run ${i + 1}/${runs}`, run);
}

const summary = {
  label,
  url,
  runs,
  median: {
    ttfbMs: median(results.map((r) => r.ttfbMs)),
    fcpMs: median(results.map((r) => r.fcpMs)),
    lcpMs: median(results.map((r) => r.lcpMs)),
    firstMediaMs: median(results.map((r) => r.firstMediaMs)),
    firstMediaCompleteMs: median(results.map((r) => r.firstMediaCompleteMs)),
    htmlImg: median(results.map((r) => r.htmlImg)),
    htmlVideo: median(results.map((r) => r.htmlVideo)),
    htmlPoster: median(results.map((r) => r.htmlPoster)),
  },
  results,
};

await mkdir('/tmp/openstory-perf', { recursive: true });
const out = `/tmp/openstory-perf/${label}.json`;
await writeFile(out, JSON.stringify(summary, null, 2));
console.log('summary', JSON.stringify(summary.median, null, 2));
console.log('wrote', out);
