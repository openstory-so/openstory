import { BillingGateDialog } from '@/components/billing/billing-gate-dialog';
import { OpenStoryLogo } from '@/components/icons/openstory-logo';
import { PageContainer } from '@/components/layout/page-container';
import { PageIntro } from '@/components/typography/page-intro';
import { ScriptView } from '@/components/script/script-view';
import { Skeleton } from '@/components/ui/skeleton';
import { useBillingGate } from '@/hooks/use-billing-gate';
import { useSequence } from '@/hooks/use-sequences';
import { useStyles } from '@/hooks/use-styles';
import { useUser } from '@/hooks/use-user';
import { SITE_CONFIG } from '@/lib/marketing/constants';
import { AUTO_STYLE_ID } from '@/lib/style/auto-style';
import { briefForStyle } from '@/lib/style/brief-for-style';
import { styleSlug } from '@/lib/style/style-slug';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

const BILLING_PROMPT_KEY = 'openstory:billing-prompt-dismissed';
const BILLING_PROMPT_EXPIRY_DAYS = 1;

function wasBillingPromptDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  const raw = localStorage.getItem(BILLING_PROMPT_KEY);
  if (!raw) return false;
  const expiry = Number(raw);
  if (Date.now() > expiry) {
    localStorage.removeItem(BILLING_PROMPT_KEY);
    return false;
  }
  return true;
}

function dismissBillingPrompt() {
  const expiry = Date.now() + BILLING_PROMPT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  localStorage.setItem(BILLING_PROMPT_KEY, String(expiry));
}

type NewSequencePageProps = {
  style?: string;
  prefill?: 'style';
  from?: string;
  /**
   * Path used when the composer echoes its style pick into `?style=`.
   * Home lives at `/`; the logged-in alias is `/sequences/new`.
   */
  composerPath: '/' | '/sequences/new';
};

/**
 * Shared composer used by the root home (`/`) and the logged-in alias
 * (`/sequences/new`). Anonymous visitors get the marketing lead-in;
 * signed-in users get a full-height composer.
 */
export function NewSequencePage({
  style: styleParam,
  prefill,
  from,
  composerPath,
}: NewSequencePageProps) {
  const navigate = useNavigate();
  // Copy mode (#1037): hand the composer the source sequence and it seeds its
  // script + every generation setting from it, and creates with
  // `sourceSequenceId`. `allowScriptEdit` re-enables the editor, which is
  // read-only when the composer shows an analysed sequence's derived script —
  // correct there (the canonical text lives in scene versions), wrong here
  // (this text is only the seed for a new analysis, nothing writes back).
  const { data: sourceSequence } = useSequence(from ?? '');
  // Session is prefetched in _app/route.tsx beforeLoad, so this is settled on
  // first render — no flash for signed-in users.
  const { data: user } = useUser();

  // Sample-style prefill (#956): the showcase/gallery "Try this style" links
  // carry `?style=<slug>` (the slug the style's assets live under) + `#compose`
  // (so the router scrolls to the composer). Derive the seed straight from the
  // param during render — no effect, no state to keep in sync. The brief is
  // resolved from the style here so the URL only needs the slug; settings
  // (models, aspect ratio) follow once the style is selected. Remounting the
  // composer (`key`) on a new seed lets the `initialScript`/`initialStyleId`
  // props re-seed it — and take precedence over a stale draft (see ScriptView).
  const { data: styles } = useStyles();

  // The composer mirrors its style pick into `?style=` (see `handleStyleChange`
  // below). When that self-sync is what changed the URL, the composer must NOT
  // re-seed or remount — only a genuine external navigation (a fresh "Try" /
  // "Use this style" link, or the showcase) should. `lastSelfSyncRef` remembers
  // the slug we wrote; `seedRef` freezes the one-time seed across our own syncs
  // so picking a style never clears the script.
  const lastSelfSyncRef = useRef<string | null>(null);
  const seedRef = useRef<{ key: string; script?: string; styleId?: string }>({
    key: 'blank',
  });

  const seedStyle = styleParam
    ? styles?.find((s) => styleSlug(s.name) === styleParam)
    : undefined;
  // `prefill=style` ("Use this style", and the composer's own selection sync)
  // seeds ONLY the style; the default ("Try" / gallery) also seeds the style's
  // sample brief as the prompt.
  const styleOnly = prefill === 'style';
  let candidateScript: string | undefined;
  if (seedStyle && !styleOnly) {
    try {
      candidateScript = briefForStyle({
        name: seedStyle.name,
        category: seedStyle.category,
      });
    } catch {
      // Unmapped style — leave the composer blank rather than seed nothing.
      candidateScript = undefined;
    }
  }
  // Distinguish the two seed modes so switching between "Try" and "Use this
  // style" for the same style still re-seeds.
  // `?style=auto` seeds the Automatic tile (#1213) — no sample to prefill.
  const seedAuto = styleParam === AUTO_STYLE_ID;
  const candidateKey = seedStyle
    ? `seed:${seedStyle.id}:${styleOnly ? 'style' : 'full'}`
    : seedAuto
      ? `seed:${AUTO_STYLE_ID}`
      : 'blank';

  // Adopt the URL's seed unless this `?style=` is the composer echoing its own
  // pick back — then keep the frozen seed so the composer stays mounted and the
  // script is preserved.
  const isSelfSync =
    styleParam != null && styleParam === lastSelfSyncRef.current;
  if (!isSelfSync && candidateKey !== seedRef.current.key) {
    seedRef.current = {
      key: candidateKey,
      script: candidateScript,
      styleId: seedStyle?.id ?? (seedAuto ? AUTO_STYLE_ID : undefined),
    };
  }
  const {
    key: composerKey,
    script: seedScript,
    styleId: seedStyleId,
  } = seedRef.current;

  // Reflect the composer's style pick in the URL so `?style=` always matches the
  // current selection (shareable, restores on reload). `replace` keeps it out of
  // the history stack.
  const handleStyleChange = useCallback(
    (styleId: string) => {
      const selected = styles?.find((s) => s.id === styleId);
      if (!selected && styleId !== AUTO_STYLE_ID) return;
      const slug = selected ? styleSlug(selected.name) : AUTO_STYLE_ID;
      lastSelfSyncRef.current = slug;
      void navigate({
        to: composerPath,
        // Spread prev so future search keys are not clobbered on style pick.
        search: (prev) => ({
          ...prev,
          style: slug,
          prefill: 'style' as const,
        }),
        replace: true,
      });
    },
    [styles, navigate, composerPath]
  );

  const { needsBillingSetup, hasFalKey, stripeEnabled } = useBillingGate();
  const [billingOpen, setBillingOpen] = useState(false);

  // Clear billing return flag when user is back on this page
  useEffect(() => {
    localStorage.removeItem('openstory:billing-return');
  }, []);

  useEffect(() => {
    if (needsBillingSetup && !wasBillingPromptDismissed()) {
      setBillingOpen(true);
    }
  }, [needsBillingSetup]);

  const handleSuccess = useCallback(
    (sequenceIds: string[]) => {
      const [firstId] = sequenceIds;
      if (firstId) {
        // No explicit view: ScenesView forces the script view while the split
        // streams, then auto-reveals the canvas at the first preview (#1091).
        void navigate({
          to: '/sequences/$id/scenes',
          params: { id: firstId },
        });
      }
    },
    [navigate]
  );

  // Copy mode's Cancel goes back to the sequence you copied from, not to a
  // blank composer — you came from somewhere specific.
  const handleCancelCopy = useCallback(() => {
    if (!from) return;
    void navigate({ to: '/sequences/$id/scenes', params: { id: from } });
  }, [from, navigate]);

  const billingGate = (
    <BillingGateDialog
      open={billingOpen}
      onOpenChange={(open) => {
        setBillingOpen(open);
        if (!open) dismissBillingPrompt();
      }}
      hasFalKey={hasFalKey}
      stripeEnabled={stripeEnabled}
      context="onboarding"
    />
  );

  // Copy mode MUST wait for the source sequence before mounting the composer:
  // ScriptView seeds script, style, aspect ratio and models in `useState`
  // initialisers, and nothing re-syncs them afterwards. Mounted early it would
  // latch onto create defaults — empty script, Automatic — and still offer
  // "Generate Copy", producing a copy of nothing. Navigating from the sequence
  // hides this (its detail query is already cached); a direct link or a reload
  // does not.
  if (from && !sourceSequence) {
    return (
      <div className="h-full">
        {billingGate}
        <PageContainer maxWidth="narrow" fullHeight>
          <Skeleton className="h-96 w-full" />
        </PageContainer>
      </div>
    );
  }

  // Signed-in: same left one-liner as Sequences / Images / Models, then the
  // script box. Logged-out: logo + centered tagline + composer.
  if (user) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        {billingGate}
        <PageIntro title={SITE_CONFIG.tagline} maxWidth="narrow">
          {SITE_CONFIG.taglineSub}
        </PageIntro>
        <PageContainer
          maxWidth="narrow"
          padding="none"
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <ScriptView
              key={from ? `copy:${from}` : composerKey}
              loading={false}
              onSuccess={handleSuccess}
              sequence={sourceSequence}
              allowScriptEdit={!!from}
              onCancel={handleCancelCopy}
              initialScript={from ? undefined : seedScript}
              initialStyleId={from ? undefined : seedStyleId}
              initialScriptIsSample={!from && !!seedScript}
              onStyleChange={from ? undefined : handleStyleChange}
            />
          </div>
        </PageContainer>
      </div>
    );
  }

  // Logged-out: marketing lead-in + composer. The viewport-bounded layout
  // (`fullHeight` + `flex-1` wrapper) gives the card's `max-h-full` a real
  // bound, so it sizes to content but never extends past the viewport bottom —
  // a large paste scrolls inside the editor (#1000).
  return (
    <div className="h-full">
      {billingGate}
      <PageContainer
        maxWidth="narrow"
        padding="spacious"
        fullHeight
        // Phones: every row saved here goes to the script editor inside the
        // height-bounded composer below. short-h (≤800px tall): same idea on
        // 1280×720 laptops — the editor was collapsing to 0.
        className="space-y-4 sm:space-y-8 short-h:space-y-3 short-h:py-4 sm:short-h:py-4"
      >
        <div className="flex shrink-0 flex-col items-center gap-2 sm:gap-4 short-h:gap-1">
          <OpenStoryLogo className="h-8 sm:h-12 short-h:h-8" />
          <div className="flex flex-col items-center gap-1">
            <h1 className="text-center text-xl font-semibold tracking-tight sm:text-2xl">
              {SITE_CONFIG.tagline}
            </h1>
            <p className="text-center text-sm text-muted-foreground text-pretty max-w-md">
              {SITE_CONFIG.taglineSub}
            </p>
          </div>
        </div>
        {/* `#compose` target: the gallery "Try" links navigate here so the
            router scrolls the composer into view (scrollRestoration handles
            it). */}
        <div id="compose" className="flex min-h-0 flex-1 flex-col scroll-mt-4">
          <ScriptView
            key={composerKey}
            loading={false}
            onSuccess={handleSuccess}
            initialScript={seedScript}
            initialStyleId={seedStyleId}
            initialScriptIsSample={!!seedScript}
            onStyleChange={handleStyleChange}
          />
          {/* Right under the card (not pinned to the viewport bottom): the
              card is a sibling flex item that shrinks to fit above this. */}
          <Link
            to="/gallery"
            className="mt-4 inline-flex shrink-0 items-center justify-center gap-1 self-center text-sm font-medium text-muted-foreground hover:text-foreground short-h:hidden"
          >
            Browse the gallery to see what you can create
            <ArrowRight className="size-4" />
          </Link>
        </div>
      </PageContainer>
    </div>
  );
}
