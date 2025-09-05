import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cva, type VariantProps } from "class-variance-authority";
import Image from "next/image";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Frame } from "@/types/database";

const storyboardFrameVariants = cva(
  "relative rounded-lg border-2 bg-white shadow-sm transition-all",
  {
    variants: {
      selected: {
        true: "border-blue-500 ring-2 ring-blue-200",
        false: "border-gray-200",
      },
      dragging: {
        true: "opacity-50",
        false: "",
      },
      disabled: {
        true: "opacity-50",
        false: "hover:shadow-md",
      },
    },
    defaultVariants: {
      selected: false,
      dragging: false,
      disabled: false,
    },
  },
);

const orderIndicatorVariants = cva(
  "absolute -top-2 -left-2 z-10 flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold text-white cursor-grab",
  {
    variants: {
      color: {
        primary: "bg-blue-500",
      },
    },
    defaultVariants: {
      color: "primary",
    },
  },
);

const frameContentVariants = cva(
  "aspect-video w-full overflow-hidden rounded-md",
);

const frameImageVariants = cva("h-full w-full object-cover");

const emptyFrameVariants = cva(
  "flex h-full w-full items-center justify-center bg-gray-100 text-gray-500",
);

const frameInfoVariants = cva("p-3");

const frameDescriptionVariants = cva("text-sm text-gray-600 line-clamp-2");

const frameDurationVariants = cva("mt-1 text-xs text-gray-400");

const actionOverlayVariants = cva(
  "absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity hover:opacity-100",
);

const actionButtonsVariants = cva("flex gap-2");

interface StoryboardFrameProps
  extends VariantProps<typeof storyboardFrameVariants> {
  frame: Frame;
  showOrder?: boolean;
  isGeneratingPreview?: boolean;
  onSelect?: (frameId: string) => void;
  onEdit?: (frameId: string) => void;
  onDelete?: (frameId: string) => void;
  onReorder?: (frameId: string, newOrder: number) => void;
}

export const StoryboardFrame: React.FC<StoryboardFrameProps> = ({
  frame,
  selected = false,
  disabled = false,
  dragging = false,
  showOrder = true,
  isGeneratingPreview = false,
  onSelect: _onSelect,
  onEdit,
  onDelete,
  onReorder: _onReorder,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: frame.id,
    disabled: disabled || false,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        storyboardFrameVariants({
          selected,
          disabled,
          dragging: isDragging || dragging,
        }),
      )}
    >
      {/* Order indicator */}
      {showOrder && (
        <div
          className={cn(orderIndicatorVariants())}
          {...attributes}
          {...listeners}
        >
          {frame.order_index + 1}
        </div>
      )}

      {/* Frame content */}
      <div className={cn(frameContentVariants())}>
        {frame.thumbnail_url ? (
          <Image
            src={frame.thumbnail_url}
            alt={`Frame ${frame.order_index + 1} preview`}
            className={cn(frameImageVariants())}
            width={1920}
            height={1080}
          />
        ) : (
          <div className={cn(emptyFrameVariants())}>
            {isGeneratingPreview ? (
              <div className="flex flex-col items-center gap-2">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
                <span className="text-xs">Generating preview...</span>
              </div>
            ) : (
              "No preview available"
            )}
          </div>
        )}
      </div>

      {/* Frame info - show script chunk from metadata or fallback to description */}
      <div className={cn(frameInfoVariants())}>
        <p className={cn(frameDescriptionVariants())}>
          {(() => {
            const metadata = frame.metadata as Record<string, unknown> | null;
            const scriptChunk = metadata?.scriptChunk as string | undefined;
            return scriptChunk || frame.description;
          })()}
        </p>
        {frame.duration_ms && (
          <p className={cn(frameDurationVariants())}>
            {(frame.duration_ms / 1000).toFixed(1)}s
          </p>
        )}
      </div>

      {/* Action buttons (shown on hover) */}
      {!disabled && (
        <div className={cn(actionOverlayVariants())}>
          <div className={cn(actionButtonsVariants())}>
            <Button
              onClick={(e) => {
                e.stopPropagation();
                onEdit?.(frame.id);
              }}
            >
              Edit
            </Button>
            <Button
              onClick={(e) => {
                e.stopPropagation();
                onDelete?.(frame.id);
              }}
              variant="destructive"
            >
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
