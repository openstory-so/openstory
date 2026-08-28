import { AppImage } from '@/components/ui/app-image';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import {
  optimizedVideoUrl,
  videoPosterUrl,
} from '@/lib/media/cloudflare-video';
import {
  styleBespokeVideoUrl,
  styleCanonicalVideoUrl,
  styleCategoryLabel,
  stylePreviewImageUrls,
} from '@/lib/style/style-assets';
import {
  getConfigColorPalette,
  getConfigDisplayFields,
} from '@/lib/style/style-config';
import { styleSlug } from '@/lib/style/style-slug';
import type { Style } from '@/types/database';
import { Link } from '@tanstack/react-router';
import { Wand2 } from 'lucide-react';
import type { FC } from 'react';
import { useState } from 'react';
import { getStyleGradient } from './style-gradient';

type StyleDetailDialogProps = {
  style: Style | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * When provided, the footer "Use this style" selects the style in place
   * (and closes the dialog) instead of navigating to a fresh composer — used
   * when the dialog is opened from within the composer, where navigating away
   * would discard the current draft.
   */
  onUseStyle?: (styleId: string) => void;
  /**
   * When provided, the sample clips' "Try" buttons hand the style to the host
   * composer (which swaps in its sample script, confirming first over user
   * text) and close the dialog, instead of navigating to a fresh composer.
   */
  onTryStyle?: (styleId: string) => void;
  /** Hide the "Use this style" CTA — for a sequence-bound automatic style
   *  (#1213), which no other sequence can select until it is promoted. */
  readOnly?: boolean;
};

/** A still that removes itself if the source 404s (some older styles render
 * fewer than three scenes), so the row never shows a broken image box. */
const PreviewStill: FC<{ src: string; alt: string }> = ({ src, alt }) => {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <div className="relative aspect-square overflow-hidden rounded-md bg-muted">
      <AppImage
        src={src}
        alt={alt}
        layout="fullWidth"
        className="h-full w-full object-cover"
        onError={() => setFailed(true)}
      />
    </div>
  );
};

/** A sample clip (canonical or bespoke) with a "Try" overlay that opens the
 *  composer seeded with this style's brief + selection — same as the gallery.
 *  Top-right so the button clears the video's bottom control bar. */
const SampleClip: FC<{
  src: string;
  poster?: string;
  styleName: string;
  slug: string;
  label?: string;
  autoPlay?: boolean;
  /** In-composer Try: swap in this style's sample instead of navigating. */
  onTry?: () => void;
}> = ({ src, poster, styleName, slug, label, autoPlay, onTry }) => (
  <div className="flex flex-col gap-1">
    {label && (
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
    )}
    <div className="flex justify-center">
      <div className="relative inline-block">
        <video
          src={src}
          poster={poster}
          className="block max-h-[60vh] w-auto max-w-full rounded-lg border bg-muted object-contain"
          autoPlay={autoPlay}
          muted
          loop
          playsInline
          controls
          aria-label={`${styleName} ${label ?? 'sample'} video`}
        />
        {onTry ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={onTry}
            aria-label={`Try the ${styleName} style`}
            className="absolute right-2 top-2 gap-1.5 opacity-90 backdrop-blur-sm transition-opacity hover:opacity-100"
          >
            <Wand2 className="size-3.5" />
            Try
          </Button>
        ) : (
          <Button
            asChild
            size="sm"
            variant="secondary"
            className="absolute right-2 top-2 gap-1.5 opacity-90 backdrop-blur-sm transition-opacity hover:opacity-100"
          >
            <Link
              to="/"
              search={{ style: slug }}
              hash="compose"
              aria-label={`Try the ${styleName} style`}
            >
              <Wand2 className="size-3.5" />
              Try
            </Link>
          </Button>
        )}
      </div>
    </div>
  </div>
);

const ConfigRow: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
      {label}
    </dt>
    <dd className="text-sm leading-relaxed">{value}</dd>
  </div>
);

/**
 * Detail view for a style: its canonical sample video, the three preview
 * stills, description, and the full visual config (mood, lighting, camera,
 * palette, reference films, tags), plus a "Use this style" CTA that opens the
 * composer seeded with this style (`/?style=<slug>#compose`, #956).
 * Opened from the styles page card.
 */
export const StyleDetailDialog: FC<StyleDetailDialogProps> = ({
  style,
  open,
  onOpenChange,
  onUseStyle,
  onTryStyle,
  readOnly = false,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-[95vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl lg:max-w-4xl">
        {style && (
          <StyleDetailContent
            style={style}
            onUseStyle={
              onUseStyle
                ? () => {
                    onUseStyle(style.id);
                    onOpenChange(false);
                  }
                : undefined
            }
            onTryStyle={
              onTryStyle
                ? () => {
                    onTryStyle(style.id);
                    onOpenChange(false);
                  }
                : undefined
            }
            readOnly={readOnly}
          />
        )}
      </DialogContent>
    </Dialog>
  );
};

const StyleDetailContent: FC<{
  style: Style;
  onUseStyle?: () => void;
  onTryStyle?: () => void;
  readOnly?: boolean;
}> = ({ style, onUseStyle, onTryStyle, readOnly = false }) => {
  const canonicalUrl = styleCanonicalVideoUrl(style);
  const videoSrc = canonicalUrl ? optimizedVideoUrl(canonicalUrl) : null;
  const poster = canonicalUrl ? videoPosterUrl(canonicalUrl) : undefined;
  const bespokeUrl = styleBespokeVideoUrl(style);
  const bespokeSrc = bespokeUrl ? optimizedVideoUrl(bespokeUrl) : null;
  const bespokePoster = bespokeUrl ? videoPosterUrl(bespokeUrl) : undefined;
  const slug = styleSlug(style.name);
  const stills = stylePreviewImageUrls(style);
  // Total accessors: a malformed legacy row renders as empty fields, not a
  // ZodError blanking the dialog.
  const display = getConfigDisplayFields(style.config);
  const palette = getConfigColorPalette(style.config);
  const tags = style.tags ?? [];

  const configRows: Array<{ label: string; value: string }> = [
    { label: 'Mood', value: display.mood ?? '' },
    { label: 'Art style', value: display.artStyle ?? '' },
    { label: 'Lighting', value: display.lighting ?? '' },
    { label: 'Camera', value: display.camera ?? '' },
    { label: 'Color grading', value: display.colorGrading ?? '' },
  ].filter((row) => row.value.trim());

  return (
    <div className="flex min-h-0 flex-col">
      <DialogHeader className="space-y-2 px-6 pt-6">
        <div className="flex flex-wrap items-center gap-2">
          <DialogTitle className="text-xl">{style.name}</DialogTitle>
          {style.category && (
            <Badge variant="secondary">
              {styleCategoryLabel(style.category)}
            </Badge>
          )}
        </div>
        {style.description && (
          <DialogDescription className="text-sm leading-relaxed">
            {style.description}
          </DialogDescription>
        )}
      </DialogHeader>

      <div className="grid min-h-0 flex-1 gap-6 overflow-y-auto px-6 py-4 lg:grid-cols-[1.4fr_1fr]">
        {/* Media: the sample clip(s) + the three preview stills. Hero styles
            also show a bespoke "Showcase" clip; each clip carries its own
            "Try". */}
        <div className="flex flex-col gap-4">
          {videoSrc ? (
            <SampleClip
              src={videoSrc}
              poster={poster}
              styleName={style.name}
              slug={slug}
              label={bespokeSrc ? 'Sample' : undefined}
              autoPlay
              onTry={onTryStyle}
            />
          ) : (
            <div
              className="aspect-video w-full overflow-hidden rounded-lg border"
              style={{ background: getStyleGradient(palette) }}
            />
          )}
          {bespokeSrc && (
            <SampleClip
              src={bespokeSrc}
              poster={bespokePoster}
              styleName={style.name}
              slug={slug}
              label="Showcase"
              onTry={onTryStyle}
            />
          )}

          {stills.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {stills.map((src, i) => (
                <PreviewStill
                  key={src}
                  src={src}
                  alt={`${style.name} preview ${i + 1}`}
                />
              ))}
            </div>
          )}
        </div>

        {/* Visual config */}
        <div className="flex flex-col gap-4">
          {palette.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Palette
              </span>
              <div className="flex flex-wrap gap-1.5">
                {palette.map((color) => (
                  <span
                    key={color}
                    className="h-6 w-6 rounded-full border"
                    style={{ backgroundColor: color }}
                    title={color}
                  />
                ))}
              </div>
            </div>
          )}

          <dl className="flex flex-col gap-3">
            {configRows.map((row) => (
              <ConfigRow key={row.label} label={row.label} value={row.value} />
            ))}
          </dl>

          {display.references.length > 0 && (
            <>
              <Separator />
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Reference films
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {display.references.map((film) => (
                    <Badge key={film} variant="outline">
                      {film}
                    </Badge>
                  ))}
                </div>
              </div>
            </>
          )}

          {tags.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Tags
              </span>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Reset the footer's default `-mx-4 -mb-4` bleed: this dialog uses a
          `p-0` content, so the footer bar aligns to the content edges here. */}
      <DialogFooter className="mx-0 mb-0 border-t px-6 py-4">
        {/* "Use this style" = select the style only (blank prompt) — distinct
            from the video's "Try", which also seeds the sample brief. From the
            composer it selects in place (onUseStyle); from the styles page it
            navigates to a fresh composer seeded with this style. */}
        {readOnly ? null : onUseStyle ? (
          <Button
            onClick={onUseStyle}
            aria-label={`Use the ${style.name} style`}
          >
            Use this style
          </Button>
        ) : (
          <Button asChild>
            <Link
              to="/"
              search={{ style: styleSlug(style.name), prefill: 'style' }}
              hash="compose"
              aria-label={`Use the ${style.name} style`}
            >
              Use this style
            </Link>
          </Button>
        )}
      </DialogFooter>
    </div>
  );
};
