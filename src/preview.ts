// Explicit sample data only. This module is never a fallback for failed live reads.
import type { AgentDetail, Json, Snapshot } from './types';

const agent = (id: string, name: string, phase: string, revision: number) => ({
  id,
  name,
  phase,
  workspace: 'default',
  created_at: '2026-10-05 09:15:00',
  current_policy_version: revision,
  exit_code: null,
});
export const sampleSnapshot: Snapshot = {
  installedVersion: '0.1.2',
  gateways: [
    {
      name: 'local',
      endpoint: 'https://127.0.0.1:17670',
      active: true,
      auth: 'mtls',
      is_remote: false,
      remote_host: null,
    },
    {
      name: 'studio-remote',
      endpoint: 'https://studio.example.invalid',
      active: false,
      auth: 'oidc',
      is_remote: true,
      remote_host: 'studio.example.invalid',
    },
  ],
  scope: { gateway: 'local', workspace: 'default' },
  status: {
    status: 'connected',
    version: '0.1.2',
    authentication: { status: 'authenticated', provider: 'mTLS transport' },
  },
  agents: [
    agent('preview-1', 'research-assistant', 'Ready', 3),
    agent('preview-2', 'code-companion', 'Ready', 5),
    agent('preview-3', 'daily-curator', 'Stopped', 2),
    agent('preview-4', 'data-explorer', 'Provisioning', 1),
  ],
  providers: [
    {
      name: 'anthropic-work',
      type: 'claude',
      credential_keys: ['ANTHROPIC_API_KEY'],
      config_keys: [],
      created_at: null,
      credential_expires_at_ms: {},
    },
    {
      name: 'github-readonly',
      type: 'github',
      credential_keys: ['GITHUB_TOKEN'],
      config_keys: [],
      created_at: null,
      credential_expires_at_ms: {},
    },
  ],
  notices: [],
  observedAt: Date.now(),
};

const basePolicy: Record<string, Json> = {
  version: 1,
  filesystem_policy: {
    read_only: ['/usr', '/bin', '/etc/ssl/certs'],
    read_write: ['/sandbox', '/tmp'],
  },
  process: { run_as_user: 'sandbox', run_as_group: 'sandbox' },
  network_policies: {
    documentation: {
      name: 'Documentation',
      endpoints: [
        {
          host: 'docs.rs',
          port: 443,
          protocol: 'rest',
          access: 'read-only',
          enforcement: 'enforce',
        },
      ],
      binaries: [{ path: '/usr/bin/curl' }],
    },
    package_registry: {
      name: 'Package registry',
      endpoints: [
        {
          host: 'registry.npmjs.org',
          port: 443,
          protocol: 'rest',
          access: 'read-only',
          enforcement: 'enforce',
        },
      ],
      binaries: [{ path: '/usr/bin/node' }],
    },
  },
};

export function sampleDetail(name: string, snapshot: Snapshot): AgentDetail {
  const agent = snapshot.agents.find((agent) => agent.name === name);
  if (!agent) throw new Error('Sample agent not found.');
  return {
    agent,
    basePolicy: structuredClone(basePolicy),
    policy: {
      ...(basePolicy as Record<string, Json>),
      network_policies: {
        ...(basePolicy.network_policies as Record<string, Json>),
        provider_anthropic: {
          endpoints: [
            {
              host: 'api.anthropic.com',
              port: 443,
              protocol: 'rest',
              access: 'full',
              enforcement: 'enforce',
            },
          ],
        },
      },
    },
    policySource: 'sandbox',
    policyHash: 'sample-policy-hash',
    configRevision: 7,
    providers: name === 'daily-curator' ? [snapshot.providers[1]] : [snapshot.providers[0]],
  };
}

export const sampleLogs = `[1791220550.142] [sandbox] [OCSF] NET:OPEN [INFO] ALLOWED /usr/bin/curl -> docs.rs:443 [policy:documentation engine:opa]
[1791220551.026] [sandbox] [OCSF] HTTP:GET [INFO] ALLOWED GET https://docs.rs [policy:documentation]
[1791220612.309] [sandbox] [OCSF] NET:OPEN [MED] DENIED /usr/bin/curl -> unlisted.example.invalid:443 [reason:no matching policy]
[1791220684.011] [gateway] [OCSF] CONFIG:UPDATE [INFO] Applied policy revision 3

Sample events. No token or credential-use totals are reported by this CLI.`;
