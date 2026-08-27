import { Button } from '@/components/ui/button';
import { useFullscreen } from '@/hooks/use-fullscreen';
import { cn } from '@/lib/utils';
import { Maximize, Minimize } from 'lucide-react';

type FullscreenButtonProps = {
  /** Container to fullscreen. Needs a descendant `<video>` on iPhone. */
  targetRef: React.RefObject<HTMLElement | null>;
  className?: string;
};

export const FullscreenButton: React.FC<FullscreenButtonProps> = ({
  targetRef,
  className,
}) => {
  const { isFullscreen, supported, toggle } = useFullscreen(targetRef);
  if (!supported) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        'h-11 w-11 text-white hover:bg-white/10 hover:text-white md:h-8 md:w-8',
        className
      )}
      onClick={toggle}
      aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
    >
      {isFullscreen ? (
        <Minimize className="h-5 w-5 md:h-4 md:w-4" />
      ) : (
        <Maximize className="h-5 w-5 md:h-4 md:w-4" />
      )}
    </Button>
  );
};
