import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useSequences = vi.fn(() => ({
  data: [{ id: 'sequence-1', title: 'Film' }],
  isLoading: false,
  error: null,
}));
const shotQuery = vi.fn(() => ({
  data: undefined,
  isLoading: false,
  error: new Error('Previous comparison request failed'),
}));
vi.doMock('./use-sequences', () => ({ useSequences }));
vi.doMock('@tanstack/react-query', () => ({ useQuery: shotQuery }));
vi.doMock('@/shots/shots.fn', () => ({ getShotsForSequencesFn: vi.fn() }));
const { useSequencesWithShots } = await import('./use-sequences-with-shots');

function Probe({ enabled = true, loadShots = false }) {
  const result = useSequencesWithShots({ enabled, loadShots });
  return <span>{result.error?.message ?? result.data[0]?.title}</span>;
}

beforeEach(() => vi.clearAllMocks());
describe('on-demand sequence shots', () => {
  it('shows the sequence without requesting shots or surfacing an old shot error', () => {
    const html = renderToStaticMarkup(<Probe />);
    expect(shotQuery).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
    expect(html).toContain('Film');
    expect(html).not.toContain('failed');
  });
  it('enables the batch query and surfaces its errors in a comparison view', () => {
    const html = renderToStaticMarkup(<Probe loadShots />);
    expect(shotQuery).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true })
    );
    expect(html).toContain('Previous comparison request failed');
  });
  it('disables both own-team queries in support mode, even with cached sequence ids', () => {
    renderToStaticMarkup(<Probe enabled={false} loadShots />);
    expect(useSequences).toHaveBeenCalledWith(undefined, { enabled: false });
    expect(shotQuery).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
  });
});
