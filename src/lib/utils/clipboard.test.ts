import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from './clipboard';

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
