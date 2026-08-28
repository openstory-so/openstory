import { useCallback, useRef, type PointerEvent } from 'react';

const THRESHOLD_PX = 56;

/**
 * Horizontal swipe (touch/pen only) that ignores vertical pans and
 * interactive controls. `delta` is -1 for previous (swipe right), +1 for next
 * (swipe left).
 */
export function useHorizontalSwipe(
  onSwipe: ((delta: -1 | 1) => void) | undefined
) {
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!onSwipe) return;
      if (event.pointerType === 'mouse') return;
      if (
        typeof window !== 'undefined' &&
        window.matchMedia('(min-width: 768px)').matches
      ) {
        return;
      }
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input, textarea, button, a, [role="slider"]')
      ) {
        return;
      }
      startRef.current = { x: event.clientX, y: event.clientY };
    },
    [onSwipe]
  );

  const finish = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const start = startRef.current;
      startRef.current = null;
      if (!onSwipe || !start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.abs(dx) < THRESHOLD_PX || Math.abs(dx) < Math.abs(dy)) return;
      onSwipe(dx < 0 ? 1 : -1);
    },
    [onSwipe]
  );

  const onPointerUp = finish;
  const onPointerCancel = useCallback(() => {
    startRef.current = null;
  }, []);

  if (!onSwipe) return {};
  return { onPointerDown, onPointerUp, onPointerCancel };
}
