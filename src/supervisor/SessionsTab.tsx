// Every Hermes session for an agent: chats sent from here, kanban task runs,
// and interactive conversations. Transcripts are read-only.
import { useEffect, useState } from 'react';
import { History, MessagesSquare } from 'lucide-react';
import * as api from '../api';
import type { HermesSession } from '../types';
import { SESSION_KINDS } from './format';
import { gatewayDown, useLoad, useTranscript } from './hooks';
import { Empty, GatewayNotice, RefreshButton, TranscriptRows } from './parts';

const FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'chat', label: 'Chats' },
  { key: 'task', label: 'Task runs' },
  { key: 'conversation', label: 'Conversations' },
];

const heading = (session: HermesSession) => session.title ?? session.preview ?? session.id;

export function SessionsTab({
  profile,
  gatewayRunning,
  onGatewayChanged,
}: {
  profile: string;
  gatewayRunning: boolean;
  onGatewayChanged: () => void;
}) {
  const sessions = useLoad<HermesSession[]>(() => api.hermesSessions(profile), [profile]);
  const transcript = useTranscript();
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState<HermesSession | null>(null);

  // A transcript that failed because the gateway was down loads once it is up.
  const openId = open?.id ?? null;
  const waiting = gatewayDown(transcript.error);
  const loadTranscript = transcript.load;
  useEffect(() => {
    if (gatewayRunning && waiting && openId) void loadTranscript(profile, openId);
  }, [gatewayRunning, waiting, openId, profile, loadTranscript]);

  const all = sessions.data ?? [];
  const shown = filter === 'all' ? all : all.filter((session) => session.kind === filter);
  function show(session: HermesSession) {
    setOpen(session);
    void transcript.load(profile, session.id);
  }

  return (
    <div className="sv-sessions-view">
      <section className="settings-card sv-session-list" aria-label="Hermes sessions">
        <div className="section-label">
          <History size={18} aria-hidden="true" />
          <h3>Sessions for {profile}</h3>
          <RefreshButton loading={sessions.loading} onClick={() => void sessions.reload()} />
        </div>
        <div className="sv-filters" role="group" aria-label="Filter sessions">
          {FILTERS.map((entry) => (
            <button
              key={entry.key}
              className="sv-filter"
              aria-pressed={filter === entry.key}
              onClick={() => setFilter(entry.key)}
            >
              {entry.label}
              <span className="count-badge">
                {entry.key === 'all' ? all.length : all.filter((s) => s.kind === entry.key).length}
              </span>
            </button>
          ))}
        </div>
        {sessions.error && (
          <p className="form-error" role="alert">
            {sessions.error}
          </p>
        )}
        {sessions.loading && !sessions.data && (
          <p className="muted-copy" role="status">
            Reading {profile}'s sessions…
          </p>
        )}
        {sessions.data && shown.length === 0 && (
          <Empty icon={History} title="No sessions here yet">
            {filter === 'all'
              ? `Sessions appear after you chat with ${profile} or it runs a task.`
              : 'No sessions of this kind yet.'}
          </Empty>
        )}
        <ul className="sv-list">
          {shown.map((session) => {
            const kind = SESSION_KINDS[session.kind] ?? SESSION_KINDS.conversation;
            return (
              <li key={session.id}>
                <button
                  className={`sv-list-item${open?.id === session.id ? ' selected' : ''}`}
                  aria-current={open?.id === session.id ? 'true' : undefined}
                  onClick={() => show(session)}
                >
                  <strong>{heading(session)}</strong>
                  <span>
                    <span className={`status ${kind.tone}`}>{kind.label}</span>
                    {session.workspace && <span>{session.workspace}</span>}
                    {session.lastActive && <span>{session.lastActive}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="settings-card sv-session-detail" aria-label="Session transcript">
        {!open && (
          <Empty icon={MessagesSquare} title="Choose a session">
            Pick a session to read what was asked and what {profile} did. Reading a transcript never
            changes or resumes the session.
          </Empty>
        )}
        {open && (
          <>
            <div className="section-label">
              <MessagesSquare size={18} aria-hidden="true" />
              <h3>{heading(open)}</h3>
              <RefreshButton
                loading={transcript.loading}
                onClick={() => void transcript.load(profile, open.id)}
              />
            </div>
            {transcript.error &&
              (gatewayDown(transcript.error) ? (
                <GatewayNotice
                  profile={profile}
                  onStarted={() => {
                    onGatewayChanged();
                    void transcript.load(profile, open.id);
                  }}
                >
                  Reading a transcript needs {profile}'s Hermes gateway, which is not running.
                </GatewayNotice>
              ) : (
                <p className="form-error" role="alert">
                  {transcript.error}
                </p>
              ))}
            {transcript.loading && !transcript.rows && (
              <p className="muted-copy" role="status">
                Loading transcript…
              </p>
            )}
            {transcript.rows && (
              <div className="sv-transcript tall" tabIndex={0}>
                <TranscriptRows rows={transcript.rows} agent={profile} />
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
