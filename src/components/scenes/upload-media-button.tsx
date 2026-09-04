import { Button } from '@/components/ui/button';
import { Loader2, Upload } from 'lucide-react';
import { useRef } from 'react';

type UploadMediaButtonProps = {
  label: string;
  pendingLabel: string;
  /** File-input accept filter, e.g. `image/*`. */
  accept: string;
  isPending: boolean;
  disabled?: boolean;
  onFile: (file: File) => void;
  className?: string;
};

/**
 * Outline button fronting a hidden file input — the click-accessible path for
 * media replacement (drag-and-drop on the canvas is the shortcut, never the
 * only way in).
 */
export const UploadMediaButton: React.FC<UploadMediaButtonProps> = ({
  label,
  pendingLabel,
  accept,
  isPending,
  disabled,
  onFile,
  className,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          // Reset so picking the same file again re-fires onChange.
          event.currentTarget.value = '';
          if (file) onFile(file);
        }}
      />
      <Button
        type="button"
        variant="outline"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || isPending}
        className={className}
      >
        {isPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Upload className="mr-2 h-4 w-4" />
        )}
        {isPending ? pendingLabel : label}
      </Button>
    </>
  );
};
