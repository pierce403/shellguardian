import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  BrainCircuit,
  Download,
  ExternalLink,
  ShieldAlert,
  LoaderCircle,
  MessageSquarePlus,
  RefreshCw,
  Send,
  TerminalSquare,
  UserPlus,
} from 'lucide-react';
import * as api from './api';
import AgentTerminal from './AgentTerminal';
import { KanbanPanel, ProviderPanel, SchedulesPanel, SessionsPanel } from './SupervisorPanels';
import type {
  HermesDiscovery,
  HermesProfile,
  HermesTerminalTarget,
  InstallerPreview,
} from './types';

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DEFAULT_SUPERVISOR = 'guanyu';
const REFRESH_INTERVAL_MS = 60_000;
const MESSAGE_LIMIT = 16 * 1024;

const TABS = ['chat', 'agents', 'sessions', 'kanban', 'schedules'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  chat: 'Chat',
  agents: 'Agents',
  sessions: 'Sessions',
  kanban: 'Kanban',
  schedules: 'Schedules',
};

type Message = { id: number; role: 'user' | 'supervisor' | 'error'; text: string };
type Conversation = { sessionId: string | null; messages: Message[] };

/** Shared, in-memory Hermes state for the Supervisor page and sidebar status. */
export function useHermes() {
  const available = api.desktopMode || api.previewMode;
  const [discovery, setDiscovery] = useState<HermesDiscovery | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Record<string, Conversation>>({});
  const [sending, setSending] = useState(false);
  const nextId = useRef(1);

  const refresh = useCallback(async () => {
    if (!available) return;
    setLoading(true);
    try {
      setDiscovery(await api.discoverHermes());
      setError(null);
    } catch (e) {
      setError(api.errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [available]);

  useEffect(() => {
    void refresh();
    if (!available) return;
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [available, refresh]);

  const profiles = discovery?.profiles ?? [];
  const supervisor: HermesProfile | null =
    profiles.find((p) => p.name === chosen) ??
    profiles.find((p) => p.name === DEFAULT_SUPERVISOR) ??
    profiles.find((p) => p.active) ??
    profiles[0] ??
    null;

  const send = useCallback(
    async (text: string) => {
      if (!supervisor || sending) return false;
      const profile = supervisor.name;
      const current = conversations[profile] ?? { sessionId: null, messages: [] };
      const push = (role: Message['role'], body: string) => ({
        id: nextId.current++,
        role,
        text: body,
      });
      setConversations((all) => ({
        ...all,
        [profile]: { ...current, messages: [...current.messages, push('user', text)] },
      }));
      setSending(true);
      try {
        const reply = await api.hermesChat(profile, text, current.sessionId);
        setConversations((all) => {
          const latest = all[profile] ?? current;
          return {
            ...all,
            [profile]: {
              sessionId: reply.sessionId ?? latest.sessionId,
              messages: [...latest.messages, push('supervisor', reply.reply)],
            },
          };
        });
      } catch (e) {
        setConversations((all) => {
          const latest = all[profile] ?? current;
          return {
            ...all,
            [profile]: {
              ...latest,
              messages: [...latest.messages, push('error', api.errorMessage(e))],
            },
          };
        });
      } finally {
        setSending(false);
      }
      return true;
    },
    [conversations, sending, supervisor],
  );

  const resetConversation = useCallback((profile: string) => {
    setConversations((all) => ({ ...all, [profile]: { sessionId: null, messages: [] } }));
  }, []);

  return {
    available,
    discovery,
    loading,
    error,
    refresh,
    supervisor,
    choose: setChosen,
    conversation: supervisor ? conversations[supervisor.name] : undefined,
    sending,
    send,
    resetConversation,
  };
}

export type HermesController = ReturnType<typeof useHermes>;

/** Sidebar status row, mirroring the OpenShell runtime footer. */
export function HermesFoot({ hermes, onOpen }: { hermes: HermesController; onOpen: () => void }) {
  const running = hermes.supervisor?.gateway === 'running';
  const status = api.previewMode
    ? 'Sample preview'
    : !hermes.available
      ? 'Desktop app only'
      : !hermes.discovery
        ? hermes.error
          ? 'Status unavailable'
          : 'Checking…'
        : !hermes.discovery.installed
          ? 'Not detected'
          : !hermes.supervisor
            ? 'No agents yet'
            : running
              ? 'Gateway running'
              : hermes.supervisor.gateway
                ? `Gateway ${hermes.supervisor.gateway}`
                : 'Gateway status unknown';
  return (
    <button
      className="runtime-foot hermes-foot"
      onClick={onOpen}
      aria-label={`Hermes supervisor: ${status}`}
    >
      <span className={`status-dot ${running ? 'connected' : ''}`} />
      <span>
        Hermes {hermes.supervisor ? hermes.supervisor.name : ''}
        <small>{status}</small>
      </span>
      <BrainCircuit size={15} />
    </button>
  );
}

export default function Supervisor({
  hermes,
  onToast,
}: {
  hermes: HermesController;
  onToast: (message: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('chat');
  const [draft, setDraft] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [terminal, setTerminal] = useState<HermesTerminalTarget | null>(null);
  const [installer, setInstaller] = useState<InstallerPreview | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const { discovery, supervisor, conversation } = hermes;
  const messages = conversation?.messages ?? [];
  const profiles = discovery?.profiles ?? [];
  const hasDefaultSupervisor = profiles.some((p) => p.name === DEFAULT_SUPERVISOR);

  useEffect(() => {
    transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
  }, [messages.length, hermes.sending]);

  function configure(profile: string) {
    setTerminal({ hermes: 'setup', profile });
  }

  function chooseProvider(profile: string) {
    hermes.choose(profile);
    setTab('agents');
    window.setTimeout(
      () =>
        document
          .querySelector('[data-provider-panel]')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      50,
    );
  }

  function signIn(profile: string) {
    setTerminal({ hermes: 'model', profile });
  }

  function chatWith(profile: string) {
    hermes.choose(profile);
    setTab('chat');
    window.setTimeout(() => {
      composer.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      composer.current?.focus();
    }, 50);
  }

  function switchTab(next: Tab) {
    setTab(next);
    document.getElementById(`supervisor-tab-${next}`)?.focus();
  }

  async function downloadInstaller() {
    setInstallError(null);
    setDownloading(true);
    try {
      setInstaller(await api.prepareHermesInstaller());
    } catch (e) {
      setInstallError(api.errorMessage(e));
    } finally {
      setDownloading(false);
    }
  }

  function closeTerminal() {
    const finished = terminal;
    setTerminal(null);
    if (finished?.hermes === 'install') setInstaller(null);
    void hermes.refresh();
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!PROFILE_NAME.test(name)) {
      setFormError(
        'Use 1 to 64 lowercase letters, digits, hyphens, or underscores, starting with a letter or digit.',
      );
      return;
    }
    setFormError(null);
    setCreating(true);
    try {
      await api.createHermesProfile(name);
      setNewName('');
      hermes.choose(name);
      onToast(`${name} created. Configure its provider next.`);
      await hermes.refresh();
    } catch (e) {
      setFormError(api.errorMessage(e));
    } finally {
      setCreating(false);
    }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || hermes.sending) return;
    if (new TextEncoder().encode(text).length > MESSAGE_LIMIT) {
      onToast('That message is too long to send. Shorten it and try again.');
      return;
    }
    setDraft('');
    await hermes.send(text);
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  if (!hermes.available) {
    return (
      <section className="settings-card supervisor-empty">
        <BrainCircuit size={24} />
        <div>
          <h3>Supervisor needs the desktop app</h3>
          <p className="muted-copy">
            ShellGuardian talks to a local Hermes agent from the desktop app only. Explore the
            sample preview to see how it works.
          </p>
        </div>
      </section>
    );
  }

  const unconfigured = supervisor !== null && supervisor.model === null;
  // Hermes reports a placeholder OpenRouter model until a provider is chosen.
  const placeholder = supervisor !== null && !unconfigured && supervisor.provider === 'auto';

  return (
    <div className="supervisor-layout">
      {api.previewMode && (
        <p className="muted-copy">
          Sample preview only. No Hermes agent is contacted and replies are illustrative.
        </p>
      )}
      {hermes.error && (
        <p className="form-error" role="alert">
          {hermes.error}
        </p>
      )}

      {discovery && !discovery.installed && (
        <section className="settings-card" aria-label="Install Hermes">
          <div className="settings-heading">
            <div className="provider-icon">
              <BrainCircuit size={23} />
            </div>
            <div>
              <h3>Set up a supervisor</h3>
              <p>Hermes is not installed on this computer.</p>
            </div>
          </div>
          <p className="muted-copy">
            ShellGuardian can download Hermes's official installer, show it to you, and run it here
            once you approve. It installs into your home folder (~/.hermes and ~/.local/bin) and may
            ask for your password to add one system library. Then create a supervisor agent and
            configure its provider.
          </p>
          {installer && (
            <section className="installer-review" aria-label="Installer review">
              <div className="installer-warning">
                <ShieldAlert size={18} />
                <p>
                  This script comes from Hermes's website and is not signed. ShellGuardian will run
                  only this exact file. Review it if you are unsure.
                </p>
              </div>
              <div className="settings-row">
                <span>Source</span>
                <code>{installer.url}</code>
              </div>
              <div className="settings-row">
                <span>SHA-256</span>
                <code>{installer.sha256}</code>
              </div>
              <div className="settings-row">
                <span>Size</span>
                <strong>{installer.size.toLocaleString()} bytes</strong>
              </div>
              <details className="hermes-profiles">
                <summary>Read the installer script</summary>
                <pre>{installer.script}</pre>
              </details>
            </section>
          )}
          {installError && (
            <p className="form-error" role="alert">
              {installError}
            </p>
          )}
          <div className="settings-buttons">
            {installer ? (
              <button
                className="button primary"
                onClick={() => setTerminal({ hermes: 'install', sha256: installer.sha256 })}
              >
                <TerminalSquare size={16} />
                Run installer
              </button>
            ) : (
              <button
                className="button primary"
                disabled={downloading}
                onClick={() => void downloadInstaller()}
              >
                {downloading ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
                Download installer
              </button>
            )}
            <button
              className="button"
              onClick={() => {
                void api.openHermesInstallGuide().catch((e) => onToast(api.errorMessage(e)));
              }}
            >
              Installation guide
              <ExternalLink size={15} />
            </button>
            <button
              className="button"
              disabled={hermes.loading}
              onClick={() => void hermes.refresh()}
            >
              {hermes.loading ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <RefreshCw size={16} />
              )}
              Refresh
            </button>
          </div>
        </section>
      )}

      {discovery?.installed && profiles.length > 0 && (
        <div className="supervisor-tabbar">
          <div className="detail-tabs supervisor-tabs" role="tablist" aria-label="Supervisor views">
            {TABS.map((name) => (
              <button
                id={`supervisor-tab-${name}`}
                key={name}
                role="tab"
                aria-selected={tab === name}
                tabIndex={tab === name ? 0 : -1}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                  event.preventDefault();
                  const step = event.key === 'ArrowRight' ? 1 : TABS.length - 1;
                  switchTab(TABS[(TABS.indexOf(name) + step) % TABS.length]);
                }}
                onClick={() => setTab(name)}
              >
                {TAB_LABELS[name]}
              </button>
            ))}
          </div>
          {profiles.length > 1 && tab !== 'kanban' && (
            <label className="supervisor-select-label">
              Agent
              <select
                className="supervisor-select"
                aria-label="Supervisor agent"
                value={supervisor?.name ?? ''}
                disabled={hermes.sending}
                onChange={(e) => hermes.choose(e.target.value)}
              >
                {profiles.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {discovery?.installed && profiles.length > 0 && tab === 'chat' && (
        <section className="settings-card supervisor-chat" aria-label="Supervisor chat">
          <div className="settings-heading">
            <div className="provider-icon">
              <BrainCircuit size={23} />
            </div>
            <div>
              <h3>{supervisor ? `Talk to ${supervisor.name}` : 'No Hermes agents yet'}</h3>
              <p>
                {supervisor
                  ? `${supervisor.model ?? 'No model configured'}${supervisor.provider ? ` via ${supervisor.provider}` : ''} · gateway ${supervisor.gateway ?? 'unknown'}`
                  : 'Create a supervisor agent below.'}
              </p>
            </div>
          </div>

          {unconfigured && (
            <div className="supervisor-notice" role="status">
              <p>
                {supervisor.name} has no model provider yet. Configure runs Hermes's own setup here;
                Hermes stores any key you enter, and ShellGuardian never saves or reads it.
              </p>
              <button className="button primary" onClick={() => void configure(supervisor.name)}>
                <TerminalSquare size={16} />
                Configure {supervisor.name}
              </button>
            </div>
          )}
          {placeholder && (
            <div className="supervisor-notice" role="status">
              <p>
                {supervisor.name} has no provider chosen, so Hermes falls back to its placeholder
                default ({supervisor.model} on OpenRouter), which needs an OpenRouter key. Choose
                the provider you signed in to, such as OpenAI Codex.
              </p>
              <button className="button primary" onClick={() => chooseProvider(supervisor.name)}>
                <TerminalSquare size={16} />
                Choose provider for {supervisor.name}
              </button>
            </div>
          )}

          {supervisor && (
            <>
              <div className="supervisor-transcript" ref={transcript} aria-live="polite">
                {messages.length === 0 && !hermes.sending && (
                  <p className="muted-copy">
                    Ask {supervisor.name} about your agents. Replies come from Hermes on this
                    computer. Commands Hermes flags as dangerous are blocked here, never
                    auto-approved.
                  </p>
                )}
                {messages.map((m) => (
                  <div key={m.id} className={`supervisor-message ${m.role}`}>
                    <span className="supervisor-role">
                      {m.role === 'user'
                        ? 'You'
                        : m.role === 'error'
                          ? 'Not delivered'
                          : supervisor.name}
                    </span>
                    <p>{m.text}</p>
                  </div>
                ))}
                {hermes.sending && (
                  <div className="supervisor-message supervisor pending" role="status">
                    <LoaderCircle size={14} className="spin" />
                    {supervisor.name} is working…
                  </div>
                )}
              </div>
              <form className="supervisor-compose" onSubmit={(e) => void submit(e)}>
                <textarea
                  ref={composer}
                  aria-label={`Message ${supervisor.name}`}
                  placeholder={
                    unconfigured
                      ? `Configure ${supervisor.name} to start chatting`
                      : `Message ${supervisor.name}`
                  }
                  value={draft}
                  rows={2}
                  disabled={unconfigured}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKey}
                />
                <div className="supervisor-compose-actions">
                  <button
                    type="submit"
                    className="button primary"
                    disabled={unconfigured || hermes.sending || !draft.trim()}
                  >
                    <Send size={15} />
                    Send
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={hermes.sending || messages.length === 0}
                    onClick={() => hermes.resetConversation(supervisor.name)}
                  >
                    <MessageSquarePlus size={15} />
                    New conversation
                  </button>
                </div>
              </form>
            </>
          )}
        </section>
      )}

      {discovery?.installed && (tab === 'agents' || profiles.length === 0) && (
        <section className="settings-card" aria-label="Hermes agents">
          <div className="section-label">
            <UserPlus size={20} />
            <h3>Agents</h3>
          </div>
          {profiles.map((p) => (
            <div
              className={`settings-row${p.name === supervisor?.name ? ' selected' : ''}`}
              key={p.name}
            >
              <span>
                {p.name}
                {p.active ? ' (active)' : ''}
                {p.name === supervisor?.name ? ' · selected' : ''}
              </span>
              <span className="supervisor-row-actions">
                <strong>
                  {p.model === null
                    ? 'Not configured'
                    : p.provider === 'auto'
                      ? 'No provider chosen'
                      : `${p.model}${p.provider ? ` via ${p.provider}` : ''}`}
                </strong>
                <button
                  className="button compact"
                  aria-label={`Chat with ${p.name}`}
                  onClick={() => chatWith(p.name)}
                >
                  Chat
                </button>
                <button
                  className="button compact"
                  aria-label={`Choose provider for ${p.name}`}
                  onClick={() => chooseProvider(p.name)}
                >
                  Provider
                </button>
                <button className="button compact" onClick={() => void configure(p.name)}>
                  Configure
                </button>
              </span>
            </div>
          ))}
          {profiles.length === 0 && discovery.profileText.trim() && (
            <pre className="hermes-profiles">{discovery.profileText}</pre>
          )}
          <form className="supervisor-create" onSubmit={(e) => void create(e)}>
            <label className="field-label" htmlFor="new-hermes-agent">
              New agent
            </label>
            <div className="workspace-form">
              <input
                id="new-hermes-agent"
                value={newName}
                placeholder={hasDefaultSupervisor ? 'agent-name' : DEFAULT_SUPERVISOR}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setNewName(e.target.value)}
              />
              <button className="button primary" disabled={creating || !newName.trim()}>
                {creating ? <LoaderCircle size={16} className="spin" /> : <UserPlus size={16} />}
                Create agent
              </button>
            </div>
            {!hasDefaultSupervisor && (
              <button
                type="button"
                className="link-button"
                onClick={() => setNewName(DEFAULT_SUPERVISOR)}
              >
                Use the suggested supervisor name, {DEFAULT_SUPERVISOR}
              </button>
            )}
            <p className="muted-copy">
              Creates an empty Hermes profile. Existing profiles, credentials, and settings are
              never copied or changed.
            </p>
            {formError && (
              <p className="form-error" role="alert">
                {formError}
              </p>
            )}
          </form>
          <div className="settings-buttons">
            <button
              className="button"
              disabled={hermes.loading}
              onClick={() => void hermes.refresh()}
            >
              {hermes.loading ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <RefreshCw size={16} />
              )}
              Refresh
            </button>
          </div>
        </section>
      )}

      {discovery?.installed && supervisor && tab === 'agents' && (
        <div data-provider-panel>
          <ProviderPanel
            key={supervisor.name}
            profile={supervisor.name}
            onChanged={() => void hermes.refresh()}
            onSignIn={signIn}
          />
        </div>
      )}
      {discovery?.installed && supervisor && tab === 'sessions' && (
        <SessionsPanel
          key={supervisor.name}
          profile={supervisor.name}
          onStarted={() => void hermes.refresh()}
        />
      )}
      {discovery?.installed && profiles.length > 0 && tab === 'kanban' && (
        <KanbanPanel profiles={profiles.map((p) => p.name)} />
      )}
      {discovery?.installed && supervisor && tab === 'schedules' && (
        <SchedulesPanel
          key={supervisor.name}
          profile={supervisor.name}
          onStarted={() => void hermes.refresh()}
        />
      )}

      {!discovery && !hermes.error && (
        <p className="muted-copy" role="status">
          Checking for Hermes…
        </p>
      )}
      {terminal && <AgentTerminal target={terminal} onClose={closeTerminal} />}
    </div>
  );
}
