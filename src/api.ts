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
