import { describe, expect, it, vi } from 'vitest';
import { SEQUENCE_CARD_SCRIPT } from './sequence-card';

type FakeElement = {
  textContent: string;
  hidden: boolean;
  src?: string;
  href?: string;
  onClick?: (event: { preventDefault: () => void }) => void;
  addEventListener: (type: string, fn: FakeElement['onClick']) => void;
  children: FakeElement[];
  replaceChildren: () => void;
  append: (...children: FakeElement[]) => void;
};

const element = (): FakeElement => {
  const el: FakeElement = {
    textContent: '',
    hidden: true,
    addEventListener: (_, fn) => {
      el.onClick = fn;
    },
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

type Posted = { id?: number; method?: string; params?: unknown };
const isPosted = (m: unknown): m is Posted =>
  typeof m === 'object' && m !== null;
/** The requests the card posted with this method. */
const posted = (messages: unknown[], method: string) =>
  messages.filter(isPosted).filter((m) => m.method === method);

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

  it('polls status through the host and announces the end of the run once', async () => {
    vi.useFakeTimers();
    try {
      const { els, send, sent } = mount();
      send({
        jsonrpc: '2.0',
        id: 1,
        result: { hostCapabilities: { serverTools: {} } },
      });
      send(
        toolResult({
          structuredContent: {
            id: 'SEQ',
            title: 'Sea',
            status: 'processing',
            sequenceStatus: 'processing',
            counts: { shots: 2, videosReady: 0 },
          },
        })
      );
      const calls = () => posted(sent(), 'tools/call');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls()).toHaveLength(1);
      expect(calls()[0]?.params).toEqual({
        name: 'openstory.get_sequence_status',
        arguments: { sequenceId: 'SEQ' },
      });
      const status = (sequenceStatus: string, videosReady: number) => ({
        structuredContent: {
          status: sequenceStatus,
          sequenceStatus,
          counts: { shots: 2, videosReady },
        },
      });
      send({
        jsonrpc: '2.0',
        id: calls()[0]?.id,
        result: status('processing', 1),
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls()).toHaveLength(2);
      send({
        jsonrpc: '2.0',
        id: calls()[1]?.id,
        result: status('completed', 2),
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls()).toHaveLength(2);
      expect(els.meta?.textContent).toBe('completed');
      const messages = posted(sent(), 'ui/message');
      expect(messages).toEqual([
        expect.objectContaining({
          params: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'OpenStory: "Sea" (SEQ) finished: completed. 2/2 videos ready.',
              },
            ],
          },
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not poll on a host without server tools', async () => {
    vi.useFakeTimers();
    try {
      const { send, sent } = mount();
      send({ jsonrpc: '2.0', id: 1, result: {} });
      send(
        toolResult({
          structuredContent: { id: 'SEQ', sequenceStatus: 'processing' },
        })
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(posted(sent(), 'tools/call')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the sequence in the app through the host', () => {
    const { els, send, sent } = mount();
    send({
      jsonrpc: '2.0',
      id: 1,
      result: { hostCapabilities: { openLinks: {} } },
    });
    send(
      toolResult({
        structuredContent: {
          id: 'SEQ',
          appUrl: 'https://app.test/sequences/SEQ/script',
        },
      })
    );
    expect(els.open).toMatchObject({
      href: 'https://app.test/sequences/SEQ/script',
      hidden: false,
    });
    const preventDefault = vi.fn();
    els.open?.onClick?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(posted(sent(), 'ui/open-link')).toEqual([
      expect.objectContaining({
        params: { url: 'https://app.test/sequences/SEQ/script' },
      }),
    ]);
  });
});
