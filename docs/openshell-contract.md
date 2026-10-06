# Inspected OpenShell contract

Validated against installed `openshell 0.1.2` and the official `v0.1.2` source at
commit `6648bd0c290efbc41ba131ee9831ee45cd431f94` on 2026-10-05. The latest stable
release at discovery was also 0.1.2. This is a dated contract, not a claim that
future OpenShell releases preserve every field.

| ShellGuardian surface | CLI operation | Contract |
| --- | --- | --- |
| Installed version | `openshell --version` | Parse semantic version |
| Gateway selector | `gateway list --output json` | Registered names, endpoint/auth/remote metadata |
| Connection status | `status --output json` | Separate reachability, authentication, gateway version |
| Agents | `sandbox list --output json --page-size 100` | `sandboxes`, `next_page_token` |
| Agent access | `sandbox get NAME --output json` | Effective `policy`, phase and policy revision metadata |
| Editable policy | `policy get NAME --base --output json` | `policy`, `hash`, `config_revision`, `policy_source` |
| Providers | `provider list --output json --page-size 100` | Summaries with `credential_keys`, never values |
| Attachments | `sandbox provider list NAME --output json --page-size 100` | Attached provider summaries |
| Lifecycle | `sandbox start NAME`, `sandbox stop NAME` | CLI waits for readiness/stopped state |
| Provider access | `sandbox provider attach/detach NAME PROVIDER --wait --timeout 30 --output json` | Wait for acknowledged new-process config |
| Apply policy | `policy set NAME --policy FILE --wait --timeout 30` | OpenShell schema validation and runtime load |
| Recent activity | `logs NAME -n 150 --since 1h` | Bounded human-readable log window |

Every scoped operation prefixes `--color never --gateway NAME --workspace NAME`.
All resource arguments are validated and requests never use `--gateway-insecure`,
`--all-workspaces`, or global policy write flags.

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

Remote connections reuse OpenShell's gateway registrations, including its SSH,
mTLS, edge/OIDC authentication flows. ShellGuardian passes a registered gateway
name rather than building a parallel remote connection manager. Physical remote
host acceptance has not yet been performed.
