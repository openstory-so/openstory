import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Eraser, PencilLine, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent } from 'react';

type DrawingTool = 'pen' | 'mask';

type StudioDrawingCanvasProps = {
  className?: string;
  disabled?: boolean;
  onCancel: () => void;
  onSubmit: (file: File) => Promise<void> | void;
};

const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 540;
const MAX_UNDO_STEPS = 3;
const STROKE_WIDTH = 8;

function drawStroke(
  context: CanvasRenderingContext2D,
  tool: DrawingTool,
  from: { x: number; y: number },
  to: { x: number; y: number }
) {
  context.save();
  context.strokeStyle = tool === 'mask' ? '#ffffff' : '#111111';
  context.lineWidth = STROKE_WIDTH;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
  context.restore();
}

export function StudioDrawingCanvas({
  className,
  disabled = false,
  onCancel,
  onSubmit,
}: StudioDrawingCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerIdRef = useRef<number | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const strokeStartedRef = useRef(false);
  const pendingSnapshotRef = useRef<ImageData | null>(null);
  const [tool, setTool] = useState<DrawingTool>('pen');
  const [undoStack, setUndoStack] = useState<ImageData[]>([]);
  const [hasInk, setHasInk] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }, []);

  const getContext = (): CanvasRenderingContext2D | null =>
    canvasRef.current?.getContext('2d') ?? null;

  const pointFromEvent = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * CANVAS_HEIGHT,
    };
  };

  const captureSnapshot = (): ImageData | null => {
    const context = getContext();
    if (!context) return null;
    return context.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  };

  const resetCanvas = () => {
    const context = getContext();
    if (!context) return;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  };

  const pushUndoSnapshot = (snapshot: ImageData | null) => {
    if (!snapshot) return;
    setUndoStack((previous) => [
      ...previous.slice(-(MAX_UNDO_STEPS - 1)),
      snapshot,
    ]);
  };

  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (disabled || submitting) return;
    const point = pointFromEvent(event);
    const canvas = canvasRef.current;
    if (!point || !canvas) return;
    pendingSnapshotRef.current = captureSnapshot();
    strokeStartedRef.current = false;
    pointerIdRef.current = event.pointerId;
    lastPointRef.current = point;
    canvas.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    const point = pointFromEvent(event);
    const context = getContext();
    const previous = lastPointRef.current;
    if (!point || !context || !previous) return;
    drawStroke(context, tool, previous, point);
    lastPointRef.current = point;
    strokeStartedRef.current = true;
    setHasInk(true);
  };

  const finishStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (pointerIdRef.current !== event.pointerId || !canvas) return;
    const point = pointFromEvent(event);
    const context = getContext();
    const previous = lastPointRef.current;
    if (point && context && previous && !strokeStartedRef.current) {
      drawStroke(context, tool, previous, point);
      setHasInk(true);
      strokeStartedRef.current = true;
    }
    if (strokeStartedRef.current) {
      pushUndoSnapshot(pendingSnapshotRef.current);
    }
    pendingSnapshotRef.current = null;
    strokeStartedRef.current = false;
    lastPointRef.current = null;
    pointerIdRef.current = null;
    canvas.releasePointerCapture(event.pointerId);
  };

  const handleUndo = () => {
    const context = getContext();
    if (!context || undoStack.length === 0 || disabled || submitting) return;
    const snapshot = undoStack[undoStack.length - 1];
    if (!snapshot) return;
    context.putImageData(snapshot, 0, 0);
    setUndoStack((previous) => previous.slice(0, -1));
    const blank = snapshot.data.every((value, index) =>
      (index + 1) % 4 === 0 ? value === 255 : value === 255
    );
    setHasInk(!blank);
  };

  const handleClear = () => {
    if (!hasInk || disabled || submitting) return;
    pushUndoSnapshot(captureSnapshot());
    resetCanvas();
    setHasInk(false);
  };

  const handleSubmit = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !hasInk || disabled || submitting) return;
    setSubmitting(true);
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((next) => {
          if (next) resolve(next);
          else reject(new Error('Failed to export drawing'));
        }, 'image/png');
      });
      const file = new File([blob], `reference-drawing-${Date.now()}.png`, {
        type: 'image/png',
      });
      await onSubmit(file);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={cn('flex flex-col gap-4 p-4', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={tool === 'pen' ? 'default' : 'outline'}
          size="sm"
          disabled={disabled || submitting}
          onClick={() => setTool('pen')}
        >
          <PencilLine aria-hidden="true" />
          Pen
        </Button>
        <Button
          type="button"
          variant={tool === 'mask' ? 'default' : 'outline'}
          size="sm"
          disabled={disabled || submitting}
          onClick={() => setTool('mask')}
        >
          <Eraser aria-hidden="true" />
          Mask
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || submitting || undoStack.length === 0}
          onClick={handleUndo}
        >
          <RotateCcw aria-hidden="true" />
          Undo
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || submitting || !hasInk}
          onClick={handleClear}
        >
          <Trash2 aria-hidden="true" />
          Clear
        </Button>
        <p className="ml-auto text-xs text-muted-foreground">
          Freehand only. Undo up to 3 strokes.
        </p>
      </div>

      <div className="rounded-lg border bg-muted/40 p-3">
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          aria-label="Drawing canvas"
          className="block aspect-video w-full cursor-crosshair rounded-md border bg-white shadow-xs"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          onPointerLeave={(event) => {
            if (pointerIdRef.current === event.pointerId) finishStroke(event);
          }}
        />
      </div>

      <p className="text-sm text-muted-foreground">
        Draw in black, or use Mask to paint white over existing lines. The
        sketch is flattened to a PNG reference when you add it.
      </p>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={submitting}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          disabled={!hasInk || submitting}
          onClick={() => void handleSubmit()}
        >
          {submitting ? 'Adding…' : 'Add drawing'}
        </Button>
      </div>
    </div>
  );
}
