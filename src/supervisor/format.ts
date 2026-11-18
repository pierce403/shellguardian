// Formatting and labels shared by the Supervisor views.
import type { ChatStep, Stamp } from '../types';

/** Converts a Hermes timestamp (epoch seconds, epoch milliseconds, or ISO text) to a Date. */
export function toDate(value: Stamp | null): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  const date = Number.isNaN(numeric)
    ? new Date(String(value))
    : new Date(numeric < 1e12 ? numeric * 1000 : numeric);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A date and time, or "Unavailable" (never a zero or an invented value). */
export function formatStamp(value: Stamp | null): string {
  const date = toDate(value);
  if (!date) return 'Unavailable';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatClock(value: Stamp | null): string {
  const date = toDate(value);
  if (!date) return '';
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** How long ago something happened: "just now", "5m ago", "3h ago", "2d ago", then a date. */
export function formatAgo(value: Stamp | null): string {
  const date = toDate(value);
  if (!date) return '';
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** A compact duration such as "45s", "3m 05s" or "1h 02m". */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const two = (n: number) => String(n).padStart(2, '0');
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${two(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${two(Math.floor((seconds % 3600) / 60))}m`;
}

/** Time since `from` (until `to`, or now), or an empty string when unknown. */
export function elapsed(from: Stamp | null, to?: Stamp | null): string {
  const start = toDate(from);
  if (!start) return '';
  const end = (to !== undefined ? toDate(to) : null) ?? new Date();
  return formatDuration(end.getTime() - start.getTime());
}

/** 950 stays "950"; 18250 becomes "18.3k"; 1468092 becomes "1.47M". */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return 'Unavailable';
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/** When a usage window resets: "in 3h 20m" within a day, otherwise the day and time. */
export function formatResets(value: string | undefined): string | null {
  const date = toDate(value);
  if (!date) return null;
  const ahead = date.getTime() - Date.now();
  if (ahead <= 0) return 'resets soon';
  if (ahead < 24 * 3600 * 1000) {
    const minutes = Math.floor(ahead / 60000);
    return minutes < 60
      ? `resets in ${Math.max(1, minutes)}m`
      : `resets in ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
  }
  return `resets ${date.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

export type Tone = 'good' | 'muted' | 'attention' | 'info' | 'danger';

/** Kanban statuses in board order, with their display label and tone. */
export const STATUSES: { key: string; label: string; tone: Tone; hint: string }[] = [
  { key: 'triage', label: 'Triage', tone: 'muted', hint: 'Needs a clearer brief' },
  { key: 'todo', label: 'To do', tone: 'muted', hint: 'Waiting on other tasks or an assignee' },
  { key: 'scheduled', label: 'Scheduled', tone: 'info', hint: 'Starts later' },
  { key: 'ready', label: 'Ready', tone: 'info', hint: 'Queued for its agent' },
  { key: 'running', label: 'Running', tone: 'good', hint: 'An agent is working on it' },
  { key: 'blocked', label: 'Blocked', tone: 'attention', hint: 'Needs your attention' },
  { key: 'review', label: 'In review', tone: 'info', hint: 'Waiting for a review' },
  { key: 'done', label: 'Done', tone: 'good', hint: 'Finished' },
  { key: 'archived', label: 'Archived', tone: 'muted', hint: 'Hidden from the board' },
];
export function statusMeta(status: string | undefined) {
  return (
    STATUSES.find((entry) => entry.key === status) ?? {
      key: status ?? 'unknown',
      label: humanize(status ?? 'Unknown'),
      tone: 'muted' as Tone,
      hint: '',
    }
  );
}

/** "worker_bound" becomes "Worker bound". */
export function humanize(text: string): string {
  const spaced = text.replace(/[_-]+/g, ' ').trim();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : text;
}

// Timeline events worth a line. `null` hides housekeeping events.
const EVENT_LABELS: Record<string, string | null> = {
  created: 'Created',
  promoted: 'Ready to start',
  claimed: 'Picked up',
  spawned: 'Worker started',
  owner_admitted: 'Session opened',
  worker_bound: null,
  claim_extended: null,
  tip_scratch_workspace: null,
  heartbeat: 'Progress',
  commented: 'Comment added',
  linked: 'Linked to another task',
  decomposed: 'Split into smaller tasks',
  review_requested: 'Review requested',
  completed: 'Completed',
  worker_result: null,
  blocked: 'Blocked',
  gave_up: 'Gave up',
  timed_out: 'Timed out',
  crashed: 'Worker crashed',
  worker_lost: 'Worker lost',
  reclaimed: 'Returned to the queue',
  stale: 'Stalled',
  archived: 'Archived',
};
/** The label for a timeline event, or null when the event is housekeeping. */
export function eventLabel(kind: string | undefined): string | null {
  if (!kind) return null;
  return kind in EVENT_LABELS ? EVENT_LABELS[kind] : humanize(kind);
}
export function eventTone(kind: string | undefined): Tone {
  if (kind === 'completed') return 'good';
  if (kind && ['blocked', 'gave_up', 'timed_out', 'crashed', 'worker_lost', 'stale'].includes(kind))
    return 'attention';
  return 'muted';
}

const STEP_LABELS: Record<string, string> = {
  kanban_create: 'Creating a task',
  kanban_show: 'Reading a task',
  kanban_list: 'Reading the board',
  kanban_complete: 'Completing a task',
  kanban_block: 'Blocking a task',
  kanban_unblock: 'Unblocking a task',
  kanban_comment: 'Commenting on a task',
  kanban_link: 'Linking tasks',
  kanban_heartbeat: 'Reporting progress',
  skill_view: 'Reading a skill',
  skill_manage: 'Updating a skill',
  terminal: 'Running a command',
  read_file: 'Reading a file',
  write_file: 'Writing a file',
  patch: 'Editing a file',
  search_files: 'Searching files',
  web_search: 'Searching the web',
  web_extract: 'Reading a web page',
  memory: 'Updating memory',
  todo: 'Planning',
  delegate_task: 'Delegating',
  session_search: 'Searching past sessions',
  clarify: 'Asking a question',
};
/** A plain-language line for one tool call, for example "Creating a task: Check logs". */
export function stepLabel(step: ChatStep): string {
  const label = STEP_LABELS[step.name] ?? `Using ${step.name.replace(/_/g, ' ')}`;
  return step.detail ? `${label}: ${step.detail}` : label;
}

export const SESSION_KINDS: Record<string, { label: string; tone: Tone }> = {
  chat: { label: 'Chat', tone: 'info' },
  task: { label: 'Task run', tone: 'good' },
  conversation: { label: 'Conversation', tone: 'muted' },
};
