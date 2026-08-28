/**
 * Public model pricing catalog — lives in the app shell so it matches the
 * rest of the product chrome (sidebar, breadcrumbs). Anonymous-browsable.
 */

import { useAuthGate } from '@/components/auth/auth-gate-provider';
import { createFileRoute } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  formatPlatformFeePercent,
  PLATFORM_FEE_PERCENT,
} from '@/lib/billing/constants';
import { getPricingCatalogFn } from '@/functions/pricing';
import { openAddCreditsDialog } from '@/hooks/use-add-credits-dialog';
import { SITE_CONFIG } from '@/lib/marketing/constants';
import { ArrowUpRight, KeyRound } from 'lucide-react';

const title = `Pricing — ${SITE_CONFIG.name}`;
const description =
  'Pay providers as you go. Estimates before every spend. Bring your own keys to skip the wallet.';

export const Route = createFileRoute('/_app/pricing')({
  component: PricingPage,
  loader: () => getPricingCatalogFn(),
  staticData: { breadcrumb: 'Pricing' },
  head: () => ({
    meta: [
      { title },
      { name: 'description', content: description },
      { property: 'og:title', content: title },
      { property: 'og:description', content: description },
      { property: 'og:url', content: `${SITE_CONFIG.url}/pricing` },
      { name: 'twitter:title', content: title },
      { name: 'twitter:description', content: description },
    ],
  }),
});

function PricingPage() {
  const { sections, lastUpdated, filmCosts } = Route.useLoaderData();
  const { requireAuth } = useAuthGate();
  const feePercent = formatPlatformFeePercent();
  const chargeFor100 = (100 * (1 + PLATFORM_FEE_PERCENT)).toFixed(0);
  const onAddCredits = () => {
    requireAuth(() => openAddCreditsDialog('pricing'));
  };

  return (
    <div className="mx-auto w-full max-w-5xl p-6 pb-16">
      <header className="max-w-2xl">
        <h1 className="font-heading text-3xl font-bold tracking-tight">
          Pricing
        </h1>
        <p className="mt-3 text-base leading-relaxed text-muted-foreground">
          Pay providers as you go. We show an estimate under each action before
          you spend.
          {filmCosts ? (
            <>
              {' '}
              New accounts start with{' '}
              <span className="font-medium text-foreground tabular-nums">
                {filmCosts.welcomeCredits}
              </span>{' '}
              free — enough for a typical 30s short with motion and music.
            </>
          ) : null}
        </p>
      </header>

      {filmCosts && (
        <section id="film-cost" className="mt-10">
          <div className="mb-4 max-w-2xl">
            <h2 className="text-xl font-semibold tracking-tight">
              Typical first film
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {filmCosts.targetDurationSeconds}s target (Enhance default) with
              product defaults ({filmCosts.imageModelName},{' '}
              {filmCosts.videoModelName}, {filmCosts.audioModelName}). These use
              the same estimators as Generate (fixed 30s showcase) — we try to
              be as accurate as possible; the final charge can differ once
              generation finishes.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            {filmCosts.examples.map((example) => (
              <div
                key={example.id}
                className="flex flex-col gap-3 rounded-xl border bg-card p-5"
              >
                <div className="flex flex-col gap-0.5">
                  <p className="text-sm font-medium">{example.title}</p>
                  <p className="font-heading text-2xl font-bold tracking-tight tabular-nums">
                    {example.cost}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {example.subtitle}
                  </p>
                </div>
                <ul className="flex flex-col gap-1.5 border-t pt-3 text-xs text-muted-foreground">
                  {example.breakdown.map((line) => (
                    <li key={line} className="flex items-start gap-2">
                      <span
                        aria-hidden
                        className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50"
                      />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-6">
            <Button onClick={onAddCredits}>Add credits</Button>
          </div>
        </section>
      )}

      <section
        id="how-billing-works"
        className="mt-10 flex flex-col gap-3 text-sm text-muted-foreground"
      >
        <h2 className="text-base font-semibold tracking-tight text-foreground">
          How billing works
        </h2>
        <ul className="flex flex-col gap-2">
          <li>
            Credits are drawn at fal.ai / OpenRouter rates when you use the
            wallet. Media is fal; script analysis is OpenRouter.
          </li>
          <li>
            A {feePercent} fee applies only when you{' '}
            <span className="text-foreground">buy</span> credits ($
            {chargeFor100} charged → $100 wallet) — not on each generation.
          </li>
          <li className="flex items-start gap-2">
            <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              <span className="font-medium text-foreground">
                Bring your own keys
              </span>{' '}
              in Settings to pay platforms directly and skip the wallet. fal.ai
              covers media; OpenRouter is optional for analysis.
            </span>
          </li>
        </ul>
      </section>

      <div className="mt-12 flex flex-col gap-12">
        {sections.map((section) => (
          <section key={section.id} id={section.id}>
            <div className="mb-4 max-w-2xl">
              <h2 className="text-xl font-semibold tracking-tight">
                {section.title}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {section.description}
              </p>
            </div>

            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="px-4 py-3 font-medium">Model</th>
                    <th className="px-4 py-3 font-medium">Vendor</th>
                    <th className="px-4 py-3 font-medium">Via</th>
                    <th className="px-4 py-3 font-medium text-right">
                      Indicative rate
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {section.rows.map((row) => (
                    <tr
                      key={`${row.via}-${row.name}`}
                      className="border-b last:border-b-0 hover:bg-muted/20"
                    >
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{row.name}</span>
                          {row.license === 'open-source' && (
                            <Badge variant="secondary" className="text-xs">
                              Open source
                            </Badge>
                          )}
                        </div>
                        {row.detail && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {row.detail}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {row.vendor}
                      </td>
                      <td className="px-4 py-3">
                        <a
                          href={row.docsUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                        >
                          {row.via}
                          <ArrowUpRight className="size-3.5 shrink-0" />
                        </a>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs tabular-nums sm:text-sm">
                        {row.price}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>

      <p className="mt-10 text-center text-xs text-muted-foreground">
        Indicative rates from platform APIs ({lastUpdated}). Actual charges
        follow billed units. Via links open that platform&rsquo;s full pricing.
      </p>

      <div className="mt-12 flex flex-col items-center gap-4 rounded-2xl border bg-muted/30 px-6 py-10 text-center">
        <h2 className="text-xl font-semibold">Ready when you are</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Top up the wallet, or connect provider keys in Settings to pay
          platforms directly. No subscriptions.
        </p>
        <Button size="lg" onClick={onAddCredits}>
          Add credits
        </Button>
      </div>
    </div>
  );
}
