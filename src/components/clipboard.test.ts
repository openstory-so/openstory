import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyImageToClipboard, copyTextToClipboard } from './clipboard';

/**
 * Unit tests run in the `node` environment, so both `navigator.clipboard` and
 * `document` are stubbed here — the point of these tests is the branch order
 * (Clipboard API first, `execCommand` when it is missing or rejects), not DOM
 * fidelity.
 */

type FakeDocumentOptions = {
  execCommand?: (command: string) => boolean;
};

const appended: unknown[] = [];

function stubDocument({ execCommand }: FakeDocumentOptions) {
  const document = {
    createElement: () => ({
      value: '',
      style: {} as Record<string, string>,
      setAttribute: vi.fn(),
      focus: vi.fn(),
      select: vi.fn(),
      setSelectionRange: vi.fn(),
      remove: vi.fn(),
    }),
    body: { appendChild: (node: unknown) => appended.push(node) },
    getSelection: () => null,
    ...(execCommand ? { execCommand } : {}),
  };
  vi.stubGlobal('document', document);
  return document;
}

afterEach(() => {
  vi.unstubAllGlobals();
  appended.length = 0;
});

describe('copyTextToClipboard', () => {
  it('uses the Clipboard API when it resolves', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    stubDocument({ execCommand: () => false });

    expect(await copyTextToClipboard('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when the Clipboard API rejects', async () => {
    // Mobile Chrome without a clipboard grant rejects with NotAllowedError.
    const writeText = vi
      .fn()
      .mockRejectedValue(new DOMException('Write permission denied.'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const execCommand = vi.fn().mockReturnValue(true);
    stubDocument({ execCommand });

    expect(await copyTextToClipboard('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledOnce();
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(appended).toHaveLength(1);
  });

  it('falls back to execCommand when the Clipboard API is unavailable', async () => {
    // Insecure context: `navigator.clipboard` is undefined.
    vi.stubGlobal('navigator', {});
    const execCommand = vi.fn().mockReturnValue(true);
    stubDocument({ execCommand });

    expect(await copyTextToClipboard('hello')).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('reports failure when both paths fail', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('nope')) },
    });
    stubDocument({ execCommand: () => false });

    expect(await copyTextToClipboard('hello')).toBe(false);
  });

  it('reports failure when execCommand does not exist', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('nope')) },
    });
    stubDocument({});

    expect(await copyTextToClipboard('hello')).toBe(false);
  });
});

class FakeClipboardItem {
  items: Record<string, Blob | Promise<Blob>>;
  constructor(items: Record<string, Blob | Promise<Blob>>) {
    this.items = items;
  }
}

function writtenItem(
  write: ReturnType<typeof vi.fn>,
  call: number
): FakeClipboardItem {
  const item = write.mock.calls[call]?.[0]?.[0];
  if (!(item instanceof FakeClipboardItem)) {
    throw new Error(
      `clipboard.write call ${call} did not receive a ClipboardItem`
    );
  }
  return item;
}

describe('copyImageToClipboard', () => {
  it('writes a PNG blob via clipboard.write', async () => {
    const png = new Blob(['png-bytes'], { type: 'image/png' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: async () => png,
      })
    );
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    vi.stubGlobal('navigator', { clipboard: { write } });

    expect(await copyImageToClipboard('/r2/still.png')).toBe(true);
    expect(write).toHaveBeenCalledOnce();
    const item = writtenItem(write, 0);
    expect(item.items['image/png']).toBeInstanceOf(Promise);
    await expect(item.items['image/png']).resolves.toBe(png);
  });

  it('retries with a resolved blob when Promise ClipboardItem is rejected', async () => {
    const png = new Blob(['png-bytes'], { type: 'image/png' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: async () => png,
      })
    );
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('promises not supported'))
      .mockResolvedValueOnce(undefined);
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    vi.stubGlobal('navigator', { clipboard: { write } });

    expect(await copyImageToClipboard('/r2/still.png')).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    expect(writtenItem(write, 1).items['image/png']).toBe(png);
  });

  it('reports failure when clipboard.write is unavailable', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn() } });
    vi.stubGlobal('ClipboardItem', class {});
    expect(await copyImageToClipboard('/r2/still.png')).toBe(false);
  });

  it('reports failure when the image cannot be fetched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404 })
    );
    const write = vi.fn().mockRejectedValue(new Error('item failed'));
    class FakeClipboardItem {
      constructor(public items: Record<string, Blob | Promise<Blob>>) {}
    }
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    vi.stubGlobal('navigator', { clipboard: { write } });

    expect(await copyImageToClipboard('/r2/missing.png')).toBe(false);
  });
});
