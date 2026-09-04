import { OpenStoryLogo } from '@/components/icons/openstory-logo';
import { SITE_CONFIG } from '@/shared/marketing/constants';

export const OgImageLinkedIn: React.FC = () => {
  return (
    <div className="relative flex h-[630px] w-[1200px] flex-col items-center justify-center overflow-hidden bg-black">
      <div className="absolute inset-0">
        <video
          autoPlay
          muted
          loop
          playsInline
          className="size-full object-cover object-center"
        >
          <source
            src="https://assets.openstory.so/videos/hero-loop.mp4"
            type="video/mp4"
          />
        </video>
      </div>

      <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-black/40 to-black/80" />

      {/* Scaled-down content container for "zoomed out" effect */}
      <div
        className="relative z-10 flex flex-col items-center text-center"
        style={{ transform: 'scale(0.65)', transformOrigin: 'center center' }}
      >
        <OpenStoryLogo className="mb-8 h-16 w-auto text-white" />

        <h1 className="font-heading text-[7rem] font-bold tracking-tighter leading-[0.95] text-white">
          Open Video
          <br />
          <span className="text-editorial">Generation.</span>
        </h1>

        <p className="mt-5 max-w-md text-xl text-white/70">
          {SITE_CONFIG.description}
        </p>
      </div>
    </div>
  );
};
