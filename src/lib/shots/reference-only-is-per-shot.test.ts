/**
 * Repo guard: ask the SHOT, not the sequence.
 *
 * `sequences.generateStartFrames` is only a default now — a shot overrides it with
 * `shots.useStartFrame`, so anything deciding what a shot renders must go
 * through `usesStartFrame` / `rendersReferenceOnly`.
 *
 * This failed silently three times while the switch was being built: the
 * optimised-prompt preview kept showing "Use @Image1 as the starting frame."
 * on an unticked shot, regenerate wrote the wrong template, and the staleness
 * recompute would have reported every overridden shot stale for ever. None of
 * them threw. Nothing rendered red. The only symptom was a checkbox that
 * changed one thing and not the others — which is exactly the shape of bug a
 * unit test per call site never catches, because the call site under test is
 * always the one you remembered.
 *
 * So the rule is enforced on the source instead, and every legitimate
 * sequence-level read is named below with its reason.
 */

import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// `?.` is part of the read: `sequence?.referenceOnly` slipped the guard
// entirely until it was noticed, and every UI holder of the row spells it that
// way (the query can be in flight).
// Any receiver, not just `sequence`: `row.`, `seq.`, `snapshot.` all slipped
// the old guard. Destructuring (`const { generateStartFrames } = sequence`) is
// the other spelling of the same read.
const SEQUENCE_READ =
  /\.generateStartFrames\b|\{[^{}]*\bgenerateStartFrames\b[^{}]*\}\s*=(?![=>])/;

/**
 * Reads that are correctly sequence-level, each with why.
 *
 * Adding a file here is a claim: "this decides something about the SEQUENCE,
 * not about one shot". A whole-storyboard launch and a whole-storyboard credit
 * estimate qualify. A per-shot render, prompt, hash or preview does not.
 */
const SEQUENCE_LEVEL_BY_DESIGN: Record<string, string> = {
  // The flag's own home: it resolves the shot override against this default.
  'src/lib/shots/use-start-frame.ts':
    'defines the resolution — the default it falls back to',
  // A full storyboard run starts in the sequence's mode; per-shot overrides
  // are applied later, per shot, by the render paths.
  'src/lib/workflow/launchers.ts': 'sequence-wide storyboard launch',
  // Pre-flight credit envelopes for a WHOLE run. An override shifts one shot
  // between two similarly-priced routes; the envelope is an estimate.
  'src/lib/sequences/smart-retry.ts': 'whole-run credit estimate',
  'src/functions/sequences.ts': 'whole-run credit estimate',
  'src/functions/shot-image.ts': 'whole-run credit estimate',
  // Plan snapshot of the sequence row. Per-shot answers are frozen onto each
  // PlanTarget as `usesStartFrame`.
  'src/lib/shots/update-stale-plan.ts': 'snapshots the sequence default',
  // The composer edits the SEQUENCE default before any shot exists.
  'src/components/script/script-view.tsx': 'composer editing the default',
  // Holds the row for the page and hands the default to the per-shot
  // resolvers (`rendersReferenceOnly`, `sequenceReferenceOnly`); the phase
  // config it builds is for the whole run.
  'src/components/scenes/scenes-view.tsx':
    'passes the default down to per-shot resolvers',
  // Reads the default and hands it to `rendersReferenceOnly` per shot; the
  // list then narrows if ANY eligible shot renders reference-only.
  'src/components/model/add-model-menu.tsx':
    'passes the default to the per-shot resolver',
  // Creation: no shot exists yet, so the sequence default is the only answer.
  'src/lib/schemas/sequence.schemas.ts': 'validates the create-time default',
  'src/lib/sequences/create-sequences.ts': 'creates the row from the default',
  'src/lib/db/scoped/sequences.ts': 'writes the column',
  // Restores the composer's stored default; there is no shot to ask.
  'src/hooks/use-generation-settings.ts': 'stored composer default',
};

describe('reference-only is resolved per shot', () => {
  it('reads the sequence flag only where a sequence-level answer is right', () => {
    const files = globSync('src/**/*.{ts,tsx}').filter(
      (f) => !f.includes('.test.') && !f.includes('.stories.')
    );

    const offenders = files.filter((file) => {
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      if (!SEQUENCE_READ.test(source)) return false;
      return !(file.replaceAll('\\', '/') in SEQUENCE_LEVEL_BY_DESIGN);
    });

    expect(
      offenders,
      offenders.length > 0
        ? `These read sequence.generateStartFrames directly. If the answer is about ONE SHOT, ` +
            `use usesStartFrame(shot, sequence) — a shot can override the sequence. ` +
            `If it really is sequence-wide, add it to SEQUENCE_LEVEL_BY_DESIGN with a reason.\n  ` +
            offenders.join('\n  ')
        : undefined
    ).toEqual([]);
  });

  it('keeps the allowlist honest', () => {
    // An entry that no longer reads the flag is stale documentation; it would
    // also silently re-permit the file if a future edit reintroduced a read.
    const stale = Object.keys(SEQUENCE_LEVEL_BY_DESIGN).filter((file) => {
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      return !SEQUENCE_READ.test(source);
    });
    expect(stale).toEqual([]);
  });
});
