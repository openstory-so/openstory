/**
 * Admin moderation console (#1180).
 *
 * Three jobs, one page, because they are one workflow: a report arrives, you
 * trace the content to an account, you act. Splitting them across routes would
 * mean copying ids between tabs during the one task where mistakes are
 * expensive.
 *
 * Auth is inherited from `/admin/route.tsx` (ADMIN_EMAILS gate).
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  applyEnforcementFn,
  attributeContentReportFn,
  listContentReportsFn,
  resolveContentReportFn,
  traceContentFn,
} from '@/functions/moderation';
import { formatReportReference } from '@/lib/compliance/provenance';
import {
  CONTENT_REPORT_REASONS,
  type ContentReportReason,
} from '@/lib/db/schema/compliance';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Search, ShieldAlert } from 'lucide-react';
import { Suspense, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

const TAB_VALUES = ['reports', 'trace'] as const;

const searchSchema = z.object({
  tab: z.enum(TAB_VALUES).optional().default('reports'),
  q: z.string().optional(),
  reportId: z.string().optional(),
  reason: z.enum(CONTENT_REPORT_REASONS).optional(),
});

export const Route = createFileRoute('/_app/admin/moderation')({
  validateSearch: searchSchema,
  component: ModerationPage,
  staticData: { breadcrumb: 'Moderation' },
});

function ModerationPage() {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-auto">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-bold tracking-tight">
          Moderation
        </h1>
        <p className="text-sm text-muted-foreground">
          Triage reports, trace generated content to the account that produced
          it, and record enforcement.
        </p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => {
          const match = TAB_VALUES.find((candidate) => candidate === value);
          if (match) void navigate({ search: { tab: match } });
        }}
      >
        <TabsList>
          <TabsTrigger value="reports">Reports</TabsTrigger>
          <TabsTrigger value="trace">Trace content</TabsTrigger>
        </TabsList>
      </Tabs>

      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        {tab === 'reports' ? <ReportsTab /> : null}
        {tab === 'trace' ? <TraceTab /> : null}
      </Suspense>
    </div>
  );
}

// ============================================================================
// Reports
// ============================================================================

const ReportsTab: React.FC = () => {
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState<Record<string, string>>({});

  const { data } = useQuery({
    queryKey: ['moderation-reports'],
    queryFn: () =>
      listContentReportsFn({ data: { statuses: ['open', 'triaged'] } }),
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['moderation-reports'] });

  const resolveMutation = useMutation({
    mutationFn: (input: {
      reportId: string;
      status: 'triaged' | 'actioned' | 'dismissed';
      resolutionNotes?: string;
    }) => resolveContentReportFn({ data: input }),
    onSuccess: () => {
      invalidate();
      toast.success('Report updated');
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Update failed'),
  });

  const enforceMutation = useMutation({
    mutationFn: (input: {
      reportId: string;
      subjectUserId?: string;
      subjectTeamId?: string;
      reason: ContentReportReason;
      action: 'generation_suspended' | 'account_suspended' | 'content_removed';
      notes?: string;
    }) => applyEnforcementFn({ data: input }),
    onSuccess: () => {
      invalidate();
      toast.success('Enforcement recorded');
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Enforcement failed'
      ),
  });

  const reports = data?.reports ?? [];
  const counts = data?.counts;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard label="Open" value={counts?.open ?? 0} emphasize />
        <SummaryCard label="Triaged" value={counts?.triaged ?? 0} />
        <SummaryCard label="Actioned" value={counts?.actioned ?? 0} />
        <SummaryCard label="Dismissed" value={counts?.dismissed ?? 0} />
      </div>

      {reports.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No open reports.
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {reports.map((report) => (
            <Card key={report.id}>
              <CardContent className="flex flex-col gap-4 py-6">
                <div className="flex flex-wrap items-center gap-3">
                  {/* priority 0 is reserved for CSAM, forced at intake. */}
                  {report.priority === 0 ? (
                    <Badge variant="destructive" className="gap-1">
                      <ShieldAlert className="size-3" aria-hidden />
                      Urgent
                    </Badge>
                  ) : null}
                  <Badge variant="secondary">
                    {report.reason.replace(/_/g, ' ')}
                  </Badge>
                  <span className="text-sm text-muted-foreground">
                    {report.targetType} ·{' '}
                    {new Date(report.createdAt).toLocaleString()}
                  </span>
                  <code className="ml-auto text-xs text-muted-foreground">
                    {formatReportReference(report.id)}
                  </code>
                </div>

                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <Field label="Target">
                    <span className="break-all">{report.targetId}</span>
                  </Field>
                  <Field label="Reporter">
                    {report.reporterUserEmail ??
                      report.reporterEmail ??
                      'Anonymous'}
                  </Field>
                  <Field label="Owner">
                    {report.subjectUserEmail ??
                      report.subjectTeamName ??
                      'Not yet attributed'}
                  </Field>
                  <Field label="Trace">{report.traceId ?? '—'}</Field>
                </dl>

                {report.details ? (
                  <p className="rounded-md bg-muted/50 p-3 text-sm leading-relaxed">
                    {report.details}
                  </p>
                ) : null}

                <Textarea
                  rows={2}
                  placeholder="Resolution notes (recorded on the report)"
                  value={notes[report.id] ?? ''}
                  onChange={(event) =>
                    setNotes((prev) => ({
                      ...prev,
                      [report.id]: event.target.value,
                    }))
                  }
                />

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void navigate({
                        search: {
                          tab: 'trace',
                          q: report.targetId,
                          reportId: report.id,
                          reason: report.reason,
                        },
                      })
                    }
                  >
                    Trace target
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={resolveMutation.isPending}
                    onClick={() =>
                      resolveMutation.mutate({
                        reportId: report.id,
                        status: 'triaged',
                        resolutionNotes: notes[report.id],
                      })
                    }
                  >
                    Mark triaged
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={
                      enforceMutation.isPending ||
                      (!report.subjectUserId && !report.subjectTeamId)
                    }
                    onClick={() =>
                      enforceMutation.mutate({
                        reportId: report.id,
                        subjectUserId: report.subjectUserId ?? undefined,
                        subjectTeamId: report.subjectTeamId ?? undefined,
                        reason: report.reason,
                        action: 'generation_suspended',
                        notes: notes[report.id],
                      })
                    }
                    title={
                      report.subjectUserId || report.subjectTeamId
                        ? 'Pause new generations on the reported account'
                        : 'Attribute the report to an account first — use Trace content'
                    }
                  >
                    Pause generation
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={
                      enforceMutation.isPending ||
                      (!report.subjectUserId && !report.subjectTeamId)
                    }
                    onClick={() =>
                      enforceMutation.mutate({
                        reportId: report.id,
                        subjectUserId: report.subjectUserId ?? undefined,
                        subjectTeamId: report.subjectTeamId ?? undefined,
                        reason: report.reason,
                        action: 'account_suspended',
                        notes: notes[report.id],
                      })
                    }
                  >
                    Suspend account
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={resolveMutation.isPending}
                    onClick={() =>
                      resolveMutation.mutate({
                        reportId: report.id,
                        status: 'dismissed',
                        resolutionNotes: notes[report.id],
                      })
                    }
                  >
                    Dismiss
                  </Button>
                  <Button
                    size="sm"
                    disabled={resolveMutation.isPending}
                    onClick={() =>
                      resolveMutation.mutate({
                        reportId: report.id,
                        status: 'actioned',
                        resolutionNotes: notes[report.id],
                      })
                    }
                  >
                    Close as actioned
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Trace
// ============================================================================

const TraceTab: React.FC = () => {
  const { q, reportId, reason } = Route.useSearch();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState(q ?? '');
  const [submitted, setSubmitted] = useState(
    q && q.trim().length >= 3 ? q.trim() : ''
  );

  const { data, isFetching } = useQuery({
    queryKey: ['moderation-trace', submitted],
    queryFn: () => traceContentFn({ data: { query: submitted } }),
    enabled: submitted.length >= 3,
  });

  const attributeMutation = useMutation({
    mutationFn: (input: {
      reportId: string;
      subjectTeamId?: string;
      subjectUserId?: string;
    }) => attributeContentReportFn({ data: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['moderation-reports'] });
      toast.success('Report attributed to this account');
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Attribution failed'
      ),
  });

  const enforceMutation = useMutation({
    mutationFn: (input: {
      subjectUserId?: string;
      subjectTeamId?: string;
      reason: ContentReportReason;
      action: 'generation_suspended' | 'account_suspended';
      reportId?: string;
    }) => applyEnforcementFn({ data: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['moderation-reports'] });
      toast.success('Enforcement recorded');
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Enforcement failed'
      ),
  });

  const results = data?.results ?? [];
  const enforcementReason: ContentReportReason = reason ?? 'other';

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(query.trim());
        }}
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="OS-01J… · videos/teams/…/shot.mp4 · https://… · sha256 · fal request id"
          autoComplete="off"
        />
        <Button type="submit" disabled={query.trim().length < 3}>
          <Search className="size-4" aria-hidden />
          Trace
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        Paste anything a complainant sent: our own reference, the asset URL or
        R2 key, a SHA-256 of the file, or the provider’s request id.
      </p>

      {isFetching ? <Skeleton className="h-32 w-full" /> : null}

      {submitted && !isFetching && results.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No provenance record matched. Uploaded reference photos and assets
            generated before provenance recording shipped will not resolve here
            — check the sequence or the account’s attestations.
          </CardContent>
        </Card>
      ) : null}

      {results.map((row) => (
        <Card key={row.id}>
          <CardContent className="flex flex-col gap-3 py-6">
            <div className="flex flex-wrap items-center gap-3">
              <Badge>{row.assetKind.replace(/_/g, ' ')}</Badge>
              <code className="text-xs text-muted-foreground">
                {row.traceId}
              </code>
              <span className="ml-auto text-sm text-muted-foreground">
                {new Date(row.createdAt).toLocaleString()}
              </span>
            </div>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <Field label="Account">
                {row.userEmail ?? row.userName ?? row.userId ?? 'Unknown user'}
              </Field>
              <Field label="Team">{row.teamName ?? row.teamId}</Field>
              <Field label="Model">
                {row.provider} · {row.model}
              </Field>
              <Field label="Provider request">
                {row.providerRequestId ?? '—'}
              </Field>
              <Field label="Storage key">
                <span className="break-all">{row.storageKey ?? '—'}</span>
              </Field>
              <Field label="Content SHA-256">
                <span className="break-all">{row.contentSha256 ?? '—'}</span>
              </Field>
              <Field label="Reference images">
                {row.usedReferenceImages
                  ? `Yes (${row.referenceImageCount})`
                  : 'No'}
              </Field>
              <Field label="Sequence">{row.sequenceId ?? '—'}</Field>
            </dl>
            <p className="text-xs text-muted-foreground">
              Prompt hash {row.promptSha256 ?? '—'} · workflow{' '}
              {row.workflowRunId ?? '—'}
            </p>
            <div className="flex flex-wrap gap-2">
              {reportId ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    attributeMutation.isPending || (!row.userId && !row.teamId)
                  }
                  onClick={() =>
                    attributeMutation.mutate({
                      reportId,
                      subjectUserId: row.userId ?? undefined,
                      subjectTeamId: row.teamId,
                    })
                  }
                >
                  Attribute to this account
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="destructive"
                disabled={
                  enforceMutation.isPending || (!row.userId && !row.teamId)
                }
                onClick={() =>
                  enforceMutation.mutate({
                    subjectUserId: row.userId ?? undefined,
                    subjectTeamId: row.teamId,
                    reason: enforcementReason,
                    action: 'generation_suspended',
                    reportId,
                  })
                }
              >
                Pause generation
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={
                  enforceMutation.isPending || (!row.userId && !row.teamId)
                }
                onClick={() =>
                  enforceMutation.mutate({
                    subjectUserId: row.userId ?? undefined,
                    subjectTeamId: row.teamId,
                    reason: enforcementReason,
                    action: 'account_suspended',
                    reportId,
                  })
                }
              >
                Suspend account
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
};

// ============================================================================
// Bits
// ============================================================================

const SummaryCard: React.FC<{
  label: string;
  value: number;
  emphasize?: boolean;
}> = ({ label, value, emphasize }) => (
  <Card>
    <CardContent className="flex flex-col gap-1 py-4">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={
          emphasize && value > 0
            ? 'text-2xl font-semibold tabular-nums text-destructive'
            : 'text-2xl font-semibold tabular-nums'
        }
      >
        {value}
      </span>
    </CardContent>
  </Card>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div className="flex flex-col">
    <dt className="text-xs uppercase tracking-wide text-muted-foreground">
      {label}
    </dt>
    <dd>{children}</dd>
  </div>
);
