import { cn } from '@/lib/utils';
import {
  DEFAULT_STUDIO_COMPOSER_MAX_FRACTION,
  MAX_STUDIO_COMPOSER_MAX_FRACTION,
  MIN_STUDIO_COMPOSER_MAX_FRACTION,
  STUDIO_COMPOSER_KEYBOARD_STEP,
  composerMaxFractionFromPointer,
} from '@/lib/studio/composer-max-height';
import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';

type StudioComposerResizeHandleProps = {
  fraction: number;
  onFractionChange: (next: number) => void;
  columnRef: RefObject<HTMLElement | null>;
};

function fractionFromColumn(
  column: HTMLElement | null,
  clientY: number
): number | null {
  if (!column) return null;
  const rect = column.getBoundingClientRect();
  return composerMaxFractionFromPointer({
    columnHeight: rect.height,
    columnBottom: rect.bottom,
    clientY,
  });
}

export function StudioComposerResizeHandle({
  fraction,
  onFractionChange,
  columnRef,
}: StudioComposerResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const percent = Math.round(fraction * 100);

  useEffect(() => {
    if (!dragging) return;
    const { body } = document;
    const previousCursor = body.style.cursor;
    const previousSelect = body.style.userSelect;
    body.style.cursor = 'ns-resize';
    body.style.userSelect = 'none';
    return () => {
      body.style.cursor = previousCursor;
      body.style.userSelect = previousSelect;
    };
  }, [dragging]);

  const applyPointer = useCallback(
    (clientY: number) => {
      const next = fractionFromColumn(columnRef.current, clientY);
      if (next != null) onFractionChange(next);
    },
    [columnRef, onFractionChange]
  );

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    applyPointer(event.clientY);
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    applyPointer(event.clientY);
  };

  const endDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        event.preventDefault();
        onFractionChange(fraction + STUDIO_COMPOSER_KEYBOARD_STEP);
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        event.preventDefault();
        onFractionChange(fraction - STUDIO_COMPOSER_KEYBOARD_STEP);
        break;
      case 'Home':
        event.preventDefault();
        onFractionChange(MIN_STUDIO_COMPOSER_MAX_FRACTION);
        break;
      case 'End':
        event.preventDefault();
        onFractionChange(MAX_STUDIO_COMPOSER_MAX_FRACTION);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        onFractionChange(DEFAULT_STUDIO_COMPOSER_MAX_FRACTION);
        break;
      default:
        break;
    }
  };

  return (
    <button
      type="button"
      aria-label={`Prompt height, ${percent} percent`}
      data-testid="studio-composer-resize"
      data-dragging={dragging ? 'true' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() =>
        onFractionChange(DEFAULT_STUDIO_COMPOSER_MAX_FRACTION)
      }
      onKeyDown={onKeyDown}
      className={cn(
        'absolute inset-x-0 top-0 z-10 flex h-11 -translate-y-1/2 cursor-ns-resize touch-none items-center justify-center border-0 bg-transparent p-0 outline-none select-none md:h-6',
        'hover:[&>[data-slot=grip]]:bg-muted-foreground/50',
        'focus-visible:[&>[data-slot=grip]]:bg-muted-foreground focus-visible:[&>[data-slot=grip]]:ring-3 focus-visible:[&>[data-slot=grip]]:ring-ring/50'
      )}
    >
      <span
        data-slot="grip"
        aria-hidden="true"
        className={cn(
          'block h-1 w-10 rounded-full bg-border',
          dragging && 'bg-muted-foreground'
        )}
      />
    </button>
  );
}
