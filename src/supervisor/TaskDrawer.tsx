// A kanban task in the right-side drawer: what was asked, what happened, and
// what the worker is doing now.
import { useEffect, useState, type FormEvent } from 'react';
import { LoaderCircle, MessagesSquare, Send, X } from 'lucide-react';
import * as api from '../api';
import { IconButton, Modal } from '../ui';
import type { HermesProfile, KanbanEvent } from '../types';
import { elapsed, eventLabel, eventTone, formatClock, formatStamp } from './format';
import { lastNote, useTask, useTicker, useTranscript, workerSession } from './hooks';
import { Markdown } from './markdown';
import { GatewayNotice, TaskStatus, TranscriptRows } from './parts';

const WAITING = ['ready', 'running', 'review'];

export function TaskDrawer({
  board,
  id,
  version,
  profiles,
  onClose,
  onChanged,
  onGatewayChanged,
}: {
  board: string;
  id: string;
  /** Changes whenever the board changes, so the drawer stays current. */
  version: number;
  profiles: HermesProfile[];
  onClose: () => void;
  onChanged: () => void;
  onGatewayChanged: () => void;
}) {
  const { detail, log, error, reload } = useTask(board, id, version);
  const transcript = useTranscript();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const running = detail?.status === 'running';
  useTicker(running);

  const session = detail ? workerSession(detail) : null;
  const assignee = detail?.assignee ?? null;
  // A running task's transcript grows: refresh it along with the board.
  const showingTranscript = transcript.rows !== null;
  useEffect(() => {
    if (showingTranscript && running && assignee && session)
      void transcript.load(assignee, session);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  async function addComment(event: FormEvent) {
    event.preventDefault();
    const text = comment.trim();
    if (!text) return;
    setBusy(true);
    setCommentError(null);
    try {
      await api.commentKanbanTask(board, id, text);
      setComment('');
      await reload();
      onChanged();
    } catch (e) {
      setCommentError(api.errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const assigneeProfile = profiles.find((profile) => profile.name === assignee);
  const stalled =
    detail && assigneeProfile && WAITING.includes(detail.status ?? '')
      ? assigneeProfile.gateway !== 'running'
      : false;
  // Workers check in often. Check-ins without a note fold into one line.
  type Entry = { label: string; tone: string; at: KanbanEvent['created_at']; text?: string };
  const events: Entry[] = [];
  let checkIns = 0;
  for (const event of detail?.events ?? []) {
    const label = eventLabel(event.kind);
    if (label === null) continue;
    const text =
      event.detail?.note ?? event.detail?.reason ?? event.detail?.summary ?? event.detail?.error;
    const last = events[events.length - 1];
    if (event.kind === 'heartbeat' && !text) {
      checkIns = last?.label.startsWith('Still working') ? checkIns + 1 : 1;
      const line = checkIns > 1 ? `Still working · ${checkIns} check-ins` : 'Still working';
      if (checkIns > 1) events[events.length - 1] = { ...last, label: line, at: event.created_at };
      else events.push({ label: line, tone: 'muted', at: event.created_at });
      continue;
    }
    events.push({ label, tone: eventTone(event.kind), at: event.created_at, text });
  }
  const runs = detail?.runs ?? [];
  const note = lastNote(detail ?? undefined);
  const title = detail?.title ?? 'Task';

  return (
    <Modal className="drawer sv-task-drawer" label={`Task: ${title}`} onClose={onClose}>
      <div className="drawer-header">
        <div className="eyebrow">TASK</div>
        <IconButton icon={X} label="Close task" onClick={onClose} />
      </div>
      {!detail && !error && (
        <div className="drawer-body">
          <p className="muted-copy" role="status">
            Loading task…
          </p>
        </div>
      )}
      {!detail && error && (
        <div className="drawer-body">
          <p className="form-error" role="alert">
            {error}
          </p>
        </div>
      )}
      {detail && (
        <>
          <div className="drawer-identity">
            <h2>{detail.title}</h2>
            <div className="sv-task-meta">
              <TaskStatus status={detail.status} />
              <span>{assignee ? `Assigned to ${assignee}` : 'Not assigned'}</span>
              <code className="sv-task-id">{id}</code>
              {running && detail.started_at !== undefined && (
                <span>Running for {elapsed(detail.started_at)}</span>
              )}
            </div>
            {running && note && <p className="sv-task-note">{note}</p>}
          </div>
          <div className="drawer-body">
            {stalled && assignee && (
              <GatewayNotice profile={assignee} onStarted={onGatewayChanged}>
                {assignee}'s Hermes gateway is not running, so this task will not move until it is
                started.
              </GatewayNotice>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}

            <dl className="sv-facts">
              <div>
                <dt>Created</dt>
                <dd>
                  {formatStamp(detail.created_at)}
                  {detail.created_by ? ` by ${detail.created_by}` : ''}
                </dd>
              </div>
              {detail.started_at !== undefined && (
                <div>
                  <dt>Started</dt>
                  <dd>{formatStamp(detail.started_at)}</dd>
                </div>
              )}
              {detail.completed_at !== undefined && (
                <div>
                  <dt>Finished</dt>
                  <dd>
                    {formatStamp(detail.completed_at)}
                    {detail.started_at !== undefined
                      ? ` after ${elapsed(detail.started_at, detail.completed_at)}`
                      : ''}
                  </dd>
                </div>
              )}
              {(detail.model_override || detail.provider_override) && (
                <div>
                  <dt>Model for this task</dt>
                  <dd>
                    {detail.model_override ?? 'Agent default'}
                    {detail.provider_override ? ` via ${detail.provider_override}` : ''}
                  </dd>
                </div>
              )}
            </dl>

            {detail.body && (
              <section className="sv-section" aria-label="Request">
                <h3>Request</h3>
                <Markdown text={detail.body} />
              </section>
            )}
            {(detail.result || detail.latest_summary) && (
              <section className="sv-section sv-result" aria-label="Result">
                <h3>Result</h3>
                <Markdown text={detail.result || detail.latest_summary || ''} />
              </section>
            )}
            {detail.last_failure_error && (
              <section className="sv-section" aria-label="Last failure">
                <h3>Last failure</h3>
                <p className="form-error">{detail.last_failure_error}</p>
              </section>
            )}

            <section className="sv-section" aria-label="Timeline">
              <h3>Timeline</h3>
              {events.length === 0 ? (
                <p className="muted-copy">No activity recorded yet.</p>
              ) : (
                <ol className="sv-timeline" aria-label="Task timeline">
                  {events.map((event, index) => (
                    <li key={index} className={event.tone}>
                      <span className="sv-timeline-dot" />
                      <div>
                        <strong>{event.label}</strong>
                        <time>{formatClock(event.at)}</time>
                        {event.text && <p>{event.text}</p>}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {runs.length > 1 && (
              <section className="sv-section" aria-label="Runs">
                <h3>Runs</h3>
                {runs.map((run) => (
                  <div className="settings-row" key={String(run.id)}>
                    <span>
                      {run.profile ?? 'worker'} · {formatStamp(run.started_at)}
                    </span>
                    <strong>{run.outcome ?? run.status}</strong>
                  </div>
                ))}
              </section>
            )}

            {session && assignee && (
              <section className="sv-section" aria-label="Worker session">
                <h3>Worker session</h3>
                {transcript.error && (
                  <p className="form-error" role="alert">
                    {transcript.error}
                  </p>
                )}
                {transcript.rows && (
                  <div className="sv-transcript" aria-label="Worker transcript">
                    <TranscriptRows rows={transcript.rows} agent={assignee} />
                  </div>
                )}
                <button
                  className="button compact"
                  disabled={transcript.loading}
                  onClick={() => void transcript.load(assignee, session)}
                >
                  {transcript.loading ? (
                    <LoaderCircle size={14} className="spin" aria-hidden="true" />
                  ) : (
                    <MessagesSquare size={14} aria-hidden="true" />
                  )}
                  {transcript.rows ? 'Refresh transcript' : `Show what ${assignee} did`}
                </button>
              </section>
            )}

            {log && log.trim() && (
              <details className="sv-log" open={running}>
                <summary>Worker log</summary>
                <pre aria-label="Worker log" tabIndex={0}>
                  {log}
                </pre>
              </details>
            )}

            <section className="sv-section" aria-label="Comments">
              <h3>Comments</h3>
              {detail.comments.length === 0 && <p className="muted-copy">No comments yet.</p>}
              {detail.comments.map((entry, index) => (
                <div key={index} className="sv-comment">
                  <span className="sv-msg-who">
                    {entry.author ?? 'Unknown'}
                    <small>{formatStamp(entry.created_at)}</small>
                  </span>
                  <Markdown text={entry.body ?? ''} />
                </div>
              ))}
            </section>
          </div>
          <form className="drawer-footer sv-comment-form" onSubmit={(e) => void addComment(e)}>
            <input
              aria-label="Comment"
              value={comment}
              placeholder="Add a comment for the agent"
              maxLength={4000}
              onChange={(e) => setComment(e.target.value)}
            />
            <button className="button" disabled={busy || !comment.trim()}>
              <Send size={14} aria-hidden="true" />
              Comment
            </button>
            {commentError && (
              <p className="form-error" role="alert">
                {commentError}
              </p>
            )}
          </form>
        </>
      )}
    </Modal>
  );
}
