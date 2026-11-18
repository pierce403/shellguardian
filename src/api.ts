import { invoke, isTauri } from '@tauri-apps/api/core';
import { sampleDetail, sampleLogs, sampleSnapshot } from './preview';
import { version } from '../package.json';
import type {
  AgentDetail,
  LifecycleAction,
  PolicyEdit,
  ProviderAction,
  Scope,
  Selection,
  Snapshot,
  UpdateInfo,
  AppUpdateStatus,
  SshConnectRequest,
  SshConnection,
  AgentTerminalTarget,
  AgentTerminalSession,
  AgentTerminalRead,
  HermesDiscovery,
  HermesReply,
  HermesTerminalTarget,
  InstallerPreview,
  HermesGatewayStatus,
  HermesModelOptions,
  HermesModelChange,
  HermesSession,
  HermesTranscriptRow,
  HermesSchedule,
  KanbanBoard,
  KanbanTask,
  KanbanTaskDetail,
  SupervisorPreparation,
} from './types';

export const previewMode = new URLSearchParams(window.location.search).get('preview') === '1';
export const desktopMode = isTauri();
let previewSnapshot = structuredClone(sampleSnapshot);
const previewDetails = new Map<string, AgentDetail>();
let previewConnectionSequence = 0;
let previewConnections: SshConnection[] = [];
let sampleAppUpdate: AppUpdateStatus = {
  appVersion: version,
  enabled: true,
  supported: false,
  phase: 'unsupported',
  latestVersion: null,
  error: null,
};

export async function getAppUpdate(): Promise<AppUpdateStatus> {
  if (!desktopMode || previewMode) return { ...sampleAppUpdate };
  return invoke('get_shellguardian_update');
}
export async function setAutoUpdate(enabled: boolean): Promise<AppUpdateStatus> {
  if (previewMode) {
    sampleAppUpdate = { ...sampleAppUpdate, enabled };
    return { ...sampleAppUpdate };
  }
  return invoke('set_auto_update', { enabled });
}
export async function checkAppUpdate(download = false): Promise<AppUpdateStatus> {
  if (previewMode) {
    sampleAppUpdate = {
      ...sampleAppUpdate,
      latestVersion: '0.2.1',
      phase: download || sampleAppUpdate.enabled ? 'ready' : 'available',
    };
    return { ...sampleAppUpdate };
  }
  return invoke(download ? 'download_shellguardian_update' : 'check_shellguardian_update');
}
export async function restartForUpdate(): Promise<void> {
  if (previewMode) return;
  return invoke('restart_for_update');
}

function previewKey(scope: Scope, name: string) {
  return `${scope.connectionId ?? 'direct'}/${scope.gateway}/${scope.workspace}/${name}`;
}
export function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string')
    return error.message;
  return 'The request could not be completed. Refresh the current state before retrying.';
}

export async function getSnapshot(selection: Selection): Promise<Snapshot> {
  if (previewMode) {
    const gateway = selection.gateway ?? 'local';
    if (
      selection.connectionId &&
      !previewConnections.some(
        (connection) => connection.id === selection.connectionId && connection.gateway === gateway,
      )
    )
      throw new Error('This SSH connection has ended. Connect again or choose a direct gateway.');
    return {
      ...structuredClone(previewSnapshot),
      scope: {
        gateway,
        workspace: selection.workspace,
        connectionId: selection.connectionId ?? null,
      },
      observedAt: Date.now(),
    };
  }
  if (!desktopMode)
    return {
      installedVersion: null,
      gateways: [],
      scope: null,
      status: null,
      agents: [],
      providers: [],
      notices: [],
      observedAt: Date.now(),
    };
  return invoke('get_snapshot', { selection });
}

export async function getDetail(scope: Scope, name: string): Promise<AgentDetail> {
  if (previewMode) {
    const key = previewKey(scope, name);
    if (!previewDetails.has(key)) previewDetails.set(key, sampleDetail(name, previewSnapshot));
    return structuredClone(previewDetails.get(key)!);
  }
  return invoke('get_agent_detail', { scope, name });
}

export async function getLogs(scope: Scope, name: string): Promise<string> {
  if (previewMode) return sampleLogs;
  return invoke('get_agent_logs', { scope, name });
}

export async function changeState(
  scope: Scope,
  name: string,
  action: LifecycleAction,
): Promise<string> {
  if (previewMode) {
    previewSnapshot = {
      ...previewSnapshot,
      agents: previewSnapshot.agents.map((agent) =>
        agent.name === name ? { ...agent, phase: action === 'stop' ? 'Stopped' : 'Ready' } : agent,
      ),
    };
    previewDetails.delete(previewKey(scope, name));
    return `Sample preview: ${action} simulated. No OpenShell agent was changed.`;
  }
  return invoke('change_agent_state', { scope, name, action });
}

export async function changeProvider(
  scope: Scope,
  name: string,
  provider: string,
  action: ProviderAction,
): Promise<string> {
  if (previewMode) {
    const detail = await getDetail(scope, name);
    detail.providers =
      action === 'detach'
        ? detail.providers.filter((item) => item.name !== provider)
        : [...detail.providers, previewSnapshot.providers.find((item) => item.name === provider)!];
    previewDetails.set(previewKey(scope, name), detail);
    return `Sample preview: provider ${action} simulated. No credentials or permissions were changed.`;
  }
  return invoke('change_provider_access', { scope, name, provider, action });
}

export async function applyPolicy(edit: PolicyEdit): Promise<string> {
  if (previewMode) {
    const detail = await getDetail(edit.scope, edit.name);
    const proposed = JSON.parse(edit.policyJson) as Record<string, import('./types').Json>;
    const oldBase = detail.basePolicy as Record<string, Record<string, import('./types').Json>>;
    const effective = detail.policy as Record<string, Record<string, import('./types').Json>>;
    const composed = Object.fromEntries(
      Object.entries(effective.network_policies ?? {}).filter(
        ([name]) => !(name in (oldBase.network_policies ?? {})),
      ),
    );
    detail.basePolicy = proposed;
    detail.policy = {
      ...proposed,
      network_policies: {
        ...composed,
        ...(proposed.network_policies as Record<string, import('./types').Json>),
      },
    };
    previewDetails.set(previewKey(edit.scope, edit.name), detail);
    return 'Sample preview: policy change simulated. OpenShell was not contacted.';
  }
  return invoke('apply_agent_policy', { edit });
}

export async function checkUpdates(): Promise<UpdateInfo> {
  if (previewMode)
    return {
      status: 'available',
      installedVersion: '0.1.2',
      latestVersion: '0.1.3',
      releaseUrl: null,
      publishedAt: null,
      error: null,
    };
  return invoke('check_openshell_updates');
}

export async function openReleases(): Promise<void> {
  if (desktopMode && !previewMode) return invoke('open_openshell_releases');
  window.open('https://github.com/NVIDIA/OpenShell/releases', '_blank', 'noopener,noreferrer');
}

const hermesInstallGuide =
  'https://hermes-agent.nousresearch.com/docs/getting-started/installation/';
let previewHermes: HermesDiscovery = {
  installed: true,
  installation: '/home/sample/.local/bin/hermes',
  profiles: [
    {
      name: 'default',
      model: 'sample/placeholder',
      gateway: 'stopped',
      active: true,
      provider: 'auto',
    },
    {
      name: 'guanyu',
      model: 'sample/model',
      gateway: 'running',
      active: false,
      provider: 'sample-provider',
    },
  ],
  profileText: '',
};
let previewTurn = 0;
export async function discoverHermes(): Promise<HermesDiscovery | null> {
  if (previewMode) return structuredClone(previewHermes);
  if (!desktopMode) return null;
  return invoke('discover_hermes');
}
export async function createHermesProfile(name: string): Promise<void> {
  if (previewMode) {
    if (previewHermes.profiles.some((profile) => profile.name === name))
      throw new Error(`A Hermes profile named ${name} already exists. Refresh instead.`);
    previewHermes = {
      ...previewHermes,
      profiles: [
        ...previewHermes.profiles,
        { name, model: null, gateway: 'stopped', active: false, provider: null },
      ],
    };
    return;
  }
  return invoke('create_hermes_profile', { name });
}
export async function prepareHermesInstaller(): Promise<InstallerPreview> {
  if (previewMode)
    return {
      url: 'https://hermes-agent.nousresearch.com/install.sh',
      sha256: '0'.repeat(64),
      size: 0,
      script: '# Sample preview only. No installer was downloaded.\n',
    };
  return invoke('prepare_hermes_installer');
}
export async function openHermesTerminal(
  target: HermesTerminalTarget,
  cols: number,
  rows: number,
): Promise<AgentTerminalSession> {
  if (previewMode || !desktopMode) throw new Error('Hermes terminals require the desktop app.');
  const action =
    target.hermes === 'install'
      ? { action: 'install', sha256: target.sha256 }
      : { action: target.hermes, profile: target.profile };
  return invoke('open_hermes_terminal', { action, cols, rows });
}
export async function hermesChat(
  profile: string,
  message: string,
  sessionId: string | null,
): Promise<HermesReply> {
  if (previewMode) {
    previewTurn += 1;
    const session = sessionId ?? 'sample_session';
    if (/\btask\b/i.test(message)) {
      const task: KanbanTaskDetail = {
        id: `t_sample${previewKanban.length + 1}`,
        title: message.slice(0, 60),
        assignee: profile,
        status: 'ready',
        session_id: session,
        created_by: profile,
        created_at: Math.floor(Date.now() / 1000),
        comments: [],
        events: [{ kind: 'created', created_at: Math.floor(Date.now() / 1000) }],
      };
      previewLive.add(String(task.id));
      previewKanban = [...previewKanban, task];
      return {
        reply: `Sample preview: created task ${task.id} for ${profile}. No Hermes agent was contacted.`,
        sessionId: session,
      };
    }
    return {
      reply: `Sample preview reply ${previewTurn}. No Hermes agent was contacted.`,
      sessionId: session,
    };
  }
  return invoke('hermes_chat', { profile, message, sessionId });
}
export async function openHermesInstallGuide(): Promise<void> {
  if (desktopMode && !previewMode) return invoke('open_hermes_install_guide');
  window.open(hermesInstallGuide, '_blank', 'noopener,noreferrer');
}

// Hermes gateway (JSON-RPC through native code) and kanban (Hermes CLI).
// Sample preview data below is illustrative; nothing is contacted.
let previewGatewayUp = false;
let previewKanban: KanbanTaskDetail[] = [
  {
    id: 't_sample1',
    title: 'Summarize overnight sandbox activity',
    assignee: 'guanyu',
    status: 'ready',
    body: 'Sample preview task.',
    comments: [],
  },
  {
    id: 't_sample2',
    title: 'Review provider access for scout',
    assignee: 'guanyu',
    status: 'done',
    result: 'Sample preview result.',
    comments: [{ author: 'guanyu', body: 'Sample comment.' }],
  },
];
function previewOnly<T>(value: T): Promise<T> {
  return Promise.resolve(structuredClone(value));
}
function requireDesktop() {
  if (!desktopMode) throw new Error('This needs the ShellGuardian desktop app.');
}
export async function hermesGatewayStatus(profile: string): Promise<HermesGatewayStatus> {
  if (previewMode) return { state: previewGatewayUp ? 'ready' : 'absent', message: null };
  requireDesktop();
  return invoke('hermes_gateway_status', { profile });
}
export async function startHermesGateway(profile: string): Promise<HermesGatewayStatus> {
  if (previewMode) {
    previewGatewayUp = true;
    return { state: 'ready', message: null };
  }
  requireDesktop();
  return invoke('start_hermes_gateway', { profile });
}
function previewGateway() {
  if (!previewGatewayUp)
    throw new Error('The Hermes gateway for this agent is not running. Start it first.');
}
export async function hermesModelOptions(profile: string): Promise<HermesModelOptions> {
  if (previewMode) {
    previewGateway();
    return previewOnly({
      model: 'sample/model',
      provider: 'sample-provider',
      providers: [
        {
          slug: 'sample-provider',
          name: 'Sample provider',
          authenticated: true,
          auth_type: 'oauth',
          is_current: true,
          models: ['sample/model', 'sample/model-mini'],
        },
        {
          slug: 'sample-keys',
          name: 'Sample API-key provider',
          authenticated: false,
          auth_type: 'api_key',
          is_current: false,
          models: ['sample/keyed'],
        },
      ],
    });
  }
  requireDesktop();
  return invoke('hermes_model_options', { profile });
}
export async function setHermesModel(
  profile: string,
  provider: string,
  model: string,
  confirm = false,
): Promise<HermesModelChange> {
  if (previewMode) {
    previewGateway();
    return { ok: true };
  }
  requireDesktop();
  return invoke('set_hermes_model', { profile, provider, model, confirm });
}
export async function saveHermesKey(profile: string, provider: string, key: string): Promise<void> {
  if (previewMode) {
    previewGateway();
    return;
  }
  requireDesktop();
  return invoke('save_hermes_key', { profile, provider, key });
}
export async function hermesSessions(profile: string): Promise<HermesSession[]> {
  if (previewMode) {
    previewGateway();
    return previewOnly([
      {
        session_id: 'sample_session',
        title: 'Sample conversation',
        source: 'cli',
        message_count: 4,
        running: false,
        model: 'sample/model',
        preview: 'Sample preview only.',
        last_active_at: Date.now() / 1000,
      },
    ]);
  }
  requireDesktop();
  return invoke('hermes_sessions', { profile });
}
export async function hermesTranscript(
  profile: string,
  sessionId: string,
): Promise<HermesTranscriptRow[]> {
  if (previewMode)
    return previewOnly([
      { role: 'user', text: 'Sample question.' },
      { role: 'assistant', text: 'Sample answer. No Hermes agent was contacted.' },
    ]);
  requireDesktop();
  return invoke('hermes_transcript', { profile, sessionId });
}
export async function hermesSchedules(profile: string): Promise<HermesSchedule[]> {
  if (previewMode) {
    previewGateway();
    return previewOnly([
      {
        job_id: 'sample_job',
        name: 'Morning check',
        schedule: '0 9 * * *',
        enabled: true,
        last_status: 'ok',
      },
    ]);
  }
  requireDesktop();
  return invoke('hermes_schedules', { profile });
}
export async function kanbanBoards(): Promise<KanbanBoard[]> {
  if (previewMode)
    return previewOnly([
      { slug: 'default', name: 'Default', is_current: true, total: previewKanban.length },
    ]);
  requireDesktop();
  return invoke('hermes_kanban_boards');
}
/** Sample preview only: tasks created here with an assignee advance one step per read. */
const previewLive = new Set<string>();
function advancePreviewKanban() {
  const now = Math.floor(Date.now() / 1000);
  previewKanban = previewKanban.map((task) => {
    if (!previewLive.has(String(task.id))) return task;
    const events = task.events ?? [];
    if (task.status === 'ready')
      return {
        ...task,
        status: 'running',
        started_at: now,
        events: [
          ...events,
          { kind: 'claimed', created_at: now, run_id: 1 },
          {
            kind: 'owner_admitted',
            created_at: now,
            run_id: 1,
            detail: { session_id: 'sample_worker_session' },
          },
          { kind: 'heartbeat', created_at: now, run_id: 1, detail: { note: 'Sample step 1 of 2' } },
        ],
        runs: [{ id: 1, profile: task.assignee, status: 'running', started_at: now }],
      };
    if (task.status === 'running') {
      previewLive.delete(String(task.id));
      return {
        ...task,
        status: 'done',
        completed_at: now,
        result: 'Sample preview result. No agent ran.',
        events: [...events, { kind: 'completed', created_at: now, run_id: 1 }],
        runs: [
          {
            id: 1,
            profile: task.assignee,
            status: 'done',
            outcome: 'completed',
            summary: 'Sample preview result.',
            started_at: task.started_at,
            ended_at: now,
          },
        ],
      };
    }
    return task;
  });
}
export async function kanbanTasks(board: string): Promise<KanbanTask[]> {
  if (previewMode) {
    const tasks = previewOnly(
      previewKanban.map(
        ({ body: _b, result: _r, comments: _c, events: _e, runs: _n, ...task }) => task,
      ),
    );
    advancePreviewKanban();
    return tasks;
  }
  requireDesktop();
  return invoke('hermes_kanban_tasks', { board });
}
export async function kanbanTask(board: string, id: string): Promise<KanbanTaskDetail> {
  if (previewMode) {
    const task = previewKanban.find((t) => String(t.id) === id);
    if (!task) throw new Error('That task no longer exists.');
    return previewOnly(task);
  }
  requireDesktop();
  return invoke('hermes_kanban_task', { board, id });
}
export async function createKanbanTask(
  board: string,
  title: string,
  body: string,
  assignee: string | null,
): Promise<KanbanTask> {
  if (previewMode) {
    const task: KanbanTaskDetail = {
      id: `t_sample${previewKanban.length + 1}`,
      title,
      body,
      assignee: assignee ?? undefined,
      status: assignee ? 'ready' : 'todo',
      created_at: Math.floor(Date.now() / 1000),
      comments: [],
      events: [{ kind: 'created', created_at: Math.floor(Date.now() / 1000) }],
    };
    if (assignee) previewLive.add(String(task.id));
    previewKanban = [...previewKanban, task];
    return previewOnly(task);
  }
  requireDesktop();
  return invoke('create_hermes_kanban_task', { board, title, body, assignee });
}
export async function kanbanLog(board: string, id: string): Promise<string> {
  if (previewMode) return `Sample preview log for ${id}. No agent ran.\n`;
  requireDesktop();
  return invoke('hermes_kanban_log', { board, id });
}
export async function prepareHermesSupervisor(profile: string): Promise<SupervisorPreparation> {
  if (previewMode) {
    previewGateway();
    return { kanbanEnabled: true, skillInstalled: true };
  }
  requireDesktop();
  return invoke('prepare_hermes_supervisor', { profile });
}
export async function commentKanbanTask(board: string, id: string, text: string): Promise<void> {
  if (previewMode) {
    previewKanban = previewKanban.map((t) =>
      String(t.id) === id ? { ...t, comments: [...t.comments, { author: 'you', body: text }] } : t,
    );
    return;
  }
  requireDesktop();
  return invoke('comment_hermes_kanban_task', { board, id, text });
}

export async function getSshConnections(): Promise<SshConnection[]> {
  if (previewMode) return structuredClone(previewConnections);
  if (!desktopMode) return [];
  const connections = await invoke<SshConnection[]>('get_ssh_connections');
  if (!Array.isArray(connections)) throw new Error('Could not read SSH connections.');
  return connections;
}

export async function connectSsh(request: SshConnectRequest): Promise<SshConnection> {
  if (previewMode) {
    const connection: SshConnection = {
      ...request,
      id: `sample-ssh-${++previewConnectionSequence}`,
      localPort: 40000 + previewConnectionSequence,
      status: 'connected',
      error: null,
    };
    previewConnections.push(connection);
    return structuredClone(connection);
  }
  return invoke('connect_ssh_gateway', { request });
}

export async function disconnectSsh(connectionId: string): Promise<void> {
  if (previewMode) {
    previewConnections = previewConnections.filter((connection) => connection.id !== connectionId);
    return;
  }
  return invoke('disconnect_ssh_gateway', { connectionId });
}

export async function openAgentTerminal(
  target: AgentTerminalTarget,
  cols: number,
  rows: number,
): Promise<AgentTerminalSession> {
  if (previewMode || !desktopMode)
    throw new Error('Interactive sessions require the desktop app and a live OpenShell sandbox.');
  return invoke('open_agent_terminal', { ...target, cols, rows });
}

export async function readAgentTerminal(sessionId: string): Promise<AgentTerminalRead> {
  return invoke('read_agent_terminal', { sessionId });
}

export async function writeAgentTerminal(sessionId: string, data: string): Promise<void> {
  return invoke('write_agent_terminal', { sessionId, data });
}

export async function resizeAgentTerminal(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke('resize_agent_terminal', { sessionId, cols, rows });
}

export async function closeAgentTerminal(sessionId: string): Promise<void> {
  return invoke('close_agent_terminal', { sessionId });
}
