import { invoke, isTauri } from '@tauri-apps/api/core';
import { sampleDetail, sampleLogs, sampleSnapshot } from './preview';
import type {
  AgentDetail,
  LifecycleAction,
  PolicyEdit,
  ProviderAction,
  Scope,
  Selection,
  Snapshot,
  UpdateInfo,
} from './types';

export const previewMode = new URLSearchParams(window.location.search).get('preview') === '1';
export const desktopMode = isTauri();
let previewSnapshot = structuredClone(sampleSnapshot);
const previewDetails = new Map<string, AgentDetail>();

function previewKey(scope: Scope, name: string) {
  return `${scope.gateway}/${scope.workspace}/${name}`;
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
    return {
      ...structuredClone(previewSnapshot),
      scope: { gateway, workspace: selection.workspace },
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
