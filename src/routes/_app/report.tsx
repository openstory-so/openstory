/**
 * Public content report / takedown channel (#1180).
 *
 * Reachable without an account. Linked from Terms, the sign-in legal line,
 * and the sitemap. The person whose likeness was misused does not have a
 * login here, so a report form behind auth would be a report form nobody
 * who needs it can use.
 */

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { submitContentReportFn } from '@/functions/content-reports';
import { CONTENT_REPORT_REASONS } from '@/lib/db/schema/compliance';
import { SITE_CONFIG } from '@/lib/marketing/constants';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

const title = `Report content — ${SITE_CONFIG.name}`;

export const Route = createFileRoute('/_app/report')({
  component: ReportPage,
  head: () => ({
    meta: [
      { title },
      { property: 'og:title', content: title },
      { property: 'og:url', content: `${SITE_CONFIG.url}/report` },
    ],
  }),
  staticData: { breadcrumb: { label: 'Report content', to: '/report' } },
});

/**
 * Reason labels. Plain language rather than the enum's wording — a complainant
 * should not have to work out which internal category their problem falls into,
 * and mislabelled reports slow triage more than a missing label would.
 */
const REASON_LABELS: Record<(typeof CONTENT_REPORT_REASONS)[number], string> = {
  csam: 'Child sexual abuse material',
  portrait_rights: 'Uses my likeness without permission',
  deepfake_impersonation: 'Impersonates a real person',
  copyright: 'Infringes my copyright or trademark',
  sexual_content: 'Non-consensual or explicit sexual content',
  violence_or_harm: 'Violent, harmful, or dangerous content',
  hate_or_harassment: 'Hate speech or harassment',
  illegal_or_regulated: 'Illegal or regulated content',
  misleading_content: 'Misleading or deceptive content',
  other: 'Something else',
};

const formSchema = z.object({
  reason: z.enum(CONTENT_REPORT_REASONS),
  targetId: z.string().trim().min(1, 'Tell us what to look at'),
  details: z.string().trim().max(5000).optional(),
  reporterEmail: z
    .union([z.string().trim().email(), z.literal('')])
    .optional()
    .transform((value) => (value ? value : undefined)),
});

function ReportPage() {
  const [reason, setReason] = useState<
    (typeof CONTENT_REPORT_REASONS)[number] | ''
  >('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reference, setReference] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (data: z.infer<typeof formSchema>) =>
      submitContentReportFn({
        data: {
          // Everything arrives as a URL, a trace id, or prose. The server
          // decides what it is; the form does not make the reporter classify it.
          targetType: 'external_url',
          targetId: data.targetId,
          reason: data.reason,
          details: data.details,
          reporterEmail: data.reporterEmail,
          traceId: data.targetId,
        },
      }),
    onSuccess: (result) => {
      setReference(result.reference);
      toast.success('Report received', {
        description: `Reference ${result.reference}`,
      });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Could not submit the report. Please email us instead.'
      );
    },
  });

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const raw = Object.fromEntries(new FormData(event.currentTarget));
    const parsed = formSchema.safeParse({ ...raw, reason });

    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === 'string' && !fieldErrors[key]) {
          fieldErrors[key] = issue.message;
        }
      }
      setErrors(fieldErrors);
      return;
    }
    setErrors({});
    mutation.mutate(parsed.data);
  };

  if (reference) {
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
        <h1 className="font-heading text-3xl font-bold tracking-tight">
          Report received
        </h1>
        <Card>
          <CardHeader>
            <CardTitle>Reference {reference}</CardTitle>
            <CardDescription>
              Keep this reference if you need to follow up.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 leading-relaxed">
            <p>
              We review reports of child sexual abuse material and
              non-consensual likeness immediately, and all other reports in the
              order received. Content found to breach our terms is removed and
              the account responsible is restricted.
            </p>
            <p className="text-sm text-muted-foreground">
              If your report is urgent and you have not heard from us, email{' '}
              <a
                className="underline"
                href={`mailto:${SITE_CONFIG.contactEmail}`}
              >
                {SITE_CONFIG.contactEmail}
              </a>{' '}
              quoting this reference.
            </p>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
      <div className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-bold tracking-tight">
          Report content
        </h1>
        <p className="leading-relaxed text-muted-foreground">
          Use this form to report content generated on {SITE_CONFIG.name} that
          uses someone’s likeness without permission, infringes your rights, or
          breaks our{' '}
          <a className="underline" href="/terms">
            terms
          </a>
          . You do not need an account.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor="reason">What is the problem?</Label>
          <Select
            value={reason}
            items={CONTENT_REPORT_REASONS.map((value) => ({
              value,
              label: REASON_LABELS[value],
            }))}
            onValueChange={(value) => {
              // Narrow by lookup rather than asserting: the Select hands back a
              // plain string, and a value that is not one of our reasons should
              // be ignored, not coerced into one.
              const match = CONTENT_REPORT_REASONS.find(
                (candidate) => candidate === value
              );
              if (match) setReason(match);
            }}
          >
            <SelectTrigger id="reason">
              <SelectValue placeholder="Choose a reason…" />
            </SelectTrigger>
            <SelectContent>
              {CONTENT_REPORT_REASONS.map((value) => (
                <SelectItem key={value} value={value}>
                  {REASON_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.reason ? (
            <p className="text-sm text-destructive">Choose a reason</p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="targetId">Link or reference</Label>
          <Input
            id="targetId"
            name="targetId"
            placeholder="https://… or OS-01J…"
            autoComplete="off"
            required
          />
          <p className="text-sm text-muted-foreground">
            Paste the video or image URL, or the <code>OS-…</code> reference if
            we gave you one. This is how we trace the content back to the
            account that generated it.
          </p>
          {errors.targetId ? (
            <p className="text-sm text-destructive">{errors.targetId}</p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="details">Details</Label>
          <Textarea
            id="details"
            name="details"
            rows={5}
            placeholder="Tell us what is wrong, and if this is about your likeness or your work, how we can tell it is yours."
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="reporterEmail">Your email (optional)</Label>
          <Input
            id="reporterEmail"
            name="reporterEmail"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
          />
          <p className="text-sm text-muted-foreground">
            Only used to follow up on this report. Leave blank to report
            anonymously.
          </p>
          {errors.reporterEmail ? (
            <p className="text-sm text-destructive">
              Enter a valid email, or leave it blank
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Submitting…' : 'Submit report'}
          </Button>
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {mutation.isPending && <span>Sending your report…</span>}
          </p>
        </div>
      </form>
    </main>
  );
}
