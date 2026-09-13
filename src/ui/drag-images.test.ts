import { describe, expect, it } from 'vitest';
import { snapshotDataTransfer } from './drag-images';

/**
 * #1559 — the snapshot used to keep `image/*` local files only, which made a
 * dragged clip or voice line disappear: the caller got an empty result, so it
 * neither uploaded nor reached its auth gate, and a logged-out drag showed no
 * login prompt and no error.
 */
function dataTransfer(files: File[]): DataTransfer {
  // A DataTransfer cannot be constructed outside a real drag event, so this
  // stands in for the three fields `snapshotDataTransfer` reads.
  const stub = {
    files,
    types: ['Files'],
    getData: () => '',
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test stub, see above
  return stub as unknown as DataTransfer;
}

const file = (name: string, type: string) => new File(['x'], name, { type });

describe('snapshotDataTransfer', () => {
  it('keeps a dragged clip and voice line, not just stills', () => {
    const snapshot = snapshotDataTransfer(
      dataTransfer([
        file('logo.png', 'image/png'),
        file('walk.mp4', 'video/mp4'),
        file('line.mp3', 'audio/mpeg'),
      ])
    );

    expect(snapshot.files.map((f) => f.name)).toEqual([
      'logo.png',
      'walk.mp4',
      'line.mp3',
    ]);
  });

  it('does not filter by kind at all — that is the caller’s question', () => {
    // Handing the caller a file it will reject is strictly better than an
    // empty result, which reads as "nothing was dropped" and skips the gate.
    const snapshot = snapshotDataTransfer(
      dataTransfer([file('brief.pdf', 'application/pdf')])
    );

    expect(snapshot.files).toHaveLength(1);
  });

  it('keeps a file whose type the browser could not determine', () => {
    // Some browsers report an empty type; the caller falls back to the name.
    const snapshot = snapshotDataTransfer(
      dataTransfer([file('take-2.mov', '')])
    );

    expect(snapshot.files).toHaveLength(1);
  });
});
