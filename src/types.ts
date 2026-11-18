export interface Scope {
  gateway: string;
  workspace: string;
  connectionId?: string | null;
}
export interface Selection {
  gateway: string | null;
  workspace: string;
  connectionId?: string | null;
}
export interface Gateway {
  name: string;
  endpoint: string;
  active: boolean;
  auth: string;
  is_remote: boolean;
  remote_host: string | null;
}
export interface GatewayStatus {
  status: string;
  version: string | null;
  authentication: { status: string; provider: string } | null;
}
export interface Agent {
  id: string;
  name: string;
  phase: string;
  workspace: string;
  created_at: string;
  current_policy_version: number;
  exit_code: number | null;
}
export interface Provider {
  name: string;
  type: string;
  credential_keys: string[];
  config_keys: string[];
  created_at: string | null;
  credential_expires_at_ms: Record<string, number>;
}
export interface Notice {
  area: string;
  message: string;
}
export interface Snapshot {
  installedVersion: string | null;
  gateways: Gateway[];
  scope: Scope | null;
  status: GatewayStatus | null;
  agents: Agent[];
  providers: Provider[];
  notices: Notice[];
  observedAt: number;
}
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface AgentDetail {
  agent: Agent;
  policy: Json;
  basePolicy: Json;
  policySource: string;
  policyHash: string;
  configRevision: number;
  providers: Provider[];
}
export interface PolicyEdit {
  scope: Scope;
  name: string;
  expectedHash: string;
  expectedRevision: number;
  policyJson: string;
}
export interface UpdateInfo {
  status: string;
  installedVersion: string | null;
  latestVersion: string | null;
  releaseUrl: string | null;
  publishedAt: string | null;
  error: string | null;
}
export type LifecycleAction = 'start' | 'stop';
export type ProviderAction = 'attach' | 'detach';
export interface HermesProfile {
  name: string;
  model: string | null;
  gateway: string | null;
  active: boolean;
  /** Inference provider; 'auto' means none chosen yet. Null when unknown. */
  provider: string | null;
}

export interface HermesDiscovery {
  installed: boolean;
  installation: string | null;
  profiles: HermesProfile[];
  profileText: string;
}

export interface HermesReply {
  reply: string;
  sessionId: string | null;
}

export interface AppUpdateStatus {
  appVersion: string;
  enabled: boolean;
  supported: boolean;
  phase: string;
  latestVersion: string | null;
  error: string | null;
}

export interface SshConnectRequest {
  gateway: string;
  destination: string;
  remotePort: number;
  sshPort: number | null;
}
export interface SshConnection extends SshConnectRequest {
  id: string;
  localPort: number;
  status: 'connected' | 'disconnected';
  error: string | null;
}

export type TerminalKind = 'agent' | 'terminal';
export interface AgentTerminalTarget {
  scope: Scope;
  name: string;
  kind: TerminalKind;
}
export type HermesTerminalTarget =
  | { hermes: 'install'; sha256: string }
  | { hermes: 'setup'; profile: string }
  | { hermes: 'model'; profile: string };
export type TerminalTarget = AgentTerminalTarget | HermesTerminalTarget;
export interface InstallerPreview {
  url: string;
  sha256: string;
  size: number;
  script: string;
}
export interface AgentTerminalSession {
  id: string;
  kind: TerminalKind;
}
export interface AgentTerminalRead {
  data: number[];
  exited: boolean;
  exitCode: number | null;
  error: string | null;
}

export interface HermesGatewayStatus {
  state: string;
  message: string | null;
}
export interface HermesProviderOption {
  slug: string;
  name?: string;
  authenticated?: boolean;
  auth_type?: string;
  is_current?: boolean;
  total_models?: number;
  warning?: string;
  models: string[];
}
export interface HermesModelOptions {
  model?: string;
  provider?: string;
  providers: HermesProviderOption[];
}
export interface HermesModelChange {
  ok?: boolean;
  confirm_required?: boolean;
  confirm_message?: string;
}
export type Stamp = string | number | undefined;
export interface HermesSession {
  session_id?: string;
  title?: string;
  source?: string;
  started_at?: Stamp;
  last_active_at?: Stamp;
  message_count?: number;
  running?: boolean;
  model?: string;
  preview?: string;
}
export interface HermesTranscriptRow {
  role?: string;
  text?: string;
  timestamp?: Stamp;
  row_kind?: string;
  name?: string;
}
export interface HermesSchedule {
  job_id?: string;
  name?: string;
  schedule?: string;
  enabled?: boolean;
  paused?: boolean;
  next_run_at?: Stamp;
  last_run_at?: Stamp;
  last_status?: string;
  last_error?: string;
  model?: string;
  provider?: string;
}
export interface KanbanBoard {
  slug?: string;
  name?: string;
  description?: string;
  is_current?: boolean;
  archived?: boolean;
  counts?: Record<string, number>;
  total?: number;
}
export interface KanbanTask {
  id?: string | number;
  title?: string;
  assignee?: string;
  status?: string;
  priority?: number | string;
  tenant?: string;
  created_at?: Stamp;
  started_at?: Stamp;
  completed_at?: Stamp;
}
export interface KanbanComment {
  author?: string;
  body?: string;
  created_at?: Stamp;
}
export interface KanbanTaskDetail extends KanbanTask {
  body?: string;
  result?: string;
  latest_summary?: string;
  comments: KanbanComment[];
}
