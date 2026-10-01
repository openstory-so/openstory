import { describe, expect, it, vi } from 'vitest';
import { SEQUENCE_CARD_SCRIPT } from './sequence-card';

type FakeElement = {
  textContent: string;
  hidden: boolean;
  src?: string;
  children: FakeElement[];
  replaceChildren: () => void;
  append: (...children: FakeElement[]) => void;
};

const element = (): FakeElement => {
  const el: FakeElement = {
    textContent: '',
    hidden: true,
    children: [],
    replaceChildren: () => {
      el.children = [];
    },
    append: (...children) => {
      el.children.push(...children);
    },
  };
  return el;
};

/** Runs the page script against a fake window and returns its handles. */
function mount() {
  const els: Record<string, FakeElement> = {};
  const parent = { postMessage: vi.fn() };
  let onMessage: ((event: { source: unknown; data: unknown }) => void) | null =
    null;
  const window = {
    parent,
    addEventListener: (_: string, fn: typeof onMessage) => {
      onMessage = fn;
    },
  };
  const document = {
    getElementById: (id: string) => (els[id] ??= element()),
    createElement: element,
    documentElement: { style: { setProperty: vi.fn() }, scrollHeight: 120 },
    body: {},
  };
  // oxlint-disable-next-line typescript/no-implied-eval, no-new-func -- runs the page's own inline script, a trusted constant
  new Function('window', 'document', SEQUENCE_CARD_SCRIPT)(window, document);
  const send = (data: unknown, source: unknown = parent) =>
    onMessage?.({ source, data });
  const sent = () =>
    parent.postMessage.mock.calls.map(([message]) => message as unknown);
  return { els, send, sent };
}

const toolResult = (params: unknown) => ({
  jsonrpc: '2.0',
  method: 'ui/notifications/tool-result',
  params,
});

describe('sequence card bridge', () => {
  it('initializes, then renders a result with text only', () => {
    const { els, send, sent } = mount();
    expect(sent()[0]).toMatchObject({ id: 1, method: 'ui/initialize' });
    send({ jsonrpc: '2.0', id: 1, result: { hostContext: { theme: 'dark' } } });
    expect(sent()).toContainEqual(
      expect.objectContaining({ method: 'ui/notifications/initialized' })
    );
    send(
      toolResult({
        structuredContent: {
          title: '<b>Sea</b>',
          status: 'ready',
          counts: { shots: 3, videosReady: 2 },
        },
      })
    );
    expect(els.title?.textContent).toBe('<b>Sea</b>');
    expect(els.counts?.children.map((c) => c.textContent)).toEqual([
      'shots',
      '3',
      'videos ready',
      '2',
    ]);
  });

  it('shows an error result and a cancellation instead of an empty card', () => {
    const { els, send } = mount();
    send(
      toolResult({
        isError: true,
        structuredContent: { error: { code: 'NOT_FOUND', message: 'Gone' } },
      })
    );
    expect(els.error).toMatchObject({ textContent: 'Gone', hidden: false });
    send(
      toolResult({
        isError: true,
        content: [{ type: 'text', text: 'Too big' }],
      })
    );
    expect(els.error?.textContent).toBe('Too big');
    send({ jsonrpc: '2.0', method: 'ui/notifications/tool-cancelled' });
    expect(els.error?.textContent).toBe('The request was cancelled.');
  });

  it('answers host requests and ignores other windows', () => {
    const { send, sent } = mount();
    send({ jsonrpc: '2.0', id: 7, method: 'ui/resource-teardown', params: {} });
    send({ jsonrpc: '2.0', id: 8, method: 'ping' });
    send({ jsonrpc: '2.0', id: 9, method: 'ui/unknown' });
    expect(sent()).toEqual(
      expect.arrayContaining([
        { jsonrpc: '2.0', id: 7, result: {} },
        { jsonrpc: '2.0', id: 8, result: {} },
        expect.objectContaining({
          id: 9,
          error: expect.objectContaining({ code: -32601 }),
        }),
      ])
    );
    const before = sent().length;
    send({ jsonrpc: '2.0', id: 10, method: 'ping' }, {});
    expect(sent()).toHaveLength(before);
  });
});
