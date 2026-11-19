// Small presentational pieces shared by the Supervisor views.
import { useState, type ReactNode, type SelectHTMLAttributes } from 'react';
import {
  Check,
  ChevronDown,
  CircleAlert,
  LoaderCircle,
  Play,
  RefreshCw,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import * as api from '../api';
import type { ChatStep, HermesProviderOption, HermesTranscriptRow } from '../types';
import { formatClock, formatDuration, formatResets, statusMeta, stepLabel } from './format';
import { Markdown } from './markdown';

/**
 * A select box drawn by the page, so it looks the same in every engine.
 * (The desktop app's WebKit otherwise shows the system's own grey control.)
 */
export function Select({
  className = '',
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={`sv-select ${className}`.trim()}>
      <select {...props}>{children}</select>
      <ChevronDown size={14} aria-hidden="true" />
    </span>
  );
}

/** A kanban status as a pill with a dot. */
export function TaskStatus({ status }: { status: string | undefined }) {
  const meta = statusMeta(status);
  return (
    <span className={`status ${meta.tone}`} title={meta.hint || undefined}>
      <span className="status-dot" />
      {meta.label}
    </span>
  );
}

export function RefreshButton({
  loading,
  onClick,
  label = 'Refresh',
}: {
  loading: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <button className="button compact" disabled={loading} onClick={onClick}>
      {loading ? (
        <LoaderCircle size={14} className="spin" aria-hidden="true" />
      ) : (
        <RefreshCw size={14} aria-hidden="true" />
      )}
      {label}
    </button>
  );
}

/** A quiet placeholder for a view or list with nothing in it yet. */
export function Empty({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="sv-empty">
      <span className="sv-empty-icon">
        <Icon size={20} aria-hidden="true" />
      </span>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

/**
 * Explains that an agent's Hermes gateway is not running and offers to start
 * it. Starting is always an explicit click.
 */
export function GatewayNotice({
  profile,
  children,
  onStarted,
}: {
  profile: string;
  children?: ReactNode;
  onStarted: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    setStarting(true);
    setError(null);
    try {
      const status = await api.startHermesGateway(profile);
      if (status.state !== 'ready') setError(status.message ?? `The gateway is ${status.state}.`);
      onStarted();
    } catch (e) {
      setError(api.errorMessage(e));
    } finally {
      setStarting(false);
    }
  }
  return (
    <div className="sv-notice" role="status">
      <CircleAlert size={18} aria-hidden="true" />
      <div>
        <p>
          {children ?? (
            <>
              This needs {profile}'s Hermes gateway, which is not running. Starting it runs Hermes
              in the background. It also connects any messaging platforms and runs assigned tasks
              and schedules for {profile}.
            </>
          )}
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <button className="button primary" disabled={starting} onClick={() => void start()}>
        {starting ? (
          <LoaderCircle size={15} className="spin" aria-hidden="true" />
        ) : (
          <Play size={15} aria-hidden="true" />
        )}
        Start {profile}'s gateway
      </button>
    </div>
  );
}

/** The tool calls an agent made in one turn. `live` marks the last open one as running. */
export function StepList({ steps, live = false }: { steps: ChatStep[]; live?: boolean }) {
  if (steps.length === 0) return null;
  return (
    <ol className="sv-steps" aria-label="What the agent did">
      {steps.map((step, index) => {
        const running = live && !step.done;
        return (
          <li
            key={index}
            className={step.failed ? 'failed' : running ? 'running' : step.done ? 'done' : ''}
          >
            {running ? (
              <LoaderCircle size={13} className="spin" aria-hidden="true" />
            ) : step.failed ? (
              <CircleAlert size={13} aria-hidden="true" />
            ) : step.done ? (
              <Check size={13} aria-hidden="true" />
            ) : (
              <Wrench size={13} aria-hidden="true" />
            )}
            <span>{stepLabel(step)}</span>
            {step.failed && <small>did not succeed</small>}
            {step.durationMs !== null && step.durationMs >= 1000 && !step.failed && (
              <small>{formatDuration(step.durationMs)}</small>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Usage windows reported by signed-in subscription providers. */
export function UsageMeters({ providers }: { providers: HermesProviderOption[] }) {
  const reporting = providers.filter((provider) => (provider.usage ?? []).length > 0);
  if (reporting.length === 0)
    return (
      <p className="muted-copy">
        None of this agent's signed-in providers report usage limits. Usage is unavailable.
      </p>
    );
  return (
    <div className="sv-usage">
      {reporting.map((provider) => (
        <div key={provider.slug} className="sv-usage-provider">
          <strong>{provider.name ?? provider.slug}</strong>
          {(provider.usage ?? []).map((window, index) => {
            const used = typeof window.used_percent === 'number' ? window.used_percent : null;
            const clamped = used === null ? 0 : Math.min(100, Math.max(0, used));
            const tone = used === null ? '' : used >= 90 ? 'danger' : used >= 70 ? 'attention' : '';
            const label = window.label ?? 'Usage';
            return (
              <div key={index} className="sv-meter">
                <div className="sv-meter-label">
                  <span>{label}</span>
                  <span>{used === null ? 'Unavailable' : `${Math.round(used)}% used`}</span>
                </div>
                <div
                  className={`sv-meter-track ${tone}`}
                  role="meter"
                  aria-label={`${provider.name ?? provider.slug} ${label}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={used === null ? undefined : Math.round(clamped)}
                  aria-valuetext={used === null ? 'Unavailable' : `${Math.round(used)}% used`}
                >
                  <span style={{ width: `${clamped}%` }} />
                </div>
                {formatResets(window.resets_at) && <small>{formatResets(window.resets_at)}</small>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** A read-only Hermes session transcript. */
export function TranscriptRows({ rows, agent }: { rows: HermesTranscriptRow[]; agent: string }) {
  if (rows.length === 0) return <p className="muted-copy">No messages in this session yet.</p>;
  return (
    <div className="sv-transcript-rows">
      {rows.map((row, index) => {
        const time = row.timestamp !== undefined ? formatClock(row.timestamp) : '';
        if (row.role === 'tool')
          return (
            <div key={index} className="sv-row-tool">
              <Wrench size={12} aria-hidden="true" />
              <span>
                {stepLabel({
                  name: row.name ?? 'tool',
                  detail: null,
                  done: true,
                  failed: false,
                  durationMs: null,
                })}
              </span>
              {time && <small>{time}</small>}
            </div>
          );
        const mine = row.role === 'user';
        const summary = row.row_kind === 'compaction';
        if (!row.text?.trim() && !summary) return null;
        return (
          <div key={index} className={`sv-msg ${mine ? 'user' : 'agent'}`}>
            <span className="sv-msg-who">
              {summary ? 'Earlier messages, summarized' : mine ? 'Request' : agent}
              {time && <small>{time}</small>}
            </span>
            <Markdown text={row.text ?? ''} />
          </div>
        );
      })}
    </div>
  );
}
