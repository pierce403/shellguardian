// Chat with the supervisor, with the work it creates alongside.
import { useEffect, useLayoutEffect, useRef, type FormEvent, type KeyboardEvent } from 'react';
import {
  Activity,
  ArrowRight,
  BrainCircuit,
  Gauge,
  ListChecks,
  LoaderCircle,
  MessageSquarePlus,
  Send,
  Square,
  TerminalSquare,
} from 'lucide-react';
import type { HermesModelOptions, KanbanTask, KanbanTaskDetail } from '../types';
import { elapsed, formatCount, formatDuration, toDate } from './format';
import { lastNote, useTicker, type useBoard, type useLoad } from './hooks';
import { Markdown } from './markdown';
import { StepList, TaskStatus, UsageMeters } from './parts';
import type { ChatMessage, Hermes } from './useHermes';

type Board = ReturnType<typeof useBoard>;
type Usage = ReturnType<typeof useLoad<HermesModelOptions>>;

const MESSAGE_LIMIT = 16 * 1024;
const STOP_ARMS_AFTER_MS = 700;
const SUGGESTIONS = [
  'What is on the board right now?',
  "Create a task to summarize today's sandbox activity.",
  'Which of my agents are set up, and what is each one for?',
];

function AgentMessage({
  message,
  agent,
  tasks,
  onOpenTask,
}: {
  message: ChatMessage;
  agent: string;
  /** Tasks this reply created, shown live under it. */
  tasks: KanbanTask[];
  onOpenTask: (id: string) => void;
}) {
  const steps = message.steps ?? [];
  const ended = !message.stopped
    ? null
    : message.timedOut
      ? 'stopped at the time limit'
      : message.stopConfirmed
        ? 'stopped by you'
        : 'stopped watching';
  const facts = [
    message.durationMs && message.durationMs >= 1000 ? formatDuration(message.durationMs) : null,
    steps.length ? `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}` : null,
    ended,
  ].filter(Boolean);
  return (
    <div className="sv-msg agent">
      <span className="sv-msg-who">
        {agent}
        {facts.length > 0 && <small>{facts.join(' · ')}</small>}
      </span>
      {steps.length > 0 && (
        <details className="sv-msg-steps">
          <summary>What {agent} did</summary>
          <StepList steps={steps} />
        </details>
      )}
      {message.text ? (
        <Markdown text={message.text} />
      ) : (
        <p className="muted-copy">Stopped before {agent} wrote anything.</p>
      )}
      {message.stopped && !message.stopConfirmed && (
        <p className="sv-msg-note" role="status">
          ShellGuardian stopped watching, but Hermes did not confirm that {agent} stopped. It may
          still be finishing this turn, and new messages wait until it ends.
        </p>
      )}
      {message.incomplete && (
        <p className="sv-msg-note" role="status">
          Hermes ended this turn before {agent} finished, for example at its step limit. Ask it to
          continue if you need the rest.
        </p>
      )}
      {tasks.length > 0 && (
        <ul className="sv-msg-tasks" aria-label="Tasks created by this reply">
          {tasks.map((task) => (
            <li key={String(task.id)}>
              <button className="sv-work-item" onClick={() => onOpenTask(String(task.id))}>
                <strong>{task.title}</strong>
                <span className="sv-work-status">
                  <TaskStatus status={task.status} />
                  {task.assignee ?? 'Unassigned'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Tasks created between a request and its reply belong to that reply. */
function tasksByReply(messages: ChatMessage[], tasks: KanbanTask[]): Map<number, KanbanTask[]> {
  const replies = messages.filter((message) => message.role === 'agent');
  const grouped = new Map<number, KanbanTask[]>();
  for (const task of tasks) {
    const created = toDate(task.created_at)?.getTime();
    if (created === undefined) continue;
    // The first reply that finished after the task appeared. Hermes stamps
    // tasks in whole seconds, hence the small allowance. A task newer than
    // every finished reply belongs to a turn still running (or one that
    // failed): it is listed in the rail, not under an earlier reply.
    const owner = replies.find((reply) => reply.at + 1500 >= created);
    if (owner) grouped.set(owner.id, [...(grouped.get(owner.id) ?? []), task]);
  }
  return grouped;
}

export function ChatTab({
  hermes,
  board,
  running,
  usage,
  onOpenTask,
  onShowBoard,
  onConfigure,
  onChooseProvider,
}: {
  hermes: Hermes;
  board: Board;
  running: Record<string, KanbanTaskDetail>;
  usage: Usage;
  onOpenTask: (id: string) => void;
  onShowBoard: () => void;
  onConfigure: (profile: string) => void;
  onChooseProvider: (profile: string) => void;
}) {
  const { supervisor, conversation, sending, progress } = hermes;
  // The draft lives with the rest of the chat state, so it survives a tab switch.
  const { draft, setDraft } = hermes;
  const thread = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const pinned = useRef(true);
  const messages = conversation?.messages ?? [];
  // Task cards appear inside replies after the reply itself; keep following.
  const taskCount = conversation?.sessionId
    ? board.tasks.filter((task) => task.session_id === conversation.sessionId).length
    : 0;
  const activeTasks = board.tasks.filter((task) => task.status === 'running');
  useTicker(sending || activeTasks.length > 0);

  // Follow new content unless the reader has scrolled up.
  useLayoutEffect(() => {
    const node = thread.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [messages.length, sending, progress?.text, progress?.steps.length, taskCount]);
  // Grow the composer with its content, up to a few lines.
  useLayoutEffect(() => {
    const node = composer.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 168)}px`;
  }, [draft]);
  useEffect(() => {
    pinned.current = true;
  }, [supervisor?.name]);

  if (!supervisor) return null;
  const name = supervisor.name;
  const unconfigured = supervisor.model === null;
  // Hermes reports a placeholder OpenRouter model until a provider is chosen.
  const placeholder = !unconfigured && supervisor.provider === 'auto';
  const tooLong = new TextEncoder().encode(draft).length > MESSAGE_LIMIT;
  const lastTokens = [...messages].reverse().find((message) => message.tokens)?.tokens ?? null;
  const mine = conversation?.sessionId
    ? board.tasks.filter((task) => task.session_id === conversation.sessionId)
    : [];
  const created = tasksByReply(messages, mine);
  const blocked = board.tasks.filter((task) => task.status === 'blocked');
  const waiting = board.tasks.filter((task) => ['ready', 'todo'].includes(task.status ?? ''));

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || tooLong || unconfigured || hermes.busy) return;
    setDraft('');
    pinned.current = true;
    await hermes.send(text);
    void usage.reload(true);
    composer.current?.focus();
  }
  /** Sends again the request that the failed message was answering. */
  async function retry(failed: ChatMessage) {
    const index = messages.indexOf(failed);
    const request = messages
      .slice(0, index)
      .reverse()
      .find((message) => message.role === 'user');
    if (!request || hermes.busy) return;
    pinned.current = true;
    await hermes.send(request.text);
    void usage.reload(true);
  }
  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div className="sv-chat-view">
      <section className="settings-card sv-chat" aria-label="Supervisor chat">
        <header className="sv-chat-head">
          <div className="provider-icon">
            <BrainCircuit size={22} aria-hidden="true" />
          </div>
          <div>
            <h2>Talk to {name}</h2>
            <p>
              {unconfigured
                ? 'No model set up yet'
                : placeholder
                  ? 'No provider chosen yet'
                  : `${supervisor.model}${supervisor.provider ? ` via ${supervisor.provider}` : ''}`}
            </p>
          </div>
          <button
            className="button compact"
            disabled={hermes.busy || messages.length === 0}
            onClick={() => hermes.resetConversation(name)}
          >
            <MessageSquarePlus size={14} aria-hidden="true" />
            New conversation
          </button>
        </header>

        {unconfigured && (
          <div className="sv-notice" role="status">
            <TerminalSquare size={18} aria-hidden="true" />
            <p>
              {name} has no model provider yet. Setup runs Hermes's own wizard in a terminal here.
              Hermes stores any key you enter; ShellGuardian never saves or reads it.
            </p>
            <button className="button primary" onClick={() => onConfigure(name)}>
              Set up {name}
            </button>
          </div>
        )}
        {placeholder && (
          <div className="sv-notice" role="status">
            <TerminalSquare size={18} aria-hidden="true" />
            <p>
              {name} has no provider chosen, so Hermes falls back to a placeholder model that needs
              its own key. Choose the provider you are signed in to.
            </p>
            <button className="button primary" onClick={() => onChooseProvider(name)}>
              Choose provider for {name}
            </button>
          </div>
        )}

        <div
          className="sv-thread"
          ref={thread}
          role="log"
          aria-label={`Conversation with ${name}`}
          tabIndex={0}
          onScroll={(event) => {
            const node = event.currentTarget;
            pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
          }}
        >
          {messages.length === 0 && !sending && (
            <div className="sv-thread-empty">
              <strong>Ask {name} for work</strong>
              <p>
                Bigger requests become tasks on the board, where you can watch them run. Commands
                Hermes flags as dangerous are refused here, never approved for you.
              </p>
              <div className="sv-suggestions" aria-label="Example requests">
                {SUGGESTIONS.map((text) => (
                  <button
                    key={text}
                    className="sv-suggestion"
                    disabled={unconfigured}
                    onClick={() => {
                      setDraft(text);
                      composer.current?.focus();
                    }}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((message) =>
            message.role === 'agent' ? (
              <AgentMessage
                key={message.id}
                message={message}
                agent={name}
                tasks={created.get(message.id) ?? []}
                onOpenTask={onOpenTask}
              />
            ) : message.role === 'user' ? (
              <div key={message.id} className="sv-msg user">
                <span className="sv-msg-who">You</span>
                <p>{message.text}</p>
              </div>
            ) : (
              <div key={message.id} className="sv-msg error" role="alert">
                <span className="sv-msg-who">Not delivered</span>
                <p>{message.text}</p>
                <button
                  className="button compact"
                  disabled={hermes.busy}
                  onClick={() => void retry(message)}
                >
                  Try again
                </button>
              </div>
            ),
          )}
          {sending && (
            <div className="sv-msg agent live" aria-live="off">
              <span className="sv-msg-who">
                <LoaderCircle size={13} className="spin" aria-hidden="true" />
                <span role="status">
                  {progress?.stopping ? `Stopping ${name}` : `${name} is working`}
                </span>
                {/* Outside the status region, so the ticking time is not announced. */}
                <small aria-hidden="true">{formatDuration(progress?.elapsedMs ?? 0)}</small>
              </span>
              <StepList steps={progress?.steps ?? []} live />
              {progress?.text && <Markdown text={progress.text} />}
            </div>
          )}
        </div>

        <form className="sv-composer" onSubmit={(e) => void submit(e)}>
          <textarea
            ref={composer}
            aria-label={`Message ${name}`}
            placeholder={unconfigured ? `Set up ${name} to start chatting` : `Message ${name}`}
            value={draft}
            rows={1}
            disabled={unconfigured}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
          />
          <div className="sv-composer-foot">
            <span className="muted-copy">
              {tooLong
                ? 'That message is too long to send.'
                : hermes.busyWith
                  ? `Waiting for ${hermes.busyWith} to finish. One reply runs at a time.`
                  : lastTokens
                    ? `This conversation so far: ${formatCount(lastTokens.input)} tokens in, ${formatCount(lastTokens.output)} out`
                    : 'Enter to send. Shift+Enter for a new line.'}
            </span>
            {sending ? (
              <button
                type="button"
                className="button"
                // Send turns into Stop in place: ignore the first moment, so a
                // double-click on Send cannot stop the turn it just started.
                disabled={progress?.stopping || (progress?.elapsedMs ?? 0) < STOP_ARMS_AFTER_MS}
                onClick={hermes.stop}
              >
                <Square size={13} aria-hidden="true" />
                Stop
              </button>
            ) : (
              <button
                type="submit"
                className="button primary"
                disabled={unconfigured || hermes.busy || tooLong || !draft.trim()}
              >
                <Send size={14} aria-hidden="true" />
                Send
              </button>
            )}
          </div>
        </form>
      </section>

      <aside className="sv-rail" aria-label="Work and usage">
        <section className="settings-card" aria-label="Work in progress">
          <div className="section-label">
            <Activity size={18} aria-hidden="true" />
            <h3>Work in progress</h3>
            {board.loaded && <span className="count-badge">{activeTasks.length}</span>}
          </div>
          {!board.loaded &&
            (board.error ? (
              <p className="form-error" role="alert">
                The board could not be read, so running work is unavailable. {board.error}
              </p>
            ) : (
              <p className="muted-copy" role="status">
                Checking the board…
              </p>
            ))}
          {board.loaded && activeTasks.length === 0 && (
            <p className="muted-copy">
              Nothing is running.
              {waiting.length > 0 ? ` ${waiting.length} waiting.` : ''}
              {blocked.length > 0 ? ` ${blocked.length} blocked.` : ''}
            </p>
          )}
          {activeTasks.map((task) => {
            const id = String(task.id);
            const note = lastNote(running[id]);
            return (
              <button key={id} className="sv-work-item" onClick={() => onOpenTask(id)}>
                <strong>{task.title}</strong>
                <span>
                  {task.assignee ?? 'Unassigned'}
                  {task.started_at !== undefined ? ` · ${elapsed(task.started_at)}` : ''}
                </span>
                {note && <span className="sv-card-note">{note}</span>}
              </button>
            );
          })}
          {blocked.length > 0 && (
            <>
              <h4 className="sv-rail-subhead">Needs attention</h4>
              {blocked.slice(0, 3).map((task) => (
                <button
                  key={String(task.id)}
                  className="sv-work-item attention"
                  onClick={() => onOpenTask(String(task.id))}
                >
                  <strong>{task.title}</strong>
                  <span>Blocked · {task.assignee ?? 'Unassigned'}</span>
                </button>
              ))}
            </>
          )}
          <button className="text-button sv-rail-link" onClick={onShowBoard}>
            Open the board
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        </section>

        {mine.length > 0 && (
          <section className="settings-card" aria-label="Tasks from this conversation">
            <div className="section-label">
              <ListChecks size={18} aria-hidden="true" />
              <h3>From this conversation</h3>
              <span className="count-badge">{mine.length}</span>
            </div>
            {mine.map((task) => (
              <button
                key={String(task.id)}
                className="sv-work-item"
                onClick={() => onOpenTask(String(task.id))}
              >
                <strong>{task.title}</strong>
                <span className="sv-work-status">
                  <TaskStatus status={task.status} />
                  {task.assignee ?? 'Unassigned'}
                </span>
              </button>
            ))}
          </section>
        )}

        <section className="settings-card" aria-label="Usage limits">
          <div className="section-label">
            <Gauge size={18} aria-hidden="true" />
            <h3>Usage limits</h3>
          </div>
          {usage.data ? (
            <UsageMeters providers={usage.data.providers} />
          ) : usage.loading ? (
            <p className="muted-copy" role="status">
              Checking usage…
            </p>
          ) : (
            <p className="muted-copy">
              Usage is unavailable while {name}'s gateway is stopped. It starts when you send a
              message.
            </p>
          )}
        </section>
      </aside>
    </div>
  );
}
