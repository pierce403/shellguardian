// Hermes supervisor API: native commands in the desktop app, illustrative
// sample data in `?preview=1`. The sample never contacts Hermes.
import { invoke } from '@tauri-apps/api/core';
import { desktopMode, previewMode } from './mode';
import type {
  AgentTerminalSession,
  ChatProgress,
  ChatStep,
  HermesDiscovery,
  HermesGatewayStatus,
  HermesModelChange,
  HermesModelOptions,
  HermesProviderOption,
  HermesReply,
  HermesSchedule,
  HermesSession,
  HermesTerminalTarget,
  HermesTranscriptRow,
  InstallerPreview,
  KanbanBoard,
  KanbanTask,
  KanbanTaskDetail,
  SupervisorPreparation,
} from './types';

const hermesInstallGuide =
  'https://hermes-agent.nousresearch.com/docs/getting-started/installation/';
const NOT_RUNNING = 'The Hermes gateway for this agent is not running. Start it first.';

function requireDesktop() {
  if (!desktopMode) throw new Error('This needs the ShellGuardian desktop app.');
}
function copy<T>(value: T): T {
  return structuredClone(value);
}
const now = () => Math.floor(Date.now() / 1000);
const pause = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Sample preview state
// ---------------------------------------------------------------------------

const sampleGateways = new Set<string>(['guanyu']);
let sampleProfiles: HermesDiscovery['profiles'] = [
  // `default` shows the "no provider chosen" state Hermes reports as a placeholder model.
  { name: 'default', model: 'sample/placeholder', gateway: null, active: true, provider: 'auto' },
  {
    name: 'guanyu',
    model: 'sample/model',
    gateway: null,
    active: false,
    provider: 'sample-plan',
  },
];
function sampleDiscovery(): HermesDiscovery {
  return {
    installed: true,
    installation: '/home/sample/.local/bin/hermes',
    profiles: sampleProfiles.map((profile) => ({
      ...profile,
      gateway: sampleGateways.has(profile.name) ? 'running' : 'stopped',
    })),
    profileText: '',
  };
}
function sampleGateway(profile: string) {
  if (!sampleGateways.has(profile)) throw new Error(NOT_RUNNING);
}

let sampleProviders: HermesProviderOption[] = [
  {
    slug: 'sample-plan',
    name: 'Sample coding plan',
    authenticated: true,
    is_current: true,
    total_models: 3,
    models: ['sample/model', 'sample/model-mini', 'sample/model-max'],
    usage: [{ label: 'Weekly', used_percent: 13, resets_at: '2026-11-22T15:09:07+00:00' }],
  },
  {
    slug: 'sample-assistant',
    name: 'Sample assistant plan',
    authenticated: true,
    is_current: false,
    total_models: 2,
    models: ['sample/assistant', 'sample/assistant-fast'],
    usage: [
      { label: 'Current session', used_percent: 15, resets_at: '2026-11-18T23:19:59+00:00' },
      { label: 'Current week', used_percent: 4, resets_at: '2026-11-23T03:59:59+00:00' },
    ],
  },
  {
    slug: 'sample-keys',
    name: 'Sample API-key provider',
    authenticated: false,
    auth_type: 'api_key',
    is_current: false,
    total_models: 0,
    models: [],
  },
  {
    slug: 'sample-signin',
    name: 'Sample sign-in provider',
    authenticated: false,
    auth_type: 'oauth_device_code',
    is_current: false,
    total_models: 0,
    models: [],
  },
];

type SampleTask = KanbanTaskDetail & { liveSince?: number; archived?: boolean };
const hourAgo = now() - 3600;
let sampleTasks: SampleTask[] = [
  {
    id: 't_sample1',
    title: 'Summarize overnight sandbox activity',
    assignee: 'guanyu',
    status: 'ready',
    created_by: 'you',
    created_at: hourAgo,
    body: 'Sample preview task. Read the activity log and write a five-line summary.',
    comments: [],
    events: [{ kind: 'created', created_at: hourAgo }],
    runs: [],
  },
  {
    id: 't_sample2',
    title: 'Review provider access for scout',
    assignee: 'guanyu',
    status: 'done',
    created_by: 'guanyu',
    created_at: hourAgo - 1200,
    started_at: hourAgo - 1100,
    completed_at: hourAgo - 1000,
    body: 'Sample preview task.',
    result: 'Sample preview result. scout only needs read access to the code host.',
    comments: [{ author: 'guanyu', body: 'Sample comment.', created_at: hourAgo - 1000 }],
    events: [
      { kind: 'created', created_at: hourAgo - 1200 },
      { kind: 'claimed', created_at: hourAgo - 1100, run_id: 1 },
      {
        kind: 'owner_admitted',
        created_at: hourAgo - 1100,
        run_id: 1,
        detail: { session_id: 'sample_worker_session' },
      },
      {
        kind: 'completed',
        created_at: hourAgo - 1000,
        run_id: 1,
        detail: { summary: 'Sample preview result.' },
      },
    ],
    runs: [
      {
        id: 1,
        profile: 'guanyu',
        status: 'done',
        outcome: 'completed',
        started_at: hourAgo - 1100,
        ended_at: hourAgo - 1000,
      },
    ],
  },
  {
    id: 't_sample3',
    title: 'Rotate the staging access token',
    assignee: 'guanyu',
    status: 'blocked',
    created_by: 'guanyu',
    created_at: hourAgo - 600,
    started_at: hourAgo - 560,
    body: 'Sample preview task.',
    comments: [],
    events: [
      { kind: 'created', created_at: hourAgo - 600 },
      { kind: 'claimed', created_at: hourAgo - 560, run_id: 1 },
      {
        kind: 'blocked',
        created_at: hourAgo - 500,
        run_id: 1,
        detail: { reason: 'Sample reason: no credential for the staging host is attached.' },
      },
    ],
    runs: [
      {
        id: 1,
        profile: 'guanyu',
        status: 'blocked',
        outcome: 'blocked',
        started_at: hourAgo - 560,
        ended_at: hourAgo - 500,
      },
    ],
  },
  {
    id: 't_sample4',
    title: 'Draft the weekly agent report',
    status: 'todo',
    created_by: 'you',
    created_at: hourAgo - 300,
    body: 'Sample preview task. Not assigned yet.',
    comments: [],
    events: [{ kind: 'created', created_at: hourAgo - 300 }],
    runs: [],
  },
];
let sampleRevision = 1;
let sampleTaskSequence = sampleTasks.length;

/** Sample only: an assigned task created in the preview starts, reports, and finishes over a few seconds. */
function advanceSampleTasks() {
  const stamp = now();
  let changed = false;
  sampleTasks = sampleTasks.map((task) => {
    if (task.liveSince === undefined) return task;
    const age = Date.now() - task.liveSince;
    const events = task.events ?? [];
    if (task.status === 'ready' && age >= 1200) {
      changed = true;
      return {
        ...task,
        status: 'running',
        started_at: stamp,
        events: [
          ...events,
          { kind: 'claimed', created_at: stamp, run_id: 1 },
          {
            kind: 'owner_admitted',
            created_at: stamp,
            run_id: 1,
            detail: { session_id: 'sample_worker_session' },
          },
          {
            kind: 'heartbeat',
            created_at: stamp,
            run_id: 1,
            detail: { note: 'Sample step 1 of 2' },
          },
        ],
        runs: [{ id: 1, profile: task.assignee, status: 'running', started_at: stamp }],
      };
    }
    if (task.status === 'running' && age >= 4200) {
      changed = true;
      return {
        ...task,
        liveSince: undefined,
        status: 'done',
        completed_at: stamp,
        result: 'Sample preview result. No agent ran.',
        events: [
          ...events,
          {
            kind: 'completed',
            created_at: stamp,
            run_id: 1,
            detail: { summary: 'Sample preview result.' },
          },
        ],
        runs: [
          {
            id: 1,
            profile: task.assignee,
            status: 'done',
            outcome: 'completed',
            started_at: task.started_at,
            ended_at: stamp,
          },
        ],
      };
    }
    return task;
  });
  if (changed) sampleRevision += 1;
}
function addSampleTask(task: Omit<SampleTask, 'id' | 'comments' | 'events' | 'runs'>): SampleTask {
  sampleTaskSequence += 1;
  const created: SampleTask = {
    ...task,
    id: `t_sample${sampleTaskSequence}`,
    created_at: now(),
    comments: [],
    events: [{ kind: 'created', created_at: now() }],
    runs: [],
    liveSince: task.assignee ? Date.now() : undefined,
  };
  sampleTasks = [...sampleTasks, created];
  sampleRevision += 1;
  return created;
}
function publicTask(task: SampleTask): KanbanTaskDetail {
  const { liveSince: _live, archived: _archived, ...rest } = task;
  return copy(rest);
}

type SampleTurn = {
  profile: string;
  message: string;
  started: number;
  stop: boolean;
  createsTask: boolean;
  reply: string;
};
const SAMPLE_TURN_MS = 900;
let sampleTurn: SampleTurn | null = null;
let sampleTurnCount = 0;
function sampleSteps(turn: SampleTurn, elapsed: number, finished = false): ChatStep[] {
  if (!turn.createsTask) return [];
  const steps: ChatStep[] = [
    {
      name: 'skill_view',
      detail: 'shellguardian-supervisor',
      done: finished || elapsed > 250,
      failed: false,
      durationMs: finished || elapsed > 250 ? 120 : null,
    },
  ];
  if (finished || elapsed > 250)
    steps.push({
      name: 'kanban_create',
      detail: turn.message.slice(0, 60),
      done: finished || elapsed > 600,
      failed: false,
      durationMs: finished || elapsed > 600 ? 310 : null,
    });
  return steps;
}
function sampleText(turn: SampleTurn, elapsed: number): string {
  if (elapsed < 450) return '';
  const share = Math.min(1, (elapsed - 450) / (SAMPLE_TURN_MS - 450));
  return turn.reply.slice(0, Math.max(1, Math.floor(turn.reply.length * share)));
}

// ---------------------------------------------------------------------------
// Discovery, install, profiles
// ---------------------------------------------------------------------------

export async function discoverHermes(): Promise<HermesDiscovery | null> {
  if (previewMode) return sampleDiscovery();
  if (!desktopMode) return null;
  return invoke('discover_hermes');
}
export async function createHermesProfile(name: string): Promise<void> {
  if (previewMode) {
    if (sampleProfiles.some((profile) => profile.name === name))
      throw new Error(`A Hermes profile named ${name} already exists. Refresh instead.`);
    sampleProfiles = [
      ...sampleProfiles,
      { name, model: null, gateway: null, active: false, provider: null },
    ];
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
export async function openHermesInstallGuide(): Promise<void> {
  if (desktopMode && !previewMode) return invoke('open_hermes_install_guide');
  window.open(hermesInstallGuide, '_blank', 'noopener,noreferrer');
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/** Sends one message. Poll `hermesChatProgress` while this is pending. */
export async function hermesChat(
  profile: string,
  message: string,
  sessionId: string | null,
): Promise<HermesReply> {
  if (previewMode) {
    sampleTurnCount += 1;
    const createsTask = /\btask\b/i.test(message);
    const turn: SampleTurn = {
      profile,
      message,
      started: Date.now(),
      stop: false,
      createsTask,
      reply: createsTask
        ? `Sample preview: created a task for ${profile}. No Hermes agent was contacted.`
        : `Sample preview reply ${sampleTurnCount}. No Hermes agent was contacted.`,
    };
    sampleTurn = turn;
    while (!turn.stop && Date.now() - turn.started < SAMPLE_TURN_MS) await pause(40);
    const elapsed = Date.now() - turn.started;
    sampleTurn = null;
    const session = sessionId ?? 'sample_session';
    if (turn.stop)
      return {
        reply: sampleText(turn, elapsed),
        sessionId: session,
        model: 'sample/model',
        tokens: null,
        durationMs: elapsed,
        steps: sampleSteps(turn, elapsed),
        stopped: true,
      };
    if (createsTask)
      addSampleTask({
        title: message.slice(0, 60),
        assignee: profile,
        status: 'ready',
        session_id: session,
        created_by: profile,
        body: 'Sample preview task created from chat.',
      });
    return {
      reply: turn.reply,
      sessionId: session,
      model: 'sample/model',
      tokens: { input: 18250, output: 96, total: 41200, cacheRead: 22854 },
      durationMs: elapsed,
      steps: sampleSteps(turn, elapsed, true),
      stopped: false,
    };
  }
  return invoke('hermes_chat', { profile, message, sessionId });
}
export async function hermesChatProgress(): Promise<ChatProgress> {
  if (previewMode) {
    if (!sampleTurn)
      return { active: false, profile: null, text: '', steps: [], elapsedMs: 0, stopping: false };
    const elapsed = Date.now() - sampleTurn.started;
    return {
      active: true,
      profile: sampleTurn.profile,
      text: sampleText(sampleTurn, elapsed),
      steps: sampleSteps(sampleTurn, elapsed),
      elapsedMs: elapsed,
      stopping: sampleTurn.stop,
    };
  }
  return invoke('hermes_chat_progress');
}
export async function stopHermesChat(): Promise<boolean> {
  if (previewMode) {
    if (!sampleTurn || sampleTurn.stop) return false;
    sampleTurn.stop = true;
    return true;
  }
  return invoke('stop_hermes_chat');
}

// ---------------------------------------------------------------------------
// Gateway, providers, supervisor preparation
// ---------------------------------------------------------------------------

export async function hermesGatewayStatus(profile: string): Promise<HermesGatewayStatus> {
  if (previewMode)
    return { state: sampleGateways.has(profile) ? 'ready' : 'absent', message: null };
  requireDesktop();
  return invoke('hermes_gateway_status', { profile });
}
export async function startHermesGateway(profile: string): Promise<HermesGatewayStatus> {
  if (previewMode) {
    sampleGateways.add(profile);
    return { state: 'ready', message: null };
  }
  requireDesktop();
  return invoke('start_hermes_gateway', { profile });
}
/** Providers and models for an agent. `all` includes providers that are not set up. */
export async function hermesModelOptions(
  profile: string,
  all = false,
): Promise<HermesModelOptions> {
  if (previewMode) {
    sampleGateway(profile);
    const own = sampleProfiles.find((p) => p.name === profile);
    const chosen = own?.provider && own.provider !== 'auto' ? own.provider : undefined;
    return copy({
      model: chosen ? (own?.model ?? undefined) : undefined,
      provider: chosen,
      providers: sampleProviders
        .filter((p) => all || p.authenticated)
        .map((p) => ({ ...p, is_current: p.slug === chosen })),
    });
  }
  requireDesktop();
  return invoke('hermes_model_options', { profile, all });
}
export async function setHermesModel(
  profile: string,
  provider: string,
  model: string,
  confirm = false,
): Promise<HermesModelChange> {
  if (previewMode) {
    sampleGateway(profile);
    if (model.endsWith('-max') && !confirm)
      return {
        ok: false,
        confirm_required: true,
        confirm_message: `Sample notice: ${model} is a premium model and uses your plan faster.`,
      };
    sampleProfiles = sampleProfiles.map((p) =>
      p.name === profile ? { ...p, model, provider } : p,
    );
    return { ok: true };
  }
  requireDesktop();
  return invoke('set_hermes_model', { profile, provider, model, confirm });
}
export async function saveHermesKey(profile: string, provider: string, key: string): Promise<void> {
  if (previewMode) {
    sampleGateway(profile);
    sampleProviders = sampleProviders.map((p) =>
      p.slug === provider
        ? {
            ...p,
            authenticated: true,
            models: ['sample/keyed', 'sample/keyed-mini'],
            total_models: 2,
          }
        : p,
    );
    return;
  }
  requireDesktop();
  return invoke('save_hermes_key', { profile, provider, key });
}
export async function prepareHermesSupervisor(profile: string): Promise<SupervisorPreparation> {
  if (previewMode) {
    sampleGateway(profile);
    return { kanbanEnabled: true, skillInstalled: true };
  }
  requireDesktop();
  return invoke('prepare_hermes_supervisor', { profile });
}

// ---------------------------------------------------------------------------
// Sessions and schedules
// ---------------------------------------------------------------------------

export async function hermesSessions(profile: string): Promise<HermesSession[]> {
  if (previewMode)
    return copy([
      {
        id: 'sample_session',
        title: null,
        preview: 'How are my agents doing today?',
        workspace: 'home',
        lastActive: '2m ago',
        kind: 'chat',
        source: 'oneshot',
      },
      {
        id: 'sample_worker_session',
        title: 'Review provider access for scout',
        preview: null,
        workspace: 't_sample2',
        lastActive: '1h ago',
        kind: 'task',
        source: null,
      },
      {
        id: 'sample_conversation',
        title: 'Planning the week',
        preview: null,
        workspace: 'notes',
        lastActive: 'yesterday',
        kind: 'conversation',
        source: null,
      },
    ] satisfies HermesSession[]).filter(() => profile.length > 0);
  requireDesktop();
  return invoke('hermes_sessions', { profile });
}
export async function hermesTranscript(
  profile: string,
  sessionId: string,
): Promise<HermesTranscriptRow[]> {
  if (previewMode) {
    sampleGateway(profile);
    return copy([
      { role: 'user', text: 'Sample question.', timestamp: hourAgo },
      { role: 'tool', name: 'kanban_show', timestamp: hourAgo + 2 },
      {
        role: 'assistant',
        text: `Sample answer for ${sessionId}. No Hermes agent was contacted.`,
        timestamp: hourAgo + 9,
      },
    ]);
  }
  requireDesktop();
  return invoke('hermes_transcript', { profile, sessionId });
}
export async function hermesSchedules(profile: string): Promise<HermesSchedule[]> {
  if (previewMode) {
    sampleGateway(profile);
    return copy([
      {
        job_id: 'sample_job',
        name: 'Morning check',
        schedule: '0 9 * * *',
        enabled: true,
        next_run_at: now() + 7200,
        last_run_at: now() - 79200,
        last_status: 'ok',
      },
      {
        job_id: 'sample_paused',
        name: 'Weekly cleanup',
        schedule: '0 18 * * 5',
        enabled: false,
        paused: true,
        last_run_at: now() - 500000,
        last_status: 'error',
        last_error: 'Sample error: the workspace was not reachable.',
      },
    ]);
  }
  requireDesktop();
  return invoke('hermes_schedules', { profile });
}

// ---------------------------------------------------------------------------
// Kanban
// ---------------------------------------------------------------------------

export async function kanbanBoards(): Promise<KanbanBoard[]> {
  if (previewMode)
    return [
      {
        slug: 'default',
        name: 'Default',
        is_current: true,
        total: sampleTasks.filter((task) => !task.archived).length,
      },
    ];
  requireDesktop();
  return invoke('hermes_kanban_boards');
}
/**
 * A token that changes when the board changes. Cheap to ask for (no Hermes
 * process), so the board polls this and refetches tasks only on a change.
 */
export async function kanbanRevision(board: string): Promise<string> {
  if (previewMode) {
    advanceSampleTasks();
    return `${board}:${sampleRevision}`;
  }
  requireDesktop();
  return invoke('hermes_kanban_revision', { board });
}
export async function kanbanTasks(board: string, archived = false): Promise<KanbanTask[]> {
  if (previewMode) {
    advanceSampleTasks();
    return sampleTasks
      .filter((task) => archived || !task.archived)
      .map((task) => {
        const {
          body: _b,
          result: _r,
          comments: _c,
          events: _e,
          runs: _n,
          ...summary
        } = publicTask(task);
        return summary;
      });
  }
  requireDesktop();
  return invoke('hermes_kanban_tasks', { board, archived });
}
export async function kanbanTask(board: string, id: string): Promise<KanbanTaskDetail> {
  if (previewMode) {
    advanceSampleTasks();
    const task = sampleTasks.find((t) => String(t.id) === id);
    if (!task) throw new Error('That task no longer exists.');
    return publicTask(task);
  }
  requireDesktop();
  return invoke('hermes_kanban_task', { board, id });
}
export async function kanbanLog(board: string, id: string): Promise<string> {
  if (previewMode) return `Sample preview log for ${id} on ${board}. No agent ran.\n`;
  requireDesktop();
  return invoke('hermes_kanban_log', { board, id });
}
export async function createKanbanTask(
  board: string,
  title: string,
  body: string,
  assignee: string | null,
): Promise<KanbanTask> {
  if (previewMode)
    return publicTask(
      addSampleTask({
        title,
        body,
        assignee: assignee ?? undefined,
        status: assignee ? 'ready' : 'todo',
        created_by: 'you',
      }),
    );
  requireDesktop();
  return invoke('create_hermes_kanban_task', { board, title, body, assignee });
}
export async function commentKanbanTask(board: string, id: string, text: string): Promise<void> {
  if (previewMode) {
    sampleTasks = sampleTasks.map((task) =>
      String(task.id) === id
        ? {
            ...task,
            comments: [...task.comments, { author: 'you', body: text, created_at: now() }],
          }
        : task,
    );
    sampleRevision += 1;
    return;
  }
  requireDesktop();
  return invoke('comment_hermes_kanban_task', { board, id, text });
}
