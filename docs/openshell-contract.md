# Inspected OpenShell contract

Validated against installed `openshell 0.1.2` and the official `v0.1.2` source at
commit `6648bd0c290efbc41ba131ee9831ee45cd431f94` on 2026-10-05. The latest stable
release at discovery was also 0.1.2. This is a dated contract, not a claim that
future OpenShell releases preserve every field.

| ShellGuardian surface | CLI operation                                                                    | Contract                                               |
| --------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Installed version     | `openshell --version`                                                            | Parse semantic version                                 |
| Gateway selector      | `gateway list --output json`                                                     | Registered names, endpoint/auth/remote metadata        |
| Connection status     | `status --output json`                                                           | Separate reachability, authentication, gateway version |
| Agents                | `sandbox list --output json --page-size 100`                                     | `sandboxes`, `next_page_token`                         |
| Agent access          | `sandbox get NAME --output json`                                                 | Effective `policy`, phase and policy revision metadata |
| Editable policy       | `policy get NAME --base --output json`                                           | `policy`, `hash`, `config_revision`, `policy_source`   |
| Providers             | `provider list --output json --page-size 100`                                    | Summaries with `credential_keys`, never values         |
| Attachments           | `sandbox provider list NAME --output json --page-size 100`                       | Attached provider summaries                            |
| Lifecycle             | `sandbox start NAME`, `sandbox stop NAME`                                        | CLI waits for readiness/stopped state                  |
| Provider access       | `sandbox provider attach/detach NAME PROVIDER --wait --timeout 30 --output json` | Wait for acknowledged new-process config               |
| Apply policy          | `policy set NAME --policy FILE --wait --timeout 30`                              | OpenShell schema validation and runtime load           |
| Recent activity       | `logs NAME -n 150 --since 1h`                                                    | Bounded human-readable log window                      |

Every scoped operation prefixes `--color never --gateway NAME --workspace NAME`.
All resource arguments are validated and requests never use `--gateway-insecure`,
`--all-workspaces`, or global policy write flags.
An app-owned SSH session additionally supplies a native-generated loopback
`--gateway-endpoint`; the selected registered profile still supplies mTLS material.

Source evidence:

- [CLI sandbox and policy JSON](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-cli/src/run.rs)
- [Provider summaries and attachment acknowledgement](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-cli/src/commands/provider.rs)
- [Status and gateway metadata](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-cli/src/commands/gateway.rs)
- [Policy schema](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/docs/how-it-works/policies/schema.mdx)
- [Sandbox logging](https://docs.nvidia.com/openshell/latest/observability/overview)
- [Official releases](https://github.com/NVIDIA/OpenShell/releases)

The release's CLI and gateway protobuf surface contain no inference input/output
token counters, billing totals, or per-provider credential-use counters. Sandbox
summary/detail JSON also omits workload images and resource usage. Do not invent
metrics from policy revisions, attachment counts, or log-line counts. Older
documentation describing the legacy `inference.local` command path should not be
used to invent a current `openshell inference` command; this release manages
native provider access through profiles and attachments.

## SSH registration and transport

The inspected OpenShell 0.1.2 SSH registration records remote metadata and gateway
authentication; it does not keep an SSH tunnel open for ShellGuardian's scoped
CLI requests. Direct registered gateways, including edge/OIDC profiles, continue
to use OpenShell's connection behavior. App-created SSH sessions require an
explicitly selected registered mTLS profile for the remote server.

ShellGuardian invokes OpenSSH with fixed forwarding arguments and strict host-key
checking. It uses existing key/agent authentication and a trusted `known_hosts`
entry; host aliases retain their SSH port unless the user overrides it. The
default remote OpenShell port is 17670, forwarded from an app-selected local port
to the remote machine's `127.0.0.1` interface.

Only native code constructs `https://127.0.0.1:<local-port>` and supplies it with
`--gateway-endpoint`. OpenShell continues to verify the gateway's TLS certificate
and client authentication. A loopback certificate must include IP SAN `127.0.0.1`
for this endpoint; a `localhost` DNS SAN alone is insufficient. ShellGuardian
does not add `--gateway-insecure`, copy certificates, or rewrite registrations.

A successful tunnel must pass an authenticated OpenShell status request. Session
IDs bind subsequent reads and changes to that profile and process; stale or dead
IDs never fall back to direct access. Leases span complete operations so explicit
disconnect waits for them. App exit kills/reaps owned SSH children, and no session
state persists across app restarts.

On 2026-10-06, a native fixture verified an authenticated gateway read through the
tunnel, explicit disconnect, listener cleanup on normal app close, and SSH session
death with no fallback to the healthy direct gateway. Active CLI registrations
were unchanged. Physical remote-host and live agent-mutation acceptance remain
unverified.
