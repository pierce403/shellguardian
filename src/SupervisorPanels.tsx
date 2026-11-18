import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Activity,
  KeyRound,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Send,
  TerminalSquare,
} from 'lucide-react';
import * as api from './api';
import type {
  HermesProfile,
  HermesModelOptions,
  HermesSchedule,
  HermesSession,
  HermesTranscriptRow,
  KanbanBoard,
  KanbanTask,
  KanbanTaskDetail,
  Stamp,
} from './types';

const NOT_RUNNING = 'not running';
const POLL_MS = 3000;

/** Runs `tick` on an interval while the page is visible. */
function usePoll(tick: () => void, ms: number) {
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') latest.current();
    }, ms);
    return () => window.clearInterval(timer);
  }, [ms]);
}

function elapsed(from: Stamp): string {
  const start = typeof from === 'number' ? from : Number(from);
  if (!from || Number.isNaN(start)) return '';
  const seconds = Math.max(
    0,
    Math.floor(Date.now() / 1000 - (start > 1e12 ? start / 1000 : start)),
  );
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function TranscriptRows({ rows }: { rows: HermesTranscriptRow[] }) {
  return (
    <>
      {rows.length === 0 && <p className="muted-copy">No messages yet.</p>}
      {rows.map((r, i) => (
        <div key={i} className={`supervisor-message ${r.role === 'user' ? 'user' : 'supervisor'}`}>
          <span className="supervisor-role">
            {r.row_kind === 'compaction'
              ? 'Summary'
              : r.role === 'tool'
                ? `Tool${r.name ? ` · ${r.name}` : ''}`
                : r.role === 'user'
                  ? 'You'
                  : (r.role ?? 'Hermes')}
            {r.timestamp !== undefined ? ` · ${formatStamp(r.timestamp)}` : ''}
          </span>
          <p>{r.text}</p>
        </div>
      ))}
    </>
  );
}

function formatStamp(value: Stamp): string {
  if (value === undefined || value === '') return 'Unavailable';
  const date =
    typeof value === 'number'
      ? new Date(value < 1e12 ? value * 1000 : value)
      : new Date(Number.isNaN(Number(value)) ? value : Number(value) * 1000);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

/** Loads gateway data for a profile and tracks loading/error state. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // A silent reload (used by polling) shows no spinner and keeps the last data on failure.
  const reload = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setData(await load());
      setError(null);
    } catch (e) {
      if (!silent) setData(null);
      setError(api.errorMessage(e));
    } finally {
      if (!silent) setLoading(false);
    }
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}

function RefreshButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <button className="button compact" disabled={loading} onClick={onClick}>
      {loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
      Refresh
    </button>
  );
}

/** Shown when a panel needs the profile's gateway and it is not running. */
function GatewayError({
  profile,
  error,
  onStarted,
}: {
  profile: string;
  error: string;
  onStarted: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  if (!error.includes(NOT_RUNNING))
    return (
      <p className="form-error" role="alert">
        {error}
      </p>
    );
  async function start() {
    setStarting(true);
    setStartError(null);
    try {
      const status = await api.startHermesGateway(profile);
      if (status.state !== 'ready')
        setStartError(status.message ?? `The gateway is ${status.state}.`);
      onStarted();
    } catch (e) {
      setStartError(api.errorMessage(e));
    } finally {
      setStarting(false);
    }
  }
  return (
    <div className="supervisor-notice" role="status">
      <p>
        This needs {profile}'s Hermes gateway, which is not running. Starting it runs Hermes in the
        background, as Hermes's own apps do. It also connects any messaging platforms and runs
        assigned kanban tasks and schedules for this agent.
      </p>
      <button className="button primary" disabled={starting} onClick={() => void start()}>
        {starting ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}
        Start gateway
      </button>
      {startError && (
        <p className="form-error" role="alert">
          {startError}
        </p>
      )}
    </div>
  );
}

// ---- Provider and model ----

export function ProviderPanel({
  profile,
  onChanged,
  onSignIn,
}: {
  profile: string;
  onChanged: () => void;
  onSignIn: (profile: string) => void;
}) {
  const options = useLoad<HermesModelOptions>(() => api.hermesModelOptions(profile), [profile]);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  useEffect(() => {
    if (!options.data) return;
    setProvider((current) => current || options.data?.provider || '');
    setModel((current) => current || options.data?.model || '');
  }, [options.data]);

  const providers = options.data?.providers ?? [];
  const chosen = providers.find((p) => p.slug === provider);
  const needsKey = chosen && !chosen.authenticated && chosen.auth_type === 'api_key';
  const needsSignIn = chosen && !chosen.authenticated && chosen.auth_type !== 'api_key';

  async function apply(confirmed: boolean) {
    if (!provider || !model.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.setHermesModel(profile, provider, model.trim(), confirmed);
      if (result.confirm_required) {
        setConfirm(result.confirm_message ?? 'Hermes asks you to confirm this model.');
      } else {
        setConfirm(null);
        setMessage(`${profile} now uses ${model.trim()} via ${provider}.`);
        onChanged();
        void options.reload();
      }
    } catch (e) {
      setError(api.errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveKey(event: FormEvent) {
    event.preventDefault();
    if (!provider || !key.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.saveHermesKey(profile, provider, key);
      setMessage(`Hermes saved the key for ${chosen?.name ?? provider}.`);
      void options.reload();
    } catch (e) {
      setError(api.errorMessage(e));
    } finally {
      setKey('');
      setBusy(false);
    }
  }

  return (
    <section className="settings-card" aria-label={`Provider for ${profile}`}>
      <div className="section-label">
        <KeyRound size={20} />
        <h3>Provider and model for {profile}</h3>
        <RefreshButton loading={options.loading} onClick={() => void options.reload()} />
      </div>
      {options.error && (
        <GatewayError
          profile={profile}
          error={options.error}
          onStarted={() => {
            onChanged();
            void options.reload();
          }}
        />
      )}
      {options.data && (
        <>
          <p className="muted-copy">
            Currently {options.data.model ?? 'no model'} via{' '}
            {options.data.provider ?? 'no provider'}. Changes go through Hermes, which validates
            them and saves them to this agent's profile.
          </p>
          <div className="supervisor-form-grid">
            <div className="supervisor-field">
              <label className="field-label" htmlFor={`provider-${profile}`}>
                Provider
              </label>
              <select
                id={`provider-${profile}`}
                className="supervisor-select"
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setModel('');
                  setConfirm(null);
                }}
              >
                <option value="">Choose a provider</option>
                {providers.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.name ?? p.slug}
                    {p.authenticated
                      ? ' · ready'
                      : p.auth_type === 'api_key'
                        ? ' · needs key'
                        : ' · needs sign-in'}
                  </option>
                ))}
              </select>
            </div>
            <div className="supervisor-field">
              <label className="field-label" htmlFor={`model-${profile}`}>
                Model
              </label>
              <input
                id={`model-${profile}`}
                list={`models-${profile}`}
                value={model}
                placeholder={chosen?.models.length ? 'Choose or type a model' : 'Model name'}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setModel(e.target.value);
                  setConfirm(null);
                }}
              />
              <datalist id={`models-${profile}`}>
                {(chosen?.models ?? []).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
          </div>
          {chosen?.warning && <p className="muted-copy">{chosen.warning}</p>}
          {needsKey && (
            <form className="supervisor-key" onSubmit={(e) => void saveKey(e)}>
              <label className="field-label" htmlFor={`key-${profile}`}>
                API key for {chosen?.name ?? provider}
              </label>
              <div className="workspace-form">
                <input
                  id={`key-${profile}`}
                  type="password"
                  value={key}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setKey(e.target.value)}
                />
                <button className="button primary" disabled={busy || !key.trim()}>
                  Save key
                </button>
              </div>
              <p className="muted-copy">
                Sent to Hermes, which stores it in this profile. ShellGuardian does not keep it.
              </p>
            </form>
          )}
          {needsSignIn && (
            <div className="supervisor-notice" role="status">
              <p>{chosen?.name ?? provider} uses a sign-in, which Hermes runs in a terminal.</p>
              <button className="button" onClick={() => onSignIn(profile)}>
                <TerminalSquare size={16} />
                Sign in with Hermes
              </button>
            </div>
          )}
          {confirm && (
            <div className="supervisor-notice" role="status">
              <p>{confirm}</p>
              <button className="button primary" disabled={busy} onClick={() => void apply(true)}>
                Confirm model
              </button>
            </div>
          )}
          <div className="settings-buttons">
            <button
              className="button primary"
              disabled={busy || !provider || !model.trim() || Boolean(confirm)}
              onClick={() => void apply(false)}
            >
              {busy && <LoaderCircle size={16} className="spin" />}
              Use this model
            </button>
          </div>
        </>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

// ---- Sessions ----

export function SessionsPanel({ profile, onStarted }: { profile: string; onStarted: () => void }) {
  const sessions = useLoad<HermesSession[]>(() => api.hermesSessions(profile), [profile]);
  const [open, setOpen] = useState<string | null>(null);
  const [rows, setRows] = useState<HermesTranscriptRow[] | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);

  async function show(id: string) {
    setOpen(id);
    setRows(null);
    setRowsError(null);
    try {
      setRows(await api.hermesTranscript(profile, id));
    } catch (e) {
      setRowsError(api.errorMessage(e));
    }
  }

  return (
    <section className="settings-card" aria-label="Hermes sessions">
      <div className="section-label">
        <h3>Sessions for {profile}</h3>
        <RefreshButton loading={sessions.loading} onClick={() => void sessions.reload()} />
      </div>
      {sessions.error && (
        <GatewayError
          profile={profile}
          error={sessions.error}
          onStarted={() => {
            onStarted();
            void sessions.reload();
          }}
        />
      )}
      {sessions.data?.length === 0 && <p className="muted-copy">No stored sessions yet.</p>}
      {sessions.data && sessions.data.length > 0 && (
        <ul className="supervisor-list">
          {sessions.data.map((s) => (
            <li key={s.session_id}>
              <button
                className={`supervisor-list-item${open === s.session_id ? ' selected' : ''}`}
                onClick={() => s.session_id && void show(s.session_id)}
              >
                <strong>{s.title || s.preview || s.session_id}</strong>
                <span>
                  {s.running ? 'Running · ' : ''}
                  {s.message_count ?? '?'} messages · {s.source ?? 'unknown source'} ·{' '}
                  {formatStamp(s.last_active_at ?? s.started_at)}
                  {s.model ? ` · ${s.model}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div className="supervisor-transcript" aria-label="Session transcript">
          {rowsError && (
            <p className="form-error" role="alert">
              {rowsError}
            </p>
          )}
          {!rows && !rowsError && (
            <p className="muted-copy" role="status">
              Loading transcript…
            </p>
          )}
          {rows?.length === 0 && <p className="muted-copy">This session has no messages.</p>}
          {rows?.map((r, i) => (
            <div
              key={i}
              className={`supervisor-message ${r.role === 'user' ? 'user' : 'supervisor'}`}
            >
              <span className="supervisor-role">
                {r.row_kind === 'compaction'
                  ? 'Summary'
                  : r.role === 'tool'
                    ? `Tool${r.name ? ` · ${r.name}` : ''}`
                    : r.role === 'user'
                      ? 'You'
                      : (r.role ?? 'Hermes')}
                {r.timestamp !== undefined ? ` · ${formatStamp(r.timestamp)}` : ''}
              </span>
              <p>{r.text}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---- Schedules ----

export function SchedulesPanel({ profile, onStarted }: { profile: string; onStarted: () => void }) {
  const jobs = useLoad<HermesSchedule[]>(() => api.hermesSchedules(profile), [profile]);
  return (
    <section className="settings-card" aria-label="Hermes schedules">
      <div className="section-label">
        <h3>Schedules for {profile}</h3>
        <RefreshButton loading={jobs.loading} onClick={() => void jobs.reload()} />
      </div>
      {jobs.error && (
        <GatewayError
          profile={profile}
          error={jobs.error}
          onStarted={() => {
            onStarted();
            void jobs.reload();
          }}
        />
      )}
      {jobs.data?.length === 0 && (
        <p className="muted-copy">
          No scheduled jobs. Ask {profile} in chat to schedule one, for example a daily check.
        </p>
      )}
      {jobs.data?.map((j) => (
        <div className="settings-row" key={j.job_id ?? j.name}>
          <span>
            {j.name ?? j.job_id}
            <small className="muted-copy"> {j.schedule}</small>
          </span>
          <span className="supervisor-row-actions">
            <strong>
              {j.paused || j.enabled === false ? 'Paused' : `Next ${formatStamp(j.next_run_at)}`}
            </strong>
            <small>
              Last {formatStamp(j.last_run_at)}
              {j.last_status ? ` · ${j.last_status}` : ''}
            </small>
          </span>
          {j.last_error && <p className="form-error">{j.last_error}</p>}
        </div>
      ))}
    </section>
  );
}

// ---- Supervisor preparation ----

export function PrepareSupervisor({
  profile,
  onChanged,
}: {
  profile: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function prepare() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const done = await api.prepareHermesSupervisor(profile);
      setMessage(
        done.kanbanEnabled || done.skillInstalled
          ? `${profile} can now create and track kanban tasks.`
          : `${profile} was already prepared.`,
      );
      onChanged();
    } catch (e) {
      setError(api.errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card" aria-label="Supervisor duties">
      <div className="section-label">
        <Activity size={20} />
        <h3>Supervisor duties for {profile}</h3>
      </div>
      <p className="muted-copy">
        Lets {profile} turn your requests into kanban tasks. This turns on Hermes's kanban tools for{' '}
        {profile} and adds one ShellGuardian playbook skill. Nothing else in the profile changes.
      </p>
      {error && <GatewayError profile={profile} error={error} onStarted={() => void prepare()} />}
      {message && <p role="status">{message}</p>}
      <div className="settings-buttons">
        <button className="button primary" disabled={busy} onClick={() => void prepare()}>
          {busy && <LoaderCircle size={16} className="spin" />}
          Prepare {profile} as supervisor
        </button>
      </div>
    </section>
  );
}

// ---- Kanban ----

const COLUMNS = ['triage', 'todo', 'ready', 'running', 'blocked', 'review', 'scheduled', 'done'];
const WAITING = ['ready', 'running', 'review'];

function useCurrentBoard() {
  const boards = useLoad<KanbanBoard[]>(() => api.kanbanBoards(), []);
  const [board, setBoard] = useState<string | null>(null);
  const active =
    board ?? boards.data?.find((b) => b.is_current)?.slug ?? boards.data?.[0]?.slug ?? null;
  return { boards, active, setBoard };
}

function lastNote(task: KanbanTaskDetail | undefined): string | null {
  const events = task?.events ?? [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const note = events[i].detail?.note;
    if (note) return note;
  }
  return null;
}

function workerSession(task: KanbanTaskDetail): string | null {
  const events = task.events ?? [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const id = events[i].detail?.session_id;
    if (events[i].kind === 'owner_admitted' && id) return id;
  }
  return null;
}

/** Tasks the supervisor created from one chat session, shown under the chat. */
export function ChatTasks({
  sessionId,
  onOpen,
}: {
  sessionId: string;
  onOpen: (taskId: string) => void;
}) {
  const { active } = useCurrentBoard();
  const tasks = useLoad<KanbanTask[]>(
    () => (active ? api.kanbanTasks(active) : Promise.resolve([])),
    [active],
  );
  usePoll(() => void tasks.reload(true), POLL_MS);
  const mine = (tasks.data ?? []).filter((t) => t.session_id === sessionId);
  if (mine.length === 0) return null;
  return (
    <div className="supervisor-chat-tasks" aria-label="Tasks from this conversation">
      <span className="supervisor-role">Tasks from this conversation</span>
      {mine.map((t) => (
        <button key={String(t.id)} className="kanban-card" onClick={() => onOpen(String(t.id))}>
          <strong>{t.title}</strong>
          <span>
            {t.status} · {t.assignee ?? 'Unassigned'}
          </span>
        </button>
      ))}
    </div>
  );
}

export function KanbanPanel({
  profiles,
  focus,
  onGatewayChanged,
}: {
  profiles: HermesProfile[];
  focus?: string | null;
  onGatewayChanged: () => void;
}) {
  const { boards, active: activeBoard, setBoard } = useCurrentBoard();
  const tasks = useLoad<KanbanTask[]>(
    () => (activeBoard ? api.kanbanTasks(activeBoard) : Promise.resolve([])),
    [activeBoard],
  );
  const [selected, setSelected] = useState<string | null>(focus ?? null);
  const [detail, setDetail] = useState<KanbanTaskDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<HermesTranscriptRow[] | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [running, setRunning] = useState<Record<string, KanbanTaskDetail>>({});
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [, setClock] = useState(0);

  const list = tasks.data ?? [];
  const runningIds = list.filter((t) => t.status === 'running').map((t) => String(t.id));
  const runningKey = runningIds.join(',');

  const loadDetail = useCallback(
    async (id: string, quiet: boolean) => {
      if (!activeBoard) return;
      try {
        const [task, text] = await Promise.all([
          api.kanbanTask(activeBoard, id),
          api.kanbanLog(activeBoard, id).catch(() => null),
        ]);
        setDetail(task);
        setLog(text);
        setDetailError(null);
      } catch (e) {
        if (!quiet) setDetail(null);
        setDetailError(api.errorMessage(e));
      }
    },
    [activeBoard],
  );

  function open(id: string) {
    setSelected(id);
    setDetail(null);
    setLog(null);
    setTranscript(null);
    setTranscriptError(null);
    void loadDetail(id, false);
  }

  useEffect(() => {
    if (focus && activeBoard) open(focus);
  }, [focus, activeBoard]);

  // Live view: refresh the board, the open task, and each running task's latest note.
  usePoll(() => {
    setClock((n) => n + 1);
    void tasks.reload(true);
    if (selected) void loadDetail(selected, true);
  }, POLL_MS);
  useEffect(() => {
    if (!activeBoard) return;
    let cancelled = false;
    void Promise.all(
      runningIds.map((id) => api.kanbanTask(activeBoard, id).catch(() => null)),
    ).then((details) => {
      if (cancelled) return;
      setRunning(
        Object.fromEntries(details.flatMap((d) => (d ? [[String(d.id), d] as const] : []))),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [runningKey, activeBoard, tasks.data]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!activeBoard || !title.trim()) return;
    setBusy(true);
    setFormError(null);
    try {
      await api.createKanbanTask(activeBoard, title.trim(), body, assignee || null);
      setTitle('');
      setBody('');
      await tasks.reload(true);
      void boards.reload(true);
    } catch (e) {
      setFormError(api.errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function addComment(event: FormEvent) {
    event.preventDefault();
    if (!activeBoard || !selected || !comment.trim()) return;
    setBusy(true);
    try {
      await api.commentKanbanTask(activeBoard, selected, comment.trim());
      setComment('');
      await loadDetail(selected, true);
    } catch (e) {
      setDetailError(api.errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function showTranscript(task: KanbanTaskDetail) {
    const session = workerSession(task);
    if (!session || !task.assignee) return;
    setTranscriptError(null);
    try {
      setTranscript(await api.hermesTranscript(task.assignee, session));
    } catch (e) {
      setTranscriptError(api.errorMessage(e));
    }
  }

  const extra = [...new Set(list.map((t) => t.status ?? 'unknown'))].filter(
    (s) => !COLUMNS.includes(s),
  );
  const columns = [...COLUMNS, ...extra].filter(
    (status) =>
      list.some((t) => (t.status ?? 'unknown') === status) ||
      ['todo', 'ready', 'running', 'done'].includes(status),
  );
  // Assignees with queued or running work whose gateway is down: their tasks will not move.
  const stalled = [
    ...new Set(
      list
        .filter((t) => WAITING.includes(t.status ?? '') && t.assignee)
        .map((t) => t.assignee as string),
    ),
  ].filter((name) => {
    const profile = profiles.find((p) => p.name === name);
    return profile && profile.gateway !== 'running';
  });

  return (
    <div className="supervisor-layout">
      {stalled.map((name) => (
        <GatewayError
          key={name}
          profile={name}
          error={`${name} has tasks waiting, but its gateway is ${NOT_RUNNING}.`}
          onStarted={onGatewayChanged}
        />
      ))}
      <section className="settings-card" aria-label="Now running">
        <div className="section-label">
          <Activity size={20} />
          <h3>Now running</h3>
        </div>
        {runningIds.length === 0 && <p className="muted-copy">No tasks are running.</p>}
        {list
          .filter((t) => t.status === 'running')
          .map((t) => (
            <button
              key={String(t.id)}
              className="supervisor-list-item"
              onClick={() => open(String(t.id))}
            >
              <strong>{t.title}</strong>
              <span>
                {t.assignee ?? 'Unassigned'}
                {t.started_at ? ` · running for ${elapsed(t.started_at)}` : ''}
                {lastNote(running[String(t.id)]) ? ` · ${lastNote(running[String(t.id)])}` : ''}
              </span>
            </button>
          ))}
      </section>

      <section className="settings-card" aria-label="Kanban board">
        <div className="section-label">
          <h3>Kanban</h3>
          {boards.data && boards.data.length > 1 && (
            <select
              className="supervisor-select"
              aria-label="Board"
              value={activeBoard ?? ''}
              onChange={(e) => {
                setBoard(e.target.value);
                setSelected(null);
              }}
            >
              {boards.data.map((b) => (
                <option key={b.slug} value={b.slug}>
                  {b.name ?? b.slug}
                </option>
              ))}
            </select>
          )}
          <RefreshButton
            loading={tasks.loading || boards.loading}
            onClick={() => {
              void boards.reload();
              void tasks.reload();
            }}
          />
        </div>
        <p className="muted-copy">
          Hermes's shared task board, updated every few seconds. Assigned tasks run when that
          agent's gateway is running.
        </p>
        {(boards.error || tasks.error) && (
          <p className="form-error" role="alert">
            {boards.error ?? tasks.error}
          </p>
        )}
        <div className="kanban-columns">
          {columns.map((status) => {
            const items = list.filter((t) => (t.status ?? 'unknown') === status);
            return (
              <div className="kanban-column" key={status} aria-label={`${status} tasks`}>
                <h4>
                  {status[0].toUpperCase() + status.slice(1)} <span>{items.length}</span>
                </h4>
                {items.map((t) => (
                  <button
                    key={String(t.id)}
                    className={`kanban-card${selected === String(t.id) ? ' selected' : ''}`}
                    onClick={() => open(String(t.id))}
                  >
                    <strong>{t.title}</strong>
                    <span>{t.assignee ?? 'Unassigned'}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </section>

      {selected && (
        <section className="settings-card" aria-label="Kanban task">
          {detailError && (
            <p className="form-error" role="alert">
              {detailError}
            </p>
          )}
          {!detail && !detailError && <p className="muted-copy">Loading task…</p>}
          {detail && (
            <>
              <div className="section-label">
                <h3>{detail.title}</h3>
              </div>
              <div className="settings-row">
                <span>Status</span>
                <strong>{detail.status}</strong>
              </div>
              <div className="settings-row">
                <span>Assignee</span>
                <strong>{detail.assignee ?? 'Unassigned'}</strong>
              </div>
              {(detail.model_override || detail.provider_override) && (
                <div className="settings-row">
                  <span>Model for this task</span>
                  <strong>
                    {detail.model_override ?? 'default'}
                    {detail.provider_override ? ` via ${detail.provider_override}` : ''}
                  </strong>
                </div>
              )}
              <div className="settings-row">
                <span>Created</span>
                <strong>
                  {formatStamp(detail.created_at)}
                  {detail.created_by ? ` by ${detail.created_by}` : ''}
                </strong>
              </div>
              {detail.body && <p className="kanban-text">{detail.body}</p>}
              {(detail.result || detail.latest_summary) && (
                <>
                  <h4>Result</h4>
                  <p className="kanban-text">{detail.result || detail.latest_summary}</p>
                </>
              )}
              {detail.last_failure_error && (
                <p className="form-error">{detail.last_failure_error}</p>
              )}

              <h4>Timeline</h4>
              {(detail.events ?? []).length === 0 && (
                <p className="muted-copy">No activity recorded yet.</p>
              )}
              <ol className="kanban-timeline" aria-label="Task timeline">
                {(detail.events ?? []).map((e, i) => (
                  <li key={i}>
                    <strong>{e.kind}</strong>
                    <span>{formatStamp(e.created_at)}</span>
                    {(e.detail?.note ||
                      e.detail?.reason ||
                      e.detail?.summary ||
                      e.detail?.error ||
                      e.detail?.outcome) && (
                      <p>
                        {e.detail.note ??
                          e.detail.reason ??
                          e.detail.summary ??
                          e.detail.error ??
                          e.detail.outcome}
                      </p>
                    )}
                  </li>
                ))}
              </ol>

              {(detail.runs ?? []).length > 0 && (
                <>
                  <h4>Runs</h4>
                  {(detail.runs ?? []).map((r) => (
                    <div className="settings-row" key={String(r.id)}>
                      <span>
                        {r.profile ?? 'worker'} · {formatStamp(r.started_at)}
                      </span>
                      <strong>{r.outcome ?? r.status}</strong>
                      {r.error && <p className="form-error">{r.error}</p>}
                    </div>
                  ))}
                </>
              )}

              {log && (
                <details className="hermes-profiles" open={detail.status === 'running'}>
                  <summary>Worker log</summary>
                  <pre aria-label="Worker log">{log}</pre>
                </details>
              )}
              {workerSession(detail) && (
                <div className="settings-buttons">
                  <button className="button" onClick={() => void showTranscript(detail)}>
                    {transcript ? 'Refresh worker transcript' : 'View worker transcript'}
                  </button>
                </div>
              )}
              {transcriptError && (
                <p className="form-error" role="alert">
                  {transcriptError}
                </p>
              )}
              {transcript && (
                <div className="supervisor-transcript" aria-label="Worker transcript">
                  <TranscriptRows rows={transcript} />
                </div>
              )}

              <h4>Comments</h4>
              {detail.comments.length === 0 && <p className="muted-copy">No comments.</p>}
              {detail.comments.map((c, i) => (
                <div key={i} className="supervisor-message supervisor">
                  <span className="supervisor-role">
                    {c.author ?? 'unknown'} · {formatStamp(c.created_at)}
                  </span>
                  <p>{c.body}</p>
                </div>
              ))}
              <form className="workspace-form" onSubmit={(e) => void addComment(e)}>
                <input
                  aria-label="Comment"
                  value={comment}
                  placeholder="Add a comment"
                  onChange={(e) => setComment(e.target.value)}
                />
                <button className="button" disabled={busy || !comment.trim()}>
                  <Send size={14} />
                  Comment
                </button>
              </form>
            </>
          )}
        </section>
      )}

      <section className="settings-card" aria-label="New kanban task">
        <form className="supervisor-create" onSubmit={(e) => void create(e)}>
          <div className="section-label">
            <Plus size={20} />
            <h3>New task</h3>
          </div>
          <div className="supervisor-field">
            <label className="field-label" htmlFor="kanban-title">
              Title
            </label>
            <input
              id="kanban-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={300}
            />
          </div>
          <div className="supervisor-field">
            <label className="field-label" htmlFor="kanban-body">
              Description
            </label>
            <textarea
              id="kanban-body"
              rows={3}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <div className="supervisor-field">
            <label className="field-label" htmlFor="kanban-assignee">
              Assign to
            </label>
            <select
              id="kanban-assignee"
              className="supervisor-select"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
            >
              <option value="">Nobody yet</option>
              {profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          {assignee && (
            <p className="muted-copy">
              {assignee} will start this task in its own workspace once its gateway is running.
            </p>
          )}
          {formError && (
            <p className="form-error" role="alert">
              {formError}
            </p>
          )}
          <div className="settings-buttons">
            <button className="button primary" disabled={busy || !title.trim() || !activeBoard}>
              Create task
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
