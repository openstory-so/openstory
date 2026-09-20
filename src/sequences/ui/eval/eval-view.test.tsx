import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SEQUENCES_LIST_PREFS } from '../list-prefs';

const ownData = vi.fn(() => ({
  data: [],
  isLoading: false,
  shotsLoadingMap: {},
  error: null,
}));
const variants = vi.fn(() => ({ data: [] }));
const adminQueries = vi.fn();
const shotsQueries = vi.fn(() => []);
let isAdmin = true;
let adminStatusLoading = false;
vi.doMock('../use-sequences-with-shots', () => ({
  useSequencesWithShots: ownData,
}));
vi.doMock('@/audio/ui/use-sequence-variants', () => ({
  useTeamDivergentSequenceVariants: variants,
}));
vi.doMock('@/look/ui/use-styles', () => ({ useStyles: () => ({ data: [] }) }));
vi.doMock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: { isAdmin, internalDomains: ['internal.example'] },
    isLoading: adminStatusLoading,
  }),
  useInfiniteQuery: (options: { enabled: boolean }) => {
    adminQueries(options);
    // Cached support results must not trigger shot requests when disabled.
    return {
      data: {
        pages: [
          [
            {
              id: 'support-sequence',
              title: 'Film',
              createdAt: new Date(),
              creatorEmail: 'person@example.com',
            },
          ],
        ],
      },
      isLoading: false,
      error: null,
      hasNextPage: true,
      isFetchingNextPage: false,
    };
  },
  useQueries: shotsQueries,
}));
vi.doMock('./eval-toolbar', () => ({ EvalToolbar: () => <div>Toolbar</div> }));
vi.doMock('./sequence-gallery', () => ({
  SequenceGallery: () => <div>Gallery</div>,
}));
vi.doMock('../archived-sequences', () => ({ ArchivedSequences: () => null }));
const actualRouter = await import('@tanstack/react-router');
vi.doMock('@tanstack/react-router', () => ({
  ...actualRouter,
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));
const { EvalView } = await import('./eval-view');

beforeEach(() => {
  vi.clearAllMocks();
  isAdmin = true;
  adminStatusLoading = false;
});
describe('sequences landing page loading', () => {
  it('defaults to a gallery without fetching shots or variants', () => {
    renderToStaticMarkup(
      <EvalView
        search={{}}
        prefs={DEFAULT_SEQUENCES_LIST_PREFS}
        setPrefs={() => {}}
      />
    );
    expect(ownData).toHaveBeenCalledWith({ enabled: true, loadShots: false });
    expect(variants).toHaveBeenCalledWith(false);
    expect(adminQueries).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
    expect(shotsQueries).toHaveBeenCalledWith({ queries: [] });
  });
  it('loads support results without own-team or per-sequence shot requests', () => {
    const html = renderToStaticMarkup(
      <EvalView
        search={{ support: true }}
        prefs={{ ...DEFAULT_SEQUENCES_LIST_PREFS, supportMode: true }}
        setPrefs={() => {}}
      />
    );
    expect(html).toContain('Gallery');
    expect(html).toContain('Load more sequences');
    expect(ownData).toHaveBeenCalledWith({ enabled: false, loadShots: false });
    expect(adminQueries).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true })
    );
    expect(shotsQueries).toHaveBeenCalledWith({ queries: [] });
  });
  it('keeps support pagination reachable when filters hide the loaded page', () => {
    const html = renderToStaticMarkup(
      <EvalView
        search={{ support: true }}
        prefs={{
          ...DEFAULT_SEQUENCES_LIST_PREFS,
          supportMode: true,
          imageModel: 'unmatched',
        }}
        setPrefs={() => {}}
      />
    );
    expect(html).toContain('No matching sequences');
    expect(html).toContain('Load more sequences');
  });
  it('does not enable support requests for a non-admin with remembered support mode', () => {
    isAdmin = false;
    renderToStaticMarkup(
      <EvalView
        search={{ support: true }}
        prefs={{ ...DEFAULT_SEQUENCES_LIST_PREFS, supportMode: true }}
        setPrefs={() => {}}
      />
    );
    expect(adminQueries).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
    expect(ownData).toHaveBeenCalledWith({ enabled: true, loadShots: false });
  });
  it('waits for the admin check before fetching a remembered support view', () => {
    isAdmin = false;
    adminStatusLoading = true;
    renderToStaticMarkup(
      <EvalView
        search={{ support: true }}
        prefs={{ ...DEFAULT_SEQUENCES_LIST_PREFS, supportMode: true }}
        setPrefs={() => {}}
      />
    );
    expect(ownData).toHaveBeenCalledWith({ enabled: false, loadShots: false });
    expect(adminQueries).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
  });
});
