import { cn } from '@/shared/utils';

type BlobLoaderProps = {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
};

const sizeConfig = {
  sm: {
    container: 'w-12 h-12',
    blob: 'w-8 h-8',
  },
  md: {
    container: 'w-[72px] h-[72px]',
    blob: 'w-12 h-12',
  },
  lg: {
    container: 'w-24 h-24',
    blob: 'w-16 h-16',
  },
};

export const BlobLoader: React.FC<BlobLoaderProps> = ({
  size = 'md',
  className,
}) => {
  const config = sizeConfig[size];

  return (
    <div
      className={cn(
        'relative flex items-center justify-center',
        config.container,
        className
      )}
    >
      <div
        className={cn(
          config.blob,
          'bg-linear-to-br from-[#6D28D9] via-[#A855F7] to-[#EA7B30]',
          'dark:from-[#A770EF] dark:via-[#CF8BF3] dark:to-[#FDB99B]',
          'bg-[length:200%_200%]',
          'animate-[blob-morph_8s_ease-in-out_infinite,blob-glow_6s_ease-in-out_infinite]',
          'shadow-[0_0_20px_rgba(167,112,239,0.3),0_0_40px_rgba(253,185,155,0.2)]',
          'blur-[0.5px]'
        )}
      />
    </div>
  );
};

export const BlobLoaderContainer: React.FC<{
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}> = ({ size = 'md', className }) => {
  return (
    <div
      className={cn(
        'relative flex items-center justify-center overflow-hidden bg-muted',
        className
      )}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(167,112,239,0.12),transparent_70%)]" />
      <BlobLoader size={size} />
    </div>
  );
};
