import type { ChangeRecord, StatusIssue, StatusResult } from './types.js';

export type StatusPresentation = {
  output: string;
  issues: string;
};
export type StatusPresentationOptions = {
  color?: boolean;
};

const ANSI = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  open: '\u001B[33m',
  verified: '\u001B[32m',
  issue: '\u001B[31m'
} as const;
const divider = '──────────';
const progressWidth = 10;

function paint(text: string, color: string, enabled: boolean): string {
  return enabled ? `${color}${text}${ANSI.reset}` : text;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

function formatUpdated(updated: string): string {
  const date = new Date(updated);
  if (Number.isNaN(date.getTime())) return updated;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute} UTC`;
}

function progress(record: ChangeRecord, color: boolean): string {
  const { completed, total, invalid } = record.tasks;
  if (!total) return '— no task breakdown';
  const filled = Math.max(
    0,
    Math.min(progressWidth, Math.round((completed / total) * progressWidth))
  );
  const bar = `[${'█'.repeat(filled)}${'░'.repeat(progressWidth - filled)}]`;
  const stateColor = record.state === 'verified' ? ANSI.verified : ANSI.open;
  const invalidText = invalid ? ` · ${invalid} invalid ${plural(invalid, 'task')}` : '';
  return `${paint(bar, stateColor, color)} ${completed} / ${total} ${plural(total, 'task')} complete${invalidText}`;
}

function recordBlock(record: ChangeRecord, color: boolean): string {
  const state = record.state.toUpperCase();
  const stateColor = record.state === 'verified' ? ANSI.verified : ANSI.open;
  return [
    `${paint(state, stateColor, color)}  ${paint(record.title, ANSI.bold, color)}`,
    `      ${record.id}`,
    `      Progress  ${progress(record, color)}`,
    `      Updated   ${formatUpdated(record.updated)}`,
    `      Next      ${record.next}`
  ].join('\n');
}

function summary(records: ChangeRecord[]): string {
  const open = records.filter((record) => record.state === 'open').length;
  const verified = records.length - open;
  const counts = [
    `${records.length} ${plural(records.length, 'change')}`,
    ...(open ? [`${open} open`] : []),
    ...(verified ? [`${verified} verified`] : [])
  ];
  return counts.join(' · ');
}

function archiveSummary(result: StatusResult): string {
  return `Archived  ${result.archive.changes} ${plural(result.archive.changes, 'change')} resolved · ${result.archive.tasks} ${plural(result.archive.tasks, 'task')} completed`;
}

export function formatStatusIssues(
  issues: StatusIssue[],
  options: StatusPresentationOptions = {}
): string {
  if (!issues.length) return '';
  const color = Boolean(options.color);
  const heading = paint('GDD issues', ANSI.issue, color);
  const count = `${issues.length} invalid ${plural(issues.length, 'record')}`;
  const details = issues
    .map((issue) => `${paint('!', ANSI.issue, color)} ${issue.path}\n  ${issue.error}`)
    .join('\n\n');
  return `${heading}\n${divider}\n${count}\n\n${details}`;
}

export function formatStatus(
  result: StatusResult,
  options: StatusPresentationOptions = {}
): StatusPresentation {
  const color = Boolean(options.color);
  const heading = paint('GDD status', ANSI.bold, color);
  const content = result.records.length
    ? result.records.map((record) => recordBlock(record, color)).join('\n\n')
    : 'No GDD changes found.';
  return {
    output: `${heading}\n${divider}\n${summary(result.records)}\n${archiveSummary(result)}\n\n${content}`,
    issues: formatStatusIssues(result.invalid, options)
  };
}

export function shouldUseStatusColor(
  isTTY: boolean | undefined,
  noColor: string | undefined
): boolean {
  return Boolean(isTTY && noColor === undefined);
}
