/**
 * Public reference for a content report, e.g. `OR-01JAV…`. The bare ULID is
 * what the DB stores; the prefixed form is what goes in an email or the
 * moderation queue, because an unlabelled 26-character string is
 * indistinguishable from every other id. Sibling of `formatTraceId` in
 * `@/lib/compliance/provenance`.
 */
const REPORT_PREFIX = 'OR';

export function formatReportReference(reportId: string): string {
  return `${REPORT_PREFIX}-${reportId}`;
}
