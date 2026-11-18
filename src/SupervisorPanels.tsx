import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { KeyRound, LoaderCircle, Play, Plus, RefreshCw, Send, TerminalSquare } from 'lucide-react';
import * as api from './api';
import type {
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
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await load());
      setError(null);
    } catch (e) {
      setData(null);
      setError(api.errorMessage(e));
    } finally {
      setLoading(false);
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

// ---- Kanban ----

const COLUMNS = ['triage', 'todo', 'ready', 'running', 'blocked', 'review', 'scheduled', 'done'];

export function KanbanPanel({ profiles }: { profiles: string[] }) {
  const boards = useLoad<KanbanBoard[]>(() => api.kanbanBoards(), []);
  const [board, setBoard] = useState<string | null>(null);
  const activeBoard =
    board ?? boards.data?.find((b) => b.is_current)?.slug ?? boards.data?.[0]?.slug ?? null;
  const tasks = useLoad<KanbanTask[]>(
    () => (activeBoard ? api.kanbanTasks(activeBoard) : Promise.resolve([])),
    [activeBoard],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<KanbanTaskDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function open(id: string) {
    if (!activeBoard) return;
    setSelected(id);
    setDetail(null);
    setDetailError(null);
    try {
      setDetail(await api.kanbanTask(activeBoard, id));
    } catch (e) {
      setDetailError(api.errorMessage(e));
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!activeBoard || !title.trim()) return;
    setBusy(true);
    setFormError(null);
    try {
      await api.createKanbanTask(activeBoard, title.trim(), body, assignee || null);
      setTitle('');
      setBody('');
      await tasks.reload();
      void boards.reload();
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
      await open(selected);
    } catch (e) {
      setDetailError(api.errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const list = tasks.data ?? [];
  const extra = [...new Set(list.map((t) => t.status ?? 'unknown'))].filter(
    (s) => !COLUMNS.includes(s),
  );
  const columns = [...COLUMNS, ...extra].filter(
    (status) =>
      list.some((t) => (t.status ?? 'unknown') === status) ||
      ['todo', 'ready', 'running', 'done'].includes(status),
  );

  return (
    <div className="supervisor-layout">
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
          Hermes's shared task board. Assigned tasks run when that agent's gateway is running.
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
                    onClick={() => void open(String(t.id))}
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
              <div className="settings-row">
                <span>Created</span>
                <strong>{formatStamp(detail.created_at)}</strong>
              </div>
              {detail.body && <p className="kanban-text">{detail.body}</p>}
              {(detail.result || detail.latest_summary) && (
                <>
                  <h4>Result</h4>
                  <p className="kanban-text">{detail.result || detail.latest_summary}</p>
                </>
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
                <option key={p} value={p}>
                  {p}
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
