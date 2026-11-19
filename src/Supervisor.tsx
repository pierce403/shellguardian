// The Supervisor page: ask a local Hermes agent for work and watch it happen.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BrainCircuit,
  Download,
  ExternalLink,
  LoaderCircle,
  Play,
  RefreshCw,
  ShieldAlert,
  TerminalSquare,
} from 'lucide-react';
import * as api from './api';
import AgentTerminal from './AgentTerminal';
import { AgentsTab } from './supervisor/AgentsTab';
import { BoardTab } from './supervisor/BoardTab';
import { ChatTab } from './supervisor/ChatTab';
import { SchedulesTab } from './supervisor/SchedulesTab';
import { SessionsTab } from './supervisor/SessionsTab';
import { TaskDrawer } from './supervisor/TaskDrawer';
import { Select } from './supervisor/parts';
import { useBoard, useLoad, useRunningDetails, useVisibleInterval } from './supervisor/hooks';
import { useHermes, type Hermes } from './supervisor/useHermes';
import type { HermesModelOptions, HermesTerminalTarget, InstallerPreview } from './types';

export { useHermes };

const TABS = ['chat', 'board', 'agents', 'sessions', 'schedules'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  chat: 'Chat',
  board: 'Board',
  agents: 'Agents',
  sessions: 'Sessions',
  schedules: 'Schedules',
};
const USAGE_REFRESH_MS = 5 * 60_000;

/** Sidebar status: the supervisor's Hermes gateway, beside OpenShell's. */
export function HermesFoot({ hermes, onOpen }: { hermes: Hermes; onOpen: () => void }) {
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

/** Review-then-run flow for Hermes's official installer. */
function InstallCard({
  hermes,
  onRun,
  installer,
  onInstaller,
  onToast,
}: {
  hermes: Hermes;
  onRun: (sha256: string) => void;
  installer: InstallerPreview | null;
  onInstaller: (preview: InstallerPreview | null) => void;
  onToast: (message: string) => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function download() {
    setError(null);
    setDownloading(true);
    try {
      onInstaller(await api.prepareHermesInstaller());
    } catch (e) {
      setError(api.errorMessage(e));
    } finally {
      setDownloading(false);
    }
  }
  return (
    <section className="settings-card sv-install" aria-label="Install Hermes">
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
        ShellGuardian can download Hermes's official installer, show it to you, and run it here once
        you approve. It installs into your home folder (~/.hermes and ~/.local/bin) and may ask for
        your password to add one system library. Then create a supervisor agent and configure its
        provider.
      </p>
      {installer && (
        <section className="installer-review" aria-label="Installer review">
          <div className="installer-warning">
            <ShieldAlert size={18} />
            <p>
              This script comes from Hermes's website and is not signed. ShellGuardian will run only
              this exact file. Review it if you are unsure.
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
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="settings-buttons">
        {installer ? (
          <button className="button primary" onClick={() => onRun(installer.sha256)}>
            <TerminalSquare size={16} />
            Run installer
          </button>
        ) : (
          <button className="button primary" disabled={downloading} onClick={() => void download()}>
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
        <button className="button" disabled={hermes.loading} onClick={() => void hermes.refresh()}>
          {hermes.loading ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}
          Refresh
        </button>
      </div>
    </section>
  );
}

export default function Supervisor({
  hermes,
  onToast,
}: {
  hermes: Hermes;
  onToast: (message: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('chat');
  const [terminal, setTerminal] = useState<HermesTerminalTarget | null>(null);
  const [installer, setInstaller] = useState<InstallerPreview | null>(null);
  const [archived, setArchived] = useState(false);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const { discovery, supervisor, profiles } = hermes;
  const installed = discovery?.installed === true;
  const name = supervisor?.name ?? null;

  // The board and the selected agent's usage are shared by several tabs.
  const board = useBoard(archived, installed);
  const running = useRunningDetails(board.active, board.tasks, board.version);
  const usage = useLoad<HermesModelOptions>(
    () =>
      name && installed
        ? api.hermesModelOptions(name, false)
        : Promise.reject(new Error('No agent selected.')),
    [name, installed],
  );
  useVisibleInterval(() => usage.reload(true), USAGE_REFRESH_MS, Boolean(name && installed));
  const gatewayRunning = supervisor?.gateway === 'running';
  // Usage needs the gateway: fetch it again when the gateway comes up (the
  // first fetch for an agent is useLoad's own).
  const reloadUsage = usage.reload;
  const wasRunning = useRef(gatewayRunning);
  useEffect(() => {
    if (gatewayRunning && !wasRunning.current) void reloadUsage(true);
    wasRunning.current = gatewayRunning;
  }, [gatewayRunning, reloadUsage]);

  const refreshHermes = hermes.refresh;
  const refreshBoard = board.refresh;
  const refreshAll = useCallback(async () => {
    await refreshHermes();
    void reloadUsage(true);
    void refreshBoard();
  }, [refreshBoard, refreshHermes, reloadUsage]);

  function closeTerminal() {
    const finished = terminal;
    setTerminal(null);
    if (finished?.hermes === 'install') setInstaller(null);
    void refreshAll();
  }
  function showAgent(profile: string) {
    hermes.choose(profile);
    setTab('agents');
    window.setTimeout(
      () =>
        document
          .querySelector('[data-agent-detail]')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      60,
    );
  }
  async function startGateway() {
    if (!name) return;
    setStarting(true);
    try {
      const status = await api.startHermesGateway(name);
      if (status.state !== 'ready')
        onToast(status.message ?? `${name}'s gateway is ${status.state}.`);
    } catch (e) {
      onToast(api.errorMessage(e));
    } finally {
      setStarting(false);
      void refreshAll();
    }
  }
  function switchTab(next: Tab) {
    setTab(next);
    document.getElementById(`supervisor-tab-${next}`)?.focus();
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

  const activeCount = board.tasks.filter((task) => task.status === 'running').length;
  // With no agents yet, the only useful view is the one that creates one.
  const view: Tab = profiles.length === 0 ? 'agents' : tab;

  return (
    <div className="sv-page">
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
      {!discovery && !hermes.error && (
        <p className="muted-copy" role="status">
          Checking for Hermes…
        </p>
      )}

      {discovery && !discovery.installed && (
        <InstallCard
          hermes={hermes}
          installer={installer}
          onInstaller={setInstaller}
          onRun={(sha256) => setTerminal({ hermes: 'install', sha256 })}
          onToast={onToast}
        />
      )}

      {installed && (
        <div className="sv-tabbar">
          <div className="detail-tabs sv-tabs" role="tablist" aria-label="Supervisor views">
            {TABS.map((entry) => (
              <button
                id={`supervisor-tab-${entry}`}
                key={entry}
                role="tab"
                aria-selected={view === entry}
                aria-controls="supervisor-panel"
                tabIndex={view === entry ? 0 : -1}
                disabled={profiles.length === 0 && entry !== 'agents'}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                  event.preventDefault();
                  const step = event.key === 'ArrowRight' ? 1 : TABS.length - 1;
                  switchTab(TABS[(TABS.indexOf(entry) + step) % TABS.length]);
                }}
                onClick={() => setTab(entry)}
              >
                {TAB_LABELS[entry]}
                {entry === 'board' && activeCount > 0 && (
                  <span className="count-badge" aria-label={`${activeCount} running`}>
                    {activeCount}
                  </span>
                )}
              </button>
            ))}
          </div>
          {supervisor && (
            <div className="sv-agent-bar">
              {profiles.length > 1 && (
                <label className="sv-inline-field">
                  Agent
                  <Select
                    aria-label="Supervisor agent"
                    value={supervisor.name}
                    disabled={hermes.busy}
                    onChange={(e) => hermes.choose(e.target.value)}
                  >
                    {profiles.map((profile) => (
                      <option key={profile.name} value={profile.name}>
                        {profile.name}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              {gatewayRunning ? (
                <span
                  className="status good"
                  aria-label={`${supervisor.name}'s gateway is running`}
                >
                  <span className="status-dot" />
                  Gateway running
                </span>
              ) : (
                <button
                  className="button compact"
                  disabled={starting}
                  title="Tasks and schedules only run while the gateway is running"
                  onClick={() => void startGateway()}
                >
                  {starting ? (
                    <LoaderCircle size={14} className="spin" aria-hidden="true" />
                  ) : (
                    <Play size={14} aria-hidden="true" />
                  )}
                  Start gateway
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {installed && (
        <div
          id="supervisor-panel"
          role="tabpanel"
          aria-labelledby={`supervisor-tab-${view}`}
          className="sv-panel"
        >
          {view === 'chat' && supervisor && (
            <ChatTab
              hermes={hermes}
              board={board}
              running={running}
              usage={usage}
              onOpenTask={setOpenTask}
              onShowBoard={() => setTab('board')}
              onConfigure={(profile) => setTerminal({ hermes: 'setup', profile })}
              onChooseProvider={showAgent}
            />
          )}
          {view === 'board' && (
            <BoardTab
              board={board}
              profiles={profiles}
              running={running}
              archived={archived}
              onArchived={setArchived}
              selected={openTask}
              onOpen={setOpenTask}
              onGatewayChanged={() => void refreshAll()}
            />
          )}
          {view === 'agents' && (
            <AgentsTab
              hermes={hermes}
              onChat={(profile) => {
                hermes.choose(profile);
                setTab('chat');
              }}
              onConfigure={(profile) => setTerminal({ hermes: 'setup', profile })}
              onSignIn={(profile) => setTerminal({ hermes: 'model', profile })}
              onToast={onToast}
            />
          )}
          {view === 'sessions' && supervisor && (
            <SessionsTab
              key={supervisor.name}
              profile={supervisor.name}
              gatewayRunning={gatewayRunning}
              onGatewayChanged={() => void refreshAll()}
            />
          )}
          {view === 'schedules' && supervisor && (
            <SchedulesTab
              key={supervisor.name}
              profile={supervisor.name}
              gatewayRunning={gatewayRunning}
              onGatewayChanged={() => void refreshAll()}
            />
          )}
        </div>
      )}

      {openTask && board.active && (
        <TaskDrawer
          board={board.active}
          id={openTask}
          version={board.version}
          profiles={profiles}
          onClose={() => setOpenTask(null)}
          onChanged={() => void board.refresh()}
          onGatewayChanged={() => void refreshAll()}
        />
      )}
      {terminal && <AgentTerminal target={terminal} onClose={closeTerminal} />}
    </div>
  );
}
