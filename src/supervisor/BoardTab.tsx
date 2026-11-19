// The kanban board: one column per status, live, with a drawer for each task.
import { useState, type FormEvent } from 'react';
import { ClipboardList, LoaderCircle, Plus } from 'lucide-react';
import * as api from '../api';
import { Modal } from '../ui';
import type { HermesProfile, KanbanTask, KanbanTaskDetail } from '../types';
import { STATUSES, elapsed, formatAgo, statusMeta } from './format';
import { lastNote, useTicker, type useBoard } from './hooks';
import { Empty, GatewayNotice, RefreshButton, Select } from './parts';

type Board = ReturnType<typeof useBoard>;

/** Columns that are always shown; the rest appear only when they hold tasks. */
const CORE = ['todo', 'ready', 'running', 'blocked', 'done'];
const WAITING = ['ready', 'running', 'review'];
/** Cards shown per column before "Show all". */
const COLUMN_LIMIT = 12;

/**
 * Tasks arrive newest first. Queues read better oldest first (the next one to
 * start is on top), and running tasks longest-running first.
 */
function ordered(status: string, items: KanbanTask[]): KanbanTask[] {
  if (['triage', 'todo', 'scheduled', 'ready'].includes(status)) return [...items].reverse();
  if (status === 'running')
    return [...items].sort((a, b) => Number(a.started_at ?? 0) - Number(b.started_at ?? 0));
  return items;
}

function cardTime(task: KanbanTask): string {
  if (task.status === 'running' && task.started_at !== undefined)
    return `Running ${elapsed(task.started_at)}`;
  if (task.status === 'done' && task.started_at !== undefined && task.completed_at !== undefined)
    return `Took ${elapsed(task.started_at, task.completed_at)}`;
  return task.created_at !== undefined ? formatAgo(task.created_at) : '';
}

function NewTaskDialog({
  board,
  profiles,
  onClose,
  onCreated,
}: {
  board: string;
  profiles: HermesProfile[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createKanbanTask(board, title.trim(), body, assignee || null);
      onCreated();
      onClose();
    } catch (e) {
      setError(api.errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Modal className="confirmation sv-dialog" label="New task" onClose={onClose} busy={busy}>
      <form onSubmit={(e) => void create(e)}>
        <h2>New task</h2>
        <p className="muted-copy">
          Tasks you create here go straight to the board. You can also ask the supervisor in chat
          and let it write the tasks.
        </p>
        <label className="field-label" htmlFor="sv-task-title">
          Title
        </label>
        <input
          id="sv-task-title"
          className="sv-input"
          value={title}
          maxLength={300}
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
        />
        <label className="field-label" htmlFor="sv-task-body">
          What should be done
        </label>
        <textarea
          id="sv-task-body"
          className="sv-input"
          rows={4}
          value={body}
          placeholder="The goal, the inputs, and what done looks like"
          onChange={(e) => setBody(e.target.value)}
        />
        <label className="field-label" htmlFor="sv-task-assignee">
          Assign to
        </label>
        <Select
          id="sv-task-assignee"
          className="block"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
        >
          <option value="">Nobody yet</option>
          {profiles.map((profile) => (
            <option key={profile.name} value={profile.name}>
              {profile.name}
            </option>
          ))}
        </Select>
        <p className="muted-copy">
          {assignee
            ? `${assignee} starts this task in its own workspace as soon as its gateway is running.`
            : 'An unassigned task waits in To do until someone is assigned.'}
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="confirm-buttons">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || !title.trim()}>
            {busy && <LoaderCircle size={15} className="spin" aria-hidden="true" />}
            Create task
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function BoardTab({
  board,
  profiles,
  running,
  archived,
  onArchived,
  selected,
  onOpen,
  onGatewayChanged,
}: {
  board: Board;
  profiles: HermesProfile[];
  running: Record<string, KanbanTaskDetail>;
  archived: boolean;
  onArchived: (show: boolean) => void;
  selected: string | null;
  onOpen: (id: string) => void;
  onGatewayChanged: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [agent, setAgent] = useState('');
  const [expanded, setExpanded] = useState<string[]>([]);
  const assignees = [
    ...new Set(board.tasks.flatMap((task) => (task.assignee ? [task.assignee] : []))),
  ].sort();
  const filter = assignees.includes(agent) ? agent : '';
  const tasks = filter ? board.tasks.filter((task) => task.assignee === filter) : board.tasks;
  useTicker(tasks.some((task) => task.status === 'running'));

  const count = (status: string) => tasks.filter((task) => task.status === status).length;
  const known = STATUSES.map((entry) => entry.key);
  const extra = [...new Set(tasks.map((task) => task.status ?? 'unknown'))].filter(
    (status) => !known.includes(status),
  );
  const columns = [...known, ...extra].filter(
    (status) => CORE.includes(status) || count(status) > 0,
  );
  // Agents with queued or running work whose gateway is down: their tasks will not move.
  const stalled = [
    ...new Set(
      tasks
        .filter((task) => WAITING.includes(task.status ?? '') && task.assignee)
        .map((task) => task.assignee as string),
    ),
  ].filter((name) => {
    const profile = profiles.find((p) => p.name === name);
    return profile !== undefined && profile.gateway !== 'running';
  });

  return (
    <div className="sv-board-view">
      <div className="sv-toolbar">
        <div className="sv-toolbar-summary" aria-label="Board summary">
          {!board.loaded ? (
            // Counts are unknown until the first read: say so instead of zero.
            <span role="status">{board.error ? 'Board unavailable' : 'Reading the board…'}</span>
          ) : (
            <>
              <strong>{count('running')}</strong> running
              <span aria-hidden="true">·</span>
              <strong>{count('ready') + count('todo')}</strong> waiting
              <span aria-hidden="true">·</span>
              <strong>{count('blocked')}</strong> blocked
              <span aria-hidden="true">·</span>
              <strong>{count('done')}</strong> done
              {board.truncated && <span className="small-tag">Newest {tasks.length} shown</span>}
            </>
          )}
        </div>
        {board.boards.length > 1 && (
          <label className="sv-inline-field">
            Board
            <Select value={board.active ?? ''} onChange={(e) => board.choose(e.target.value)}>
              {board.boards.map((entry) => (
                <option key={entry.slug} value={entry.slug}>
                  {entry.name ?? entry.slug}
                </option>
              ))}
            </Select>
          </label>
        )}
        {assignees.length > 1 && (
          <label className="sv-inline-field">
            Agent
            <Select
              aria-label="Filter by agent"
              value={filter}
              onChange={(e) => setAgent(e.target.value)}
            >
              <option value="">All agents</option>
              {assignees.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </label>
        )}
        <label className="sv-check">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => onArchived(e.target.checked)}
          />
          Show archived
        </label>
        <RefreshButton loading={board.loading} onClick={() => void board.refresh()} />
        <button
          className="button primary"
          disabled={!board.active}
          onClick={() => setCreating(true)}
        >
          <Plus size={15} aria-hidden="true" />
          New task
        </button>
      </div>

      {board.error && (
        <p className="form-error" role="alert">
          {board.error}
        </p>
      )}
      {stalled.map((name) => (
        <GatewayNotice key={name} profile={name} onStarted={onGatewayChanged}>
          {name} has tasks waiting, but its Hermes gateway is not running. They will not start until
          it is.
        </GatewayNotice>
      ))}

      {!board.loaded ? null : tasks.length === 0 ? (
        <section className="settings-card">
          <Empty icon={ClipboardList} title="No tasks on this board yet">
            Ask the supervisor for something in Chat and its tasks appear here, or create one
            yourself with New task.
          </Empty>
        </section>
      ) : (
        <div className="sv-board" role="list" aria-label="Kanban board">
          {columns.map((status) => {
            const meta = statusMeta(status);
            const items = ordered(
              status,
              tasks.filter((task) => (task.status ?? 'unknown') === status),
            );
            // Long finished columns start short; the rest is one click away.
            const capped = !expanded.includes(status) && items.length > COLUMN_LIMIT;
            const shown = capped ? items.slice(0, COLUMN_LIMIT) : items;
            return (
              <section
                className={`sv-column ${meta.tone}`}
                key={status}
                role="listitem"
                aria-label={`${meta.label} tasks`}
              >
                <header title={meta.hint || undefined}>
                  <span className="sv-column-dot" />
                  <h3>{meta.label}</h3>
                  <span className="count-badge">{items.length}</span>
                </header>
                <div className="sv-column-cards">
                  {items.length === 0 && <p className="sv-column-empty">Nothing here</p>}
                  {shown.map((task) => {
                    const id = String(task.id);
                    const note = task.status === 'running' ? lastNote(running[id]) : null;
                    return (
                      <button
                        key={id}
                        className={`sv-card${selected === id ? ' selected' : ''}`}
                        onClick={() => onOpen(id)}
                      >
                        <strong>{task.title}</strong>
                        {note && <span className="sv-card-note">{note}</span>}
                        <span className="sv-card-foot">
                          <span className="sv-assignee">{task.assignee ?? 'Unassigned'}</span>
                          <span>{cardTime(task)}</span>
                        </span>
                      </button>
                    );
                  })}
                  {capped && (
                    <button
                      className="text-button sv-show-all"
                      onClick={() => setExpanded((open) => [...open, status])}
                    >
                      Show all {items.length}
                    </button>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {creating && board.active && (
        <NewTaskDialog
          board={board.active}
          profiles={profiles}
          onClose={() => setCreating(false)}
          onCreated={() => void board.refresh()}
        />
      )}
    </div>
  );
}
