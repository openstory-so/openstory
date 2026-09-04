/**
 * LLMTR brand mark — the crescent takes `currentColor` so it reads in both
 * themes, and the star keeps the brand red (#B91C1C).
 * Source: llmtr.com/logo-mark.svg (compact variant's viewBox), (c) Knowhy.co.
 */
export const LlmtrLogo: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg viewBox="14 6 38 24" className={className} aria-hidden="true">
      <path
        d="M 38 18 A 11 11 0 1 0 16 18 A 11 11 0 1 0 38 18 Z M 38 18 A 8 8 0 1 0 22 18 A 8 8 0 1 0 38 18 Z"
        fill="currentColor"
        fillRule="evenodd"
      />
      <polygon
        points="46,13 47.12,16.45 50.76,16.45 47.82,18.59 48.94,22.05 46,19.91 43.06,22.05 44.18,18.59 41.24,16.45 44.88,16.45"
        fill="#B91C1C"
      />
    </svg>
  );
};
