import { Button } from '@/ui/shadcn/button';
import { useCallback, useRef, useState, type PointerEvent } from 'react';
import { toast } from 'sonner';

type DrawingTool = 'pen' | 'erase';

type Point = { readonly x: number; readonly y: number };

type Stroke = { readonly pointerId: number; last: Point };

type StudioDrawingCanvasProps = {
  readonly onCancel: () => void;
  readonly onSubmit: (file: File) => void;
};

const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 540;
// ponytail: each step is a full-frame snapshot (~2 MB), so 25 steps hold
// ~50 MB while the modal is open. Store strokes and replay if that bites.
const MAX_UNDO_STEPS = 25;
const STROKE_WIDTH = 8;
const PEN_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cpath fill='%23111111' d='M22.8 4.5a2.4 2.4 0 0 1 3.4 0l1.3 1.3a2.4 2.4 0 0 1 0 3.4l-2 2-4.7-4.7 2-2Z'/%3E%3Cpath fill='%23111111' d='m7.7 20.2 12-12 4.7 4.7-12 12-5.5.8z'/%3E%3Cpath fill='%23ffffff' d='m8.5 19.4 4.1 4.1-4.9.8z'/%3E%3C/g%3E%3C/svg%3E") 4 28, crosshair`;

/** Blank means every channel is 255: the canvas is always opaque white underneath. */
export function isBlankSnapshot(snapshot: ImageData): boolean {
  return snapshot.data.every((value) => value === 255);
}

export function appendUndoSnapshot(
  previous: readonly ImageData[],
  snapshot: ImageData
): readonly ImageData[] {
  return [...previous.slice(-(MAX_UNDO_STEPS - 1)), snapshot];
}

export async function canvasToPngFile(
  canvas: Pick<HTMLCanvasElement, 'toBlob'>
): Promise<File> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((next) => {
      if (next) resolve(next);
      else reject(new Error('Failed to export drawing'));
    }, 'image/png');
  });

  return new File([blob], `reference-drawing-${Date.now()}.png`, {
    type: 'image/png',
  });
}

function paintBlank(context: CanvasRenderingContext2D): void {
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
}

function snapshotOf(context: CanvasRenderingContext2D): ImageData {
  return context.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
}

function drawSegment(
  context: CanvasRenderingContext2D,
  tool: DrawingTool,
  from: Point,
  to: Point
): void {
  context.strokeStyle = tool === 'erase' ? '#ffffff' : '#111111';
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
}

function pointFromEvent(event: PointerEvent<HTMLCanvasElement>): Point {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH,
    y: ((event.clientY - rect.top) / rect.height) * CANVAS_HEIGHT,
  };
}

export function StudioDrawingCanvas({
  onCancel,
  onSubmit,
}: StudioDrawingCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokeRef = useRef<Stroke | null>(null);
  const [tool, setTool] = useState<DrawingTool>('pen');
  const [undoStack, setUndoStack] = useState<readonly ImageData[]>([]);
  const [hasInk, setHasInk] = useState(false);

  // Stable identity: React re-runs a ref callback whenever it changes, and a
  // re-run would paint over the drawing.
  const initCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
    const context = canvas?.getContext('2d');
    if (!context) return;
    context.lineWidth = STROKE_WIDTH;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    paintBlank(context);
  }, []);

  const getContext = (): CanvasRenderingContext2D | null =>
    canvasRef.current?.getContext('2d') ?? null;

  // The canvas is the only word on whether there is ink: an eraser can empty
  // it, and an undo can bring it back.
  const syncInk = (context: CanvasRenderingContext2D) => {
    const inked = !isBlankSnapshot(snapshotOf(context));
    setHasInk(inked);
    if (!inked) setTool('pen');
  };

  const pushUndo = (context: CanvasRenderingContext2D) => {
    const snapshot = snapshotOf(context);
    setUndoStack((previous) => appendUndoSnapshot(previous, snapshot));
  };

  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const context = getContext();
    if (!context || strokeRef.current || event.button !== 0) return;
    const point = pointFromEvent(event);
    pushUndo(context);
    event.currentTarget.setPointerCapture(event.pointerId);
    strokeRef.current = { pointerId: event.pointerId, last: point };
    drawSegment(context, tool, point, point);
  };

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const context = getContext();
    const stroke = strokeRef.current;
    if (!context || stroke?.pointerId !== event.pointerId) return;
    const point = pointFromEvent(event);
    drawSegment(context, tool, stroke.last, point);
    stroke.last = point;
  };

  const finishStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    const context = getContext();
    if (!context || strokeRef.current?.pointerId !== event.pointerId) return;
    strokeRef.current = null;
    syncInk(context);
  };

  const handleUndo = () => {
    const context = getContext();
    const snapshot = undoStack.at(-1);
    if (!context || !snapshot) return;
    context.putImageData(snapshot, 0, 0);
    setUndoStack((previous) => previous.slice(0, -1));
    syncInk(context);
  };

  const handleClear = () => {
    const context = getContext();
    if (!context) return;
    pushUndo(context);
    paintBlank(context);
    syncInk(context);
  };

  const handleSubmit = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    void canvasToPngFile(canvas).then(onSubmit, () =>
      toast.error('Could not export the drawing')
    );
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={tool === 'pen' ? 'default' : 'outline'}
          size="sm"
          aria-pressed={tool === 'pen'}
          onClick={() => setTool('pen')}
        >
          Pen
        </Button>
        <Button
          type="button"
          variant={tool === 'erase' ? 'default' : 'outline'}
          size="sm"
          aria-pressed={tool === 'erase'}
          disabled={!hasInk}
          onClick={() => setTool('erase')}
        >
          Erase
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={undoStack.length === 0}
          onClick={handleUndo}
        >
          Undo
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!hasInk}
          onClick={handleClear}
        >
          Clear
        </Button>
      </div>

      <canvas
        ref={initCanvas}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        aria-label="Drawing canvas"
        className="block aspect-video w-full touch-none rounded-md border"
        style={{ cursor: PEN_CURSOR }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
      />

      <p className="text-sm text-muted-foreground">Drag to draw.</p>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" disabled={!hasInk} onClick={handleSubmit}>
          Add drawing
        </Button>
      </div>
    </div>
  );
}
