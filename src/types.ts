export interface Scope {
  gateway: string;
  workspace: string;
}
export interface Selection {
  gateway: string | null;
  workspace: string;
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
