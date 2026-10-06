import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Code2,
  Cpu,
  ExternalLink,
  FileLock2,
  Folder,
  Globe2,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  Shield,
  ShieldCheck,
  Terminal,
  WifiOff,
  X,
  type LucideIcon,
} from 'lucide-react';
import * as api from './api';
import AppUpdates, { useAppUpdates } from './AppUpdates';
import type {
  Agent,
  AgentDetail,
  Json,
  PolicyEdit,
  Provider,
  Scope,
  Selection,
  Snapshot,
  UpdateInfo,
  AppUpdateStatus,
} from './types';

type Page = 'overview' | 'agents' | 'credentials' | 'activity' | 'openshell';
type DetailTab = 'permissions' | 'credentials' | 'activity';
type Pending = {
  title: string;
  description: string;
  target: string;
  scope: Scope;
  label: string;
  danger?: boolean;
  before?: string;
  after?: string;
  execute: () => Promise<string>;
};

const ready = (phase: string) => ['ready', 'running'].includes(phase.toLowerCase());
const stopped = (phase: string) => phase.toLowerCase() === 'stopped';
const record = (value: Json | undefined): Record<string, Json> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const values = (value: Json | undefined): Json[] => (Array.isArray(value) ? value : []);
const textValue = (value: Json | undefined, fallback = '') =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;

function Status({ phase }: { phase: string }) {
  return (
    <span className={`status ${ready(phase) ? 'good' : stopped(phase) ? 'muted' : 'attention'}`}>
      <span className="status-dot" />
      {phase}
    </span>
  );
}

function IconButton({
  icon: Icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="icon-button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={18} aria-hidden="true" />
    </button>
  );
}

function useSnapshot(selection: Selection) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const previousScope = useRef('');
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const signature = `${selection.gateway}/${selection.workspace}`;
    if (previousScope.current !== signature) {
      setData(null);
      previousScope.current = signature;
    }
    async function load() {
      if (inFlight) return;
      inFlight = true;
      setBusy(true);
      try {
        const snapshot = await api.getSnapshot(selection);
        if (alive) {
          setData(snapshot);
          setError(null);
        }
      } catch (error) {
        if (alive) setError(api.errorMessage(error));
      } finally {
        inFlight = false;
        if (alive) setBusy(false);
      }
    }
    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 15_000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [selection.gateway, selection.workspace, revision]);
  return { data, busy, error, refresh: useCallback(() => setRevision((value) => value + 1), []) };
}

function Modal({
  children,
  className = '',
  label,
  onClose,
  busy = false,
}: {
  children: ReactNode;
  className?: string;
  label: string;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) {
          const box = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            onClose();
        }
      }}
    >
      {children}
    </dialog>
  );
}

function UsageCoverage({ compact = false }: { compact?: boolean }) {
  return (
    <section className={`coverage ${compact ? 'compact' : ''}`}>
      <div className="coverage-icon">
        <Cpu size={21} aria-hidden="true" />
      </div>
      <div>
        <h3>Usage, without guesswork</h3>
        <p>
          OpenShell 0.1.2 does not expose inference token totals or credential-use counters through
          its CLI. Those measurements will appear here when OpenShell provides them.
        </p>
      </div>
      <span className="small-tag">Not reported</span>
    </section>
  );
}

function AgentCard({ agent, onOpen }: { agent: Agent; onOpen: () => void }) {
  const tones = ['sage', 'lavender', 'sand', 'blue'];
  const tone = tones[agent.name.length % tones.length];
  return (
    <article className="agent-card">
      <div className="agent-card-top">
        <div className={`agent-avatar ${tone}`}>
          <Bot size={25} aria-hidden="true" />
        </div>
        <Status phase={agent.phase} />
      </div>
      <h3>{agent.name}</h3>
      <div className="agent-meta">
        <Folder size={13} aria-hidden="true" />
        {agent.workspace || 'default'}
        <span>·</span>Policy{' '}
        {agent.current_policy_version > 0 ? `v${agent.current_policy_version}` : 'not reported'}
      </div>
      <div className="agent-card-rule" />
      <div className="agent-card-bottom">
        <span>
          <ShieldCheck size={16} aria-hidden="true" />
          OpenShell sandbox
        </span>
        <button onClick={onOpen} aria-label={`Inspect ${agent.name}`} title="Inspect access">
          <ArrowRight size={19} aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}

function AgentEmpty({
  failed,
  connected,
  onPreview,
}: {
  failed: boolean;
  connected: boolean;
  onPreview: () => void;
}) {
  const browser = !api.desktopMode && !api.previewMode;
  return (
    <div className="empty-state">
      <div className="empty-art">
        <Shield size={44} strokeWidth={1.3} aria-hidden="true" />
        <Bot size={24} aria-hidden="true" />
      </div>
      <h3>
        {browser
          ? 'Your agents belong here.'
          : failed
            ? 'Agent inventory is unavailable'
            : connected
              ? 'A quiet place to start.'
              : 'Connect your OpenShell gateway'}
      </h3>
      <p>
        {browser
          ? 'Open the ShellGuardian desktop app to connect to your installed OpenShell environment. You can explore the interface with clearly labeled sample agents.'
          : failed
            ? 'OpenShell could not return the agent inventory. Check the connection details above, then refresh.'
            : connected
              ? 'This workspace has no sandboxes yet. Create one with OpenShell and it will appear here automatically.'
              : 'Register a gateway with OpenShell, then refresh. ShellGuardian uses the access you already configured.'}
      </p>
      {browser ? (
        <button className="button primary" onClick={onPreview}>
          Explore sample preview
          <ArrowRight size={16} />
        </button>
      ) : (
        <code>openshell {connected ? 'sandbox create' : 'gateway list'}</code>
      )}
    </div>
  );
}

function CredentialCard({ provider, onInspect }: { provider: Provider; onInspect?: () => void }) {
  const expirations = Object.values(provider.credential_expires_at_ms);
  const expired = expirations.some((time) => time > 0 && time < Date.now());
  return (
    <article className="provider-card">
      <div className="provider-heading">
        <div className="provider-icon">
          <KeyRound size={22} />
        </div>
        <div>
          <h3>{provider.name}</h3>
          <span className="provider-type">{provider.type} provider</span>
        </div>
        <span className={`small-tag ${expired ? 'warning' : ''}`}>
          {expired ? 'Expired credential' : 'Managed by OpenShell'}
        </span>
      </div>
      <div className="credential-label">Credential names</div>
      <div className="key-list">
        {provider.credential_keys.length ? (
          provider.credential_keys.map((key) => (
            <span key={key}>
              <LockKeyhole size={12} />
              {key}
            </span>
          ))
        ) : (
          <span>No credential keys reported</span>
        )}
      </div>
      <div className="provider-foot">
        <span>
          Usage count <strong>Not reported</strong>
        </span>
        {onInspect && (
          <button className="text-button" onClick={onInspect}>
            Manage agent access
            <ArrowRight size={14} />
          </button>
        )}
      </div>
    </article>
  );
}

function PermissionView({ detail, onEdit }: { detail: AgentDetail; onEdit: () => void }) {
  const policy = record(detail.policy);
  const filesystem = record(policy.filesystem_policy);
  const network = Object.entries(record(policy.network_policies));
  const process = record(policy.process);
  return (
    <>
      <div className="detail-note">
        <ShieldCheck size={17} />
        <span>
          Effective access from OpenShell, including attached providers and gateway policy.
        </span>
      </div>
      <section className="permission-section">
        <div className="section-label">
          <Globe2 size={17} />
          <h3>Network destinations</h3>
          <span className="count-badge">
            {network.reduce((sum, [, rule]) => sum + values(record(rule).endpoints).length, 0)}
          </span>
        </div>
        {network.length ? (
          network.map(([name, rule]) => (
            <div className="network-rule" key={name}>
              <div className="rule-name">{name.replace(/_/g, ' ')}</div>
              {values(record(rule).endpoints).map((item, index) => {
                const endpoint = record(item);
                const inspected = !!endpoint.protocol && endpoint.protocol !== 'tcp';
                const enforced = !inspected || endpoint.enforcement === 'enforce';
                return (
                  <div className="endpoint" key={index}>
                    <Globe2 size={15} />
                    <div>
                      <strong>{textValue(endpoint.host, 'Address allowlist')}</strong>
                      <span>
                        Port{' '}
                        {textValue(
                          endpoint.port,
                          values(endpoint.ports)
                            .map((value) => textValue(value))
                            .join(', ') || 'not specified',
                        )}{' '}
                        · {textValue(endpoint.access, 'Explicit rules')}
                      </span>
                    </div>
                    <span className={`access-label ${enforced ? '' : 'audit'}`}>
                      {inspected ? (enforced ? 'Enforced' : 'Audit only') : 'Endpoint allowed'}
                    </span>
                  </div>
                );
              })}
            </div>
          ))
        ) : (
          <p className="muted-copy">No explicit network entries were returned.</p>
        )}
      </section>
      <section className="permission-section">
        <div className="section-label">
          <Folder size={17} />
          <h3>Files & folders</h3>
          <span className="small-tag">Fixed at creation</span>
        </div>
        {(['read_only', 'read_write'] as const).map((key) => (
          <div className="path-group" key={key}>
            <span>{key === 'read_only' ? 'Read access' : 'Read & write'}</span>
            <div>
              {values(filesystem[key]).length ? (
                values(filesystem[key]).map((path, index) => (
                  <code key={index}>{textValue(path)}</code>
                ))
              ) : (
                <span className="muted-copy">No explicit paths reported</span>
              )}
            </div>
          </div>
        ))}
        {filesystem.include_workdir === true && (
          <p className="muted-copy">The sandbox working directory is also included.</p>
        )}
      </section>
      <section className="permission-section">
        <div className="section-label">
          <Terminal size={17} />
          <h3>Process identity</h3>
          <span className="small-tag">Fixed at creation</span>
        </div>
        <div className="identity-row">
          <span>
            User <code>{textValue(process.run_as_user, 'Driver default')}</code>
          </span>
          <span>
            Group <code>{textValue(process.run_as_group, 'Driver default')}</code>
          </span>
        </div>
      </section>
      <section className="permission-section">
        <div className="section-label">
          <Cpu size={17} />
          <h3>Resources & inference</h3>
        </div>
        <p className="muted-copy">
          CPU, memory, and token usage are not reported by this CLI. Sandbox readiness does not
          indicate whether an agent process is working.
        </p>
      </section>
      <button className="button full" onClick={onEdit} disabled={detail.policySource !== 'sandbox'}>
        <Code2 size={16} />
        Edit base network policy
      </button>
      {detail.policySource !== 'sandbox' && (
        <p className="muted-copy footnote">
          This sandbox inherits gateway policy. Manage that policy through OpenShell.
        </p>
      )}
    </>
  );
}

function AgentDrawer({
  agent,
  scope,
  providers,
  initialTab,
  onClose,
  onRequest,
  refreshRevision,
  mutationBusy,
}: {
  agent: Agent;
  scope: Scope;
  providers: Provider[];
  initialTab: DetailTab;
  onClose: () => void;
  onRequest: (action: Pending) => void;
  refreshRevision: number;
  mutationBusy: boolean;
}) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState(false);
  const [policyJson, setPolicyJson] = useState('');
  const [editorError, setEditorError] = useState<string | null>(null);
  const [providerName, setProviderName] = useState('');
  const [logs, setLogs] = useState<string | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsRetry, setLogsRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setEditing(false);
    void api
      .getDetail(scope, agent.name)
      .then((detail) => {
        if (alive) {
          setDetail(detail);
          setPolicyJson(JSON.stringify(detail.basePolicy, null, 2));
        }
      })
      .catch((error) => {
        if (alive) {
          setDetail(null);
          setError(api.errorMessage(error));
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [scope.gateway, scope.workspace, agent.name, retry, refreshRevision]);
  useEffect(() => {
    if (tab !== 'activity') return;
    let alive = true;
    setLogs(null);
    setLogsError(null);
    setLogsLoading(true);
    void api
      .getLogs(scope, agent.name)
      .then((logs) => {
        if (alive) setLogs(logs);
      })
      .catch((error) => {
        if (alive) setLogsError(api.errorMessage(error));
      })
      .finally(() => {
        if (alive) setLogsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tab, scope.gateway, scope.workspace, agent.name, logsRetry, refreshRevision]);
  const currentAgent = detail?.agent ?? agent;
  function lifecycle() {
    const action = stopped(currentAgent.phase) ? 'start' : 'stop';
    onRequest({
      title: `${action === 'stop' ? 'Stop' : 'Start'} this sandbox?`,
      description:
        action === 'stop'
          ? 'OpenShell will stop the sandbox and preserve its workspace. Running tasks and port forwards may be interrupted.'
          : 'OpenShell will start the sandbox and wait for readiness. This does not verify that an agent process is running.',
      scope,
      target: agent.name,
      label: action === 'stop' ? 'Stop sandbox' : 'Start sandbox',
      danger: action === 'stop',
      execute: () => api.changeState(scope, agent.name, action),
    });
  }
  function providerChange(name: string, action: 'attach' | 'detach') {
    onRequest({
      title: `${action === 'attach' ? 'Grant' : 'Revoke'} provider access?`,
      description: `OpenShell will ${action} “${name}” ${action === 'attach' ? 'to' : 'from'} this sandbox and wait for acknowledgement. The change applies to new processes; existing processes can retain their old environment.`,
      scope,
      target: agent.name,
      label: action === 'attach' ? 'Grant access' : 'Revoke access',
      danger: action === 'detach',
      execute: () => api.changeProvider(scope, agent.name, name, action),
    });
  }
  function reviewPolicy() {
    if (!detail) return;
    try {
      const value = JSON.parse(policyJson) as Json;
      if (!value || Array.isArray(value) || typeof value !== 'object')
        throw new Error('Use a JSON object for the policy.');
      if (new TextEncoder().encode(policyJson).length > 65536)
        throw new Error('The policy exceeds the 64 KiB limit.');
      if (JSON.stringify(value) === JSON.stringify(detail.basePolicy))
        throw new Error('Make a change before reviewing.');
      setEditorError(null);
      const edit: PolicyEdit = {
        scope,
        name: agent.name,
        expectedHash: detail.policyHash,
        expectedRevision: detail.configRevision,
        policyJson,
      };
      onRequest({
        title: 'Apply this network policy?',
        description:
          'OpenShell will validate and load this base policy. Provider and global composition stay under OpenShell. Filesystem and process changes require sandbox recreation.',
        scope,
        target: agent.name,
        label: 'Apply policy',
        before: JSON.stringify(detail.basePolicy, null, 2),
        after: JSON.stringify(value, null, 2),
        execute: () => api.applyPolicy(edit),
      });
    } catch (error) {
      setEditorError(api.errorMessage(error));
    }
  }
  const availableProviders = providers.filter(
    (provider) => !detail?.providers.some((attached) => attached.name === provider.name),
  );
  return (
    <Modal
      className="drawer"
      label={`Agent details for ${agent.name}`}
      onClose={onClose}
      busy={mutationBusy}
    >
      <div className="drawer-header">
        <div className="eyebrow">AGENT DETAILS</div>
        <IconButton
          icon={X}
          label="Close agent details"
          onClick={onClose}
          disabled={mutationBusy}
        />
      </div>
      <div className="drawer-identity">
        <div className="agent-avatar sage">
          <Bot size={29} />
        </div>
        <h2>{agent.name}</h2>
        <Status phase={currentAgent.phase} />
      </div>
      <div className="drawer-location">
        <Server size={14} />
        {scope.gateway}
        <span>/</span>
        {scope.workspace}
      </div>
      <div className="drawer-created">
        Created <time>{currentAgent.created_at || 'Not reported'}</time>
      </div>
      <div className="drawer-actions">
        <button
          className={`button ${stopped(currentAgent.phase) ? 'primary' : ''}`}
          onClick={lifecycle}
          disabled={
            mutationBusy || loading || (!ready(currentAgent.phase) && !stopped(currentAgent.phase))
          }
        >
          {stopped(currentAgent.phase) ? <Play size={15} /> : <Pause size={15} />}
          {stopped(currentAgent.phase) ? 'Start sandbox' : 'Stop sandbox'}
        </button>
        <button
          className="button"
          onClick={() => setRetry((value) => value + 1)}
          disabled={loading || mutationBusy}
        >
          <RefreshCw size={15} />
          Reload access
        </button>
      </div>
      <div className="detail-tabs" role="tablist" aria-label="Agent details">
        {(['permissions', 'credentials', 'activity'] as const).map((name) => (
          <button
            id={`tab-${name}`}
            key={name}
            role="tab"
            aria-selected={tab === name}
            aria-controls={`panel-${name}`}
            tabIndex={tab === name ? 0 : -1}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault();
                const names: DetailTab[] = ['permissions', 'credentials', 'activity'];
                const next =
                  names[(names.indexOf(name) + (event.key === 'ArrowRight' ? 1 : 2)) % 3];
                setTab(next);
                document.getElementById(`tab-${next}`)?.focus();
              }
            }}
            onClick={() => {
              setTab(name);
              setEditing(false);
            }}
          >
            {name[0].toUpperCase() + name.slice(1)}
          </button>
        ))}
      </div>
      <div
        className="drawer-body"
        id={`panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
      >
        {loading && tab !== 'activity' ? (
          <div className="loading-block">
            <LoaderCircle className="spin" size={23} />
            Reading access from OpenShell…
          </div>
        ) : error && tab !== 'activity' ? (
          <div className="error-box">
            <h3>Could not inspect access</h3>
            <p>{error}</p>
            <button className="button" onClick={() => setRetry((value) => value + 1)}>
              Try again
            </button>
          </div>
        ) : detail && tab === 'permissions' ? (
          editing ? (
            <>
              <button className="text-button" onClick={() => setEditing(false)}>
                ← Back to permissions
              </button>
              <h3 className="editor-title">Base policy editor</h3>
              <p className="muted-copy">
                JSON is valid YAML for OpenShell. Edit network rules here. Filesystem and process
                settings are fixed at sandbox creation.
              </p>
              <label className="sr-only" htmlFor="policy-editor">
                Base policy JSON
              </label>
              <textarea
                id="policy-editor"
                className="policy-editor"
                value={policyJson}
                onChange={(event) => {
                  setPolicyJson(event.target.value);
                  setEditorError(null);
                }}
                spellCheck={false}
                disabled={mutationBusy}
              />
              {editorError && (
                <p className="form-error" role="alert">
                  {editorError}
                </p>
              )}
              <button
                className="button primary full"
                onClick={reviewPolicy}
                disabled={mutationBusy}
              >
                Review changes
                <ArrowRight size={16} />
              </button>
            </>
          ) : (
            <PermissionView detail={detail} onEdit={() => setEditing(true)} />
          )
        ) : detail && tab === 'credentials' ? (
          <>
            <div className="detail-note">
              <LockKeyhole size={17} />
              <span>
                Credential values stay in OpenShell. Attachments grant the provider's access
                profile.
              </span>
            </div>
            {detail.providers.length ? (
              detail.providers.map((provider) => (
                <div className="attachment" key={provider.name}>
                  <CredentialCard provider={provider} />
                  <button
                    className="text-button danger-text"
                    disabled={mutationBusy}
                    onClick={() => providerChange(provider.name, 'detach')}
                  >
                    Revoke access
                  </button>
                </div>
              ))
            ) : (
              <p className="muted-copy">No providers are attached to this sandbox.</p>
            )}
            <section className="permission-section">
              <h3>Grant another provider</h3>
              <p className="muted-copy">Choose a provider already configured in this workspace.</p>
              <div className="attach-form">
                <select
                  aria-label="Provider to attach"
                  value={providerName}
                  onChange={(event) => setProviderName(event.target.value)}
                  disabled={mutationBusy}
                >
                  <option value="">Choose provider</option>
                  {availableProviders.map((provider) => (
                    <option value={provider.name} key={provider.name}>
                      {provider.name}
                    </option>
                  ))}
                </select>
                <button
                  className="button"
                  disabled={
                    !providerName ||
                    mutationBusy ||
                    !availableProviders.some((provider) => provider.name === providerName)
                  }
                  onClick={() => providerChange(providerName, 'attach')}
                >
                  <Plus size={16} />
                  Grant
                </button>
              </div>
            </section>
            <UsageCoverage compact />
          </>
        ) : tab === 'activity' ? (
          <>
            <div className="log-heading">
              <div>
                <h3>Recent activity</h3>
                <p>Up to 150 lines from the last hour.</p>
              </div>
              <IconButton
                icon={RefreshCw}
                label="Refresh activity"
                disabled={logsLoading}
                onClick={() => setLogsRetry((value) => value + 1)}
              />
            </div>
            {logsLoading ? (
              <div className="loading-block">
                <LoaderCircle className="spin" size={22} />
                Reading recent logs…
              </div>
            ) : logsError ? (
              <div className="error-box" role="alert">
                {logsError}
              </div>
            ) : (
              <pre className="log-view">
                {logs?.trim() || 'OpenShell returned no logs in this time window.'}
              </pre>
            )}
            <p className="muted-copy footnote">
              Logs are fetched on demand and kept in this view only. Common credential patterns are
              redacted; application log content can still be sensitive.
            </p>
          </>
        ) : null}
      </div>
      <div className="drawer-footer">
        <ShieldCheck size={14} />
        Enforced by OpenShell<span>{api.previewMode ? 'Sample preview' : 'Live gateway data'}</span>
      </div>
    </Modal>
  );
}

function OpenShellPage({
  data,
  selection,
  onWorkspace,
  onToast,
  update,
  checking,
  onCheck,
  appUpdate,
  onAppUpdate,
}: {
  data: Snapshot | null;
  selection: Selection;
  onWorkspace: (workspace: string) => void;
  onToast: (message: string) => void;
  update: UpdateInfo | null;
  checking: boolean;
  onCheck: () => void;
  appUpdate: AppUpdateStatus | null;
  onAppUpdate: (value: AppUpdateStatus) => void;
}) {
  const [workspace, setWorkspace] = useState(selection.workspace);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  function applyWorkspace() {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(workspace)) {
      setWorkspaceError('Enter a valid OpenShell workspace name.');
      return;
    }
    setWorkspaceError(null);
    onWorkspace(workspace);
  }
  return (
    <div className="settings-layout">
      <AppUpdates status={appUpdate} onStatus={onAppUpdate} onToast={onToast} />
      <section className="settings-card">
        <div className="settings-heading">
          <div className="provider-icon">
            <Terminal size={23} />
          </div>
          <div>
            <h3>NVIDIA OpenShell</h3>
            <p>Your runtime, your source of truth.</p>
          </div>
          <span className="version-pill">
            {data?.installedVersion ? `v${data.installedVersion}` : 'Not detected'}
          </span>
        </div>
        <div className="settings-row">
          <span>Installed CLI</span>
          <strong>{data?.installedVersion ?? 'Not available in browser'}</strong>
        </div>
        <div className="settings-row">
          <span>Gateway version</span>
          <strong>{data?.status?.version ?? 'Not reported'}</strong>
        </div>
        <div className="settings-row">
          <span>Authentication</span>
          <strong>{data?.status?.authentication?.status ?? 'Not connected'}</strong>
        </div>
        <div className="update-box">
          <ArrowDownToLine size={21} />
          <div>
            <h4>
              {checking
                ? 'Checking the official release…'
                : update?.status === 'available'
                  ? `OpenShell ${update.latestVersion} is available`
                  : update?.status === 'current'
                    ? 'You’re on the latest stable release'
                    : update?.status === 'ahead'
                      ? 'Your CLI is ahead of the stable release'
                      : update?.status === 'unavailable'
                        ? 'Update check unavailable'
                        : update?.status === 'not-installed'
                          ? `Latest stable: ${update.latestVersion}`
                          : 'Keep your guardrails up to date'}
            </h4>
            <p>
              {update?.error ??
                (api.previewMode && update
                  ? 'Sample result only. This is not a live release check.'
                  : 'Check NVIDIA’s latest stable release. Updates are always your choice.')}
            </p>
          </div>
        </div>
        <div className="settings-buttons">
          <button
            className="button primary"
            onClick={onCheck}
            disabled={checking || (!api.desktopMode && !api.previewMode)}
          >
            {checking ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}Check
            for updates
          </button>
          <button
            className="button"
            onClick={() => {
              void api.openReleases().catch((error) => onToast(api.errorMessage(error)));
            }}
          >
            Official releases
            <ExternalLink size={15} />
          </button>
        </div>
      </section>
      <section className="settings-card">
        <div className="section-label">
          <Folder size={20} />
          <h3>Workspace</h3>
          <span className="small-tag">This session</span>
        </div>
        <p className="muted-copy">
          Scope agent and provider reads to an existing OpenShell workspace. This selection is held
          in memory.
        </p>
        <label className="field-label" htmlFor="workspace-input">
          Workspace name
        </label>
        <div className="workspace-form">
          <input
            id="workspace-input"
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') applyWorkspace();
            }}
          />
          <button className="button" onClick={applyWorkspace}>
            Use workspace
            <ArrowRight size={15} />
          </button>
        </div>
        {workspaceError && (
          <p className="form-error" role="alert">
            {workspaceError}
          </p>
        )}
      </section>
      <section className="settings-card">
        <div className="section-label">
          <Server size={20} />
          <h3>Registered gateways</h3>
        </div>
        {data?.gateways.length ? (
          data.gateways.map((gateway) => (
            <div className="gateway-row" key={gateway.name}>
              {gateway.is_remote ? <Globe2 size={19} /> : <Monitor size={19} />}
              <div>
                <strong>{gateway.name}</strong>
                <code>{gateway.endpoint}</code>
              </div>
              <span className="small-tag">{gateway.auth || 'OpenShell managed'}</span>
            </div>
          ))
        ) : (
          <p className="muted-copy">No gateway inventory is available in this view.</p>
        )}
        <p className="muted-copy footnote">
          Register and authenticate gateways using OpenShell. ShellGuardian reuses those
          connections.
        </p>
        <code className="command-sample">openshell gateway list --output json</code>
      </section>
      <section className="settings-card privacy-card">
        <ShieldCheck size={24} />
        <div>
          <h3>Nothing extra to keep in sync.</h3>
          <p>
            No ShellGuardian database. No copied keys. No separate policy engine. Your agents’ state
            and enforcement belong to OpenShell.
          </p>
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const { status: appUpdate, setStatus: setAppUpdate } = useAppUpdates();
  const [page, setPage] = useState<Page>('overview');
  const [selection, setSelection] = useState<Selection>({ gateway: null, workspace: 'default' });
  const { data, busy, error, refresh } = useSnapshot(selection);
  const [query, setQuery] = useState('');
  const [phaseFilter, setPhaseFilter] = useState('all');
  const [selectedAgent, setSelectedAgent] = useState<{ agent: Agent; tab: DetailTab } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const updateRequest = useRef(0);
  const installedVersion = data?.installedVersion ?? null;
  const checkUpdates = useCallback(async () => {
    const request = ++updateRequest.current;
    setCheckingUpdate(true);
    try {
      const result = await api.checkUpdates();
      if (request === updateRequest.current) setUpdate(result);
    } catch (error) {
      if (request === updateRequest.current)
        setUpdate({
          status: 'unavailable',
          error: api.errorMessage(error),
          installedVersion,
          latestVersion: null,
          releaseUrl: null,
          publishedAt: null,
        });
    } finally {
      if (request === updateRequest.current) setCheckingUpdate(false);
    }
  }, [installedVersion]);
  useEffect(() => {
    if (api.desktopMode && !api.previewMode && installedVersion) void checkUpdates();
    return () => {
      updateRequest.current += 1;
    };
  }, [installedVersion, checkUpdates]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 8500);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    setSelectedAgent(null);
    setPending(null);
    setMutationError(null);
  }, [selection.gateway, selection.workspace]);
  const connected = data?.status?.status.toLowerCase() === 'connected';
  const agents = data?.agents ?? [];
  const visibleAgents = agents.filter(
    (agent) =>
      agent.name.toLowerCase().includes(query.toLowerCase()) &&
      (phaseFilter === 'all' ||
        (phaseFilter === 'ready' && ready(agent.phase)) ||
        (phaseFilter === 'stopped' && stopped(agent.phase))),
  );
  const readyCount = agents.filter((agent) => ready(agent.phase)).length;
  const agentInventoryFailed = data?.notices.some((notice) => notice.area === 'agents') ?? false;
  const providerInventoryFailed =
    data?.notices.some((notice) => notice.area === 'providers') ?? false;
  const nav: { id: Page; title: string; icon: LucideIcon }[] = [
    { id: 'overview', title: 'Overview', icon: LayoutDashboard },
    { id: 'agents', title: 'Agents', icon: Bot },
    { id: 'credentials', title: 'Credentials', icon: KeyRound },
    { id: 'activity', title: 'Activity', icon: Activity },
  ];
  const titles: Record<Page, string> = {
    overview: 'Overview',
    agents: 'Your agents',
    credentials: 'Credentials',
    activity: 'Activity',
    openshell: 'OpenShell & settings',
  };
  const gateway = data?.gateways.find((gateway) => gateway.name === data.scope?.gateway);
  function request(action: Pending) {
    setMutationError(null);
    setPending(action);
  }
  async function executePending() {
    if (!pending || mutationBusy) return;
    setMutationBusy(true);
    setMutationError(null);
    try {
      const receipt = await pending.execute();
      setToast(receipt);
      setPending(null);
      setDetailRevision((value) => value + 1);
      refresh();
    } catch (error) {
      setMutationError(
        `${api.errorMessage(error)} Refresh the current state before retrying; a requested change may already be saved.`,
      );
    } finally {
      setMutationBusy(false);
    }
  }
  function openAgent(agent: Agent, tab: DetailTab = 'permissions') {
    if (data?.scope) setSelectedAgent({ agent, tab });
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            setPage('overview');
          }}
        >
          <img src="/mark.svg" alt="" />
          <span>
            ShellGuardian<small>A little peace of mind.</small>
          </span>
        </a>
        <div className="sidebar-label">YOUR CONTROL ROOM</div>
        <nav aria-label="Main navigation">
          {nav.map(({ id, title, icon: Icon }) => (
            <button
              className={`nav-item ${page === id ? 'active' : ''}`}
              aria-current={page === id ? 'page' : undefined}
              key={id}
              onClick={() => {
                setPage(id);
                setQuery('');
              }}
            >
              <Icon size={19} />
              {title}
              {id === 'agents' && data && !agentInventoryFailed && <span>{agents.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-guide">
          <div className="guide-mark">
            <ShieldCheck size={26} />
          </div>
          <h3>Freedom with boundaries.</h3>
          <p>
            You set the access.
            <br />
            OpenShell holds the line.
          </p>
          <button onClick={() => setPage('openshell')}>
            Meet your runtime
            <ArrowRight size={14} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${page === 'openshell' ? 'active' : ''}`}
            onClick={() => setPage('openshell')}
            aria-current={page === 'openshell' ? 'page' : undefined}
          >
            <Settings2 size={19} />
            OpenShell & settings
          </button>
          {update?.status === 'available' && (
            <button className="update-notification" onClick={() => setPage('openshell')}>
              <ArrowDownToLine size={14} />
              {api.previewMode ? 'Sample update available' : 'OpenShell update available'}
            </button>
          )}
          <div className="runtime-foot">
            <span className={`status-dot ${connected ? 'connected' : ''}`} />
            <span>
              OpenShell {data?.installedVersion ? `v${data.installedVersion}` : 'not detected'}
              <small>
                {api.previewMode
                  ? 'Sample preview'
                  : connected
                    ? 'Gateway connected'
                    : 'Awaiting connection'}
              </small>
            </span>
            <Shield size={15} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        {api.previewMode && (
          <div className="preview-banner">
            <BookOpen size={15} />
            <strong>Sample preview</strong>
            <span>
              Illustrative agents only. OpenShell is not connected and controls are simulated.
            </span>
            <a href="/">
              Leave preview
              <X size={13} />
            </a>
          </div>
        )}
        <header className="topbar">
          <div className="breadcrumb">
            Control room<span>/</span>
            <strong>{titles[page]}</strong>
          </div>
          <div className="topbar-controls">
            <span className="workspace-pill">
              <Folder size={14} />
              {selection.workspace}
            </span>
            <div className="gateway-select">
              <Monitor size={16} />
              <label className="sr-only" htmlFor="gateway-selector">
                OpenShell gateway
              </label>
              <select
                id="gateway-selector"
                value={selection.gateway ?? data?.scope?.gateway ?? ''}
                disabled={!data?.gateways.length || mutationBusy}
                onChange={(event) =>
                  setSelection((current) => ({ ...current, gateway: event.target.value }))
                }
              >
                {!data?.gateways.length && <option value="">No gateway</option>}
                {data?.gateways.map((gateway) => (
                  <option value={gateway.name} key={gateway.name}>
                    {gateway.name}
                    {gateway.is_remote ? ' · Remote' : ' · Local'}
                  </option>
                ))}
              </select>
              <ChevronDown size={13} />
            </div>
            <IconButton
              icon={RefreshCw}
              label="Refresh OpenShell state"
              onClick={refresh}
              disabled={busy}
            />
          </div>
        </header>
        <main className="main-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {page === 'overview' ? 'A CLEAR VIEW OF YOUR AGENTS' : 'YOUR CONTROL ROOM'}
              </div>
              <h1>{page === 'overview' ? 'Give your agents room to work.' : titles[page]}</h1>
              <p>
                {page === 'overview'
                  ? 'Keep an eye on their environment. Keep a hand on their access.'
                  : page === 'agents'
                    ? 'One place to see each sandbox and the boundaries around it.'
                    : page === 'credentials'
                      ? 'Know which providers are available, and choose who gets access.'
                      : page === 'activity'
                        ? 'See what OpenShell observed, directly from your agents’ sandboxes.'
                        : 'Stay connected to the runtime that keeps your agents in bounds.'}
              </p>
            </div>
            <div className="connection-chip">
              <span className={`status-dot ${connected ? 'connected' : ''}`} />
              {api.previewMode
                ? 'Preview environment'
                : connected
                  ? 'Connected to OpenShell'
                  : 'Connection needed'}
            </div>
          </div>
          {error || data?.notices.length ? (
            <div className="notices" role="alert">
              {error && (
                <p>
                  <WifiOff size={16} />
                  <span>{error}</span>
                </p>
              )}
              {data?.notices.map((notice, index) => (
                <p key={`${notice.area}-${index}`}>
                  <CircleHelp size={16} />
                  <span>
                    <strong>{notice.area[0].toUpperCase() + notice.area.slice(1)}:</strong>{' '}
                    {notice.message}
                  </span>
                </p>
              ))}
            </div>
          ) : null}
          {page === 'overview' && (
            <div className="summary-grid">
              <div className="summary-card">
                <div>
                  <span>All agents</span>
                  <Bot size={18} />
                </div>
                <strong>{busy && !data ? '…' : agentInventoryFailed ? '—' : agents.length}</strong>
                <small>
                  {agentInventoryFailed ? 'Inventory unavailable' : 'Sandboxes in this workspace'}
                </small>
              </div>
              <div className="summary-card">
                <div>
                  <span>Ready sandboxes</span>
                  <span className="mini-dot" />
                </div>
                <strong>{agentInventoryFailed ? '—' : readyCount}</strong>
                <small>
                  {readyCount ? 'Available for agent workloads' : 'No ready sandboxes reported'}
                </small>
              </div>
              <div className="summary-card">
                <div>
                  <span>Credential providers</span>
                  <KeyRound size={18} />
                </div>
                <strong>{providerInventoryFailed ? '—' : (data?.providers.length ?? 0)}</strong>
                <small>
                  {providerInventoryFailed ? 'Inventory unavailable' : 'Managed by your gateway'}
                </small>
              </div>
              <div className="summary-card unavailable">
                <div>
                  <span>Inference tokens</span>
                  <Cpu size={18} />
                </div>
                <strong>—</strong>
                <small>
                  Usage not reported by this CLI
                  <CircleHelp size={12} />
                </small>
              </div>
            </div>
          )}
          {(page === 'overview' || page === 'agents') && (
            <div className={page === 'overview' ? 'overview-columns' : ''}>
              <section className="agents-section">
                <div className="section-heading">
                  <div>
                    <h2>
                      {page === 'overview' ? 'Your agents' : 'Agent sandboxes'}
                      <span className="count-badge">
                        {agentInventoryFailed ? '—' : agents.length}
                      </span>
                    </h2>
                    <p>Access starts with an OpenShell sandbox.</p>
                  </div>
                  {page === 'overview' && (
                    <button className="text-button" onClick={() => setPage('agents')}>
                      View all
                      <ArrowRight size={15} />
                    </button>
                  )}
                </div>
                <div className="agent-toolbar">
                  <label className="search-field">
                    <Search size={16} />
                    <span className="sr-only">Search agents</span>
                    <input
                      placeholder="Find an agent…"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </label>
                  <select
                    aria-label="Filter agent state"
                    value={phaseFilter}
                    onChange={(event) => setPhaseFilter(event.target.value)}
                  >
                    <option value="all">All states</option>
                    <option value="ready">Ready</option>
                    <option value="stopped">Stopped</option>
                  </select>
                </div>
                {busy && !data ? (
                  <div className="loading-block">
                    <LoaderCircle size={25} className="spin" />
                    Connecting to OpenShell…
                  </div>
                ) : agents.length ? (
                  visibleAgents.length ? (
                    <div className="agent-grid">
                      {visibleAgents.map((agent) => (
                        <AgentCard key={agent.id} agent={agent} onOpen={() => openAgent(agent)} />
                      ))}
                    </div>
                  ) : (
                    <div className="search-empty">No agents match your search.</div>
                  )
                ) : (
                  <AgentEmpty
                    failed={agentInventoryFailed}
                    connected={connected}
                    onPreview={() => {
                      window.location.search = '?preview=1';
                    }}
                  />
                )}
                <div className="section-foot">
                  <RefreshCw size={12} />
                  <span>
                    {busy
                      ? 'Refreshing…'
                      : api.previewMode
                        ? 'Sample environment'
                        : data?.observedAt
                          ? `Last checked ${new Date(data.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
                          : 'Waiting for a snapshot'}
                  </span>
                  <span>Refreshes every 15 seconds</span>
                </div>
              </section>
              {page === 'overview' && (
                <aside className="overview-aside">
                  <section className="guardian-card">
                    <div className="guardian-illustration">
                      <div className="orbit orbit-one" />
                      <div className="orbit orbit-two" />
                      <img src="/mark.svg" alt="" />
                      <span className="orbit-node one">
                        <Folder size={16} />
                      </span>
                      <span className="orbit-node two">
                        <KeyRound size={16} />
                      </span>
                      <span className="orbit-node three">
                        <Globe2 size={16} />
                      </span>
                    </div>
                    <h3>
                      Good boundaries.
                      <br />
                      Better company.
                    </h3>
                    <p>A few thoughtful limits give your agents the space to be useful.</p>
                    <div className="guardian-check">
                      <Check size={15} />
                      Policies enforced by OpenShell
                    </div>
                    <div className="guardian-check">
                      <Check size={15} />
                      Credentials stay with providers
                    </div>
                    <div className="guardian-check">
                      <Check size={15} />
                      No separate state to manage
                    </div>
                  </section>
                  <section className="gateway-card">
                    <div>
                      <Server size={18} />
                      <h3>Your connection</h3>
                    </div>
                    <strong>{gateway?.name ?? 'OpenShell desktop'}</strong>
                    <p>
                      {gateway
                        ? gateway.is_remote
                          ? 'Remote gateway'
                          : 'Local gateway'
                        : 'Connect using the desktop app'}
                    </p>
                    <span>
                      <LockKeyhole size={12} />
                      {data?.status?.authentication?.status ?? 'Not authenticated'}
                    </span>
                    <button className="text-button" onClick={() => setPage('openshell')}>
                      Connection details
                      <ArrowRight size={14} />
                    </button>
                  </section>
                </aside>
              )}
            </div>
          )}
          {page === 'credentials' && (
            <>
              <div className="info-strip">
                <FileLock2 size={20} />
                <div>
                  <strong>Names and access. Keys stay private.</strong>
                  <p>
                    ShellGuardian reads provider summaries. Credential values are never requested.
                  </p>
                </div>
              </div>
              {data?.providers.length ? (
                <div className="provider-grid">
                  {data.providers.map((provider) => (
                    <CredentialCard
                      key={provider.name}
                      provider={provider}
                      onInspect={() => {
                        setPage('agents');
                        setQuery('');
                      }}
                    />
                  ))}
                </div>
              ) : (
                <div className="simple-empty">
                  <KeyRound size={31} />
                  <h3>
                    {providerInventoryFailed
                      ? 'Provider inventory unavailable'
                      : 'No providers in this workspace'}
                  </h3>
                  <p>
                    {providerInventoryFailed
                      ? 'OpenShell could not return the provider inventory. See the error above.'
                      : 'Configure providers with OpenShell, then grant access from an agent’s detail view.'}
                  </p>
                </div>
              )}
              <UsageCoverage />
            </>
          )}
          {page === 'activity' && (
            <>
              <div className="info-strip">
                <Activity size={21} />
                <div>
                  <strong>Choose an agent to inspect its recent activity.</strong>
                  <p>Logs come straight from OpenShell. This view keeps no activity archive.</p>
                </div>
              </div>
              <div className="activity-list">
                {agents.map((agent) => (
                  <button key={agent.id} onClick={() => openAgent(agent, 'activity')}>
                    <div className="agent-avatar sage">
                      <Bot size={22} />
                    </div>
                    <div>
                      <strong>{agent.name}</strong>
                      <span>{agent.workspace || 'default'} · Last-hour log window</span>
                    </div>
                    <Status phase={agent.phase} />
                    <ArrowRight size={18} />
                  </button>
                ))}
              </div>
              {!agents.length && (
                <AgentEmpty
                  failed={agentInventoryFailed}
                  connected={connected}
                  onPreview={() => {
                    window.location.search = '?preview=1';
                  }}
                />
              )}
              <UsageCoverage />
            </>
          )}
          {page === 'openshell' && (
            <OpenShellPage
              data={data}
              selection={selection}
              onWorkspace={(workspace) => setSelection((current) => ({ ...current, workspace }))}
              onToast={setToast}
              appUpdate={appUpdate}
              onAppUpdate={setAppUpdate}
              update={update}
              checking={checkingUpdate}
              onCheck={() => {
                void checkUpdates();
              }}
            />
          )}
          {page === 'overview' && <UsageCoverage />}
          <footer className="page-footer">
            <span>
              <ShieldCheck size={14} />A clear view. OpenShell in control.
            </span>
            <span>ShellGuardian {appUpdate?.appVersion ?? 'version unavailable'}</span>
          </footer>
        </main>
      </div>
      {selectedAgent && data?.scope && (
        <AgentDrawer
          key={`${data.scope.gateway}/${data.scope.workspace}/${selectedAgent.agent.name}`}
          agent={selectedAgent.agent}
          scope={data.scope}
          providers={data.providers}
          initialTab={selectedAgent.tab}
          onClose={() => setSelectedAgent(null)}
          onRequest={request}
          refreshRevision={detailRevision}
          mutationBusy={mutationBusy}
        />
      )}
      {pending && (
        <Modal
          className={`confirmation ${pending.before ? 'policy-confirmation' : ''}`}
          label={pending.title}
          onClose={() => {
            setPending(null);
            setMutationError(null);
          }}
          busy={mutationBusy}
        >
          <div className={`confirm-icon ${pending.danger ? 'danger' : ''}`}>
            <Shield size={25} />
          </div>
          <h2>{pending.title}</h2>
          <p>{pending.description}</p>
          <div className="confirm-scope">
            <span>
              Sandbox<strong>{pending.target}</strong>
            </span>
            <span>
              Gateway / workspace
              <strong>
                {pending.scope.gateway} / {pending.scope.workspace}
              </strong>
            </span>
          </div>
          {pending.before && (
            <div className="policy-comparison">
              <div>
                <h3>Current base policy</h3>
                <pre>{pending.before}</pre>
              </div>
              <div>
                <h3>Proposed base policy</h3>
                <pre>{pending.after}</pre>
              </div>
            </div>
          )}
          {api.previewMode && (
            <div className="preview-confirm-note">
              Sample preview. This action will only be simulated.
            </div>
          )}
          {mutationError && (
            <div className="error-box" role="alert">
              {mutationError}
              <button
                className="text-button"
                onClick={() => {
                  setPending(null);
                  setMutationError(null);
                  setDetailRevision((value) => value + 1);
                  refresh();
                }}
              >
                Close and refresh current state
                <RefreshCw size={14} />
              </button>
            </div>
          )}
          <div className="confirm-buttons">
            <button
              className="button"
              onClick={() => {
                setPending(null);
                setMutationError(null);
              }}
              disabled={mutationBusy}
            >
              Cancel
            </button>
            <button
              className={`button ${pending.danger ? 'danger' : 'primary'}`}
              onClick={() => {
                void executePending();
              }}
              disabled={mutationBusy || !!mutationError}
            >
              {mutationBusy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <CheckCheck size={16} />
              )}
              {mutationBusy ? 'Waiting for OpenShell…' : pending.label}
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <ShieldCheck size={20} />
          <span>{toast}</span>
          <IconButton icon={X} label="Dismiss notification" onClick={() => setToast(null)} />
        </div>
      )}
    </div>
  );
}
