# MCP and workflow capability audit

Audit date: 2026-10-28. Ticket: AIDE-163.

This inventory compares existing user-facing GraphQL/service capabilities and application events with the built-in MCP registry and workflow catalog. It does not require agent reporting, credentials, binary transfer, or browser enrollment APIs to become general-purpose tools.

## Current inventory

With all production dependencies supplied, the registry contains **560 MCP tools in 30 top-level groups**. Workflows expose **345 step kinds, 124 trigger kinds, and 18 resource kinds**. Availability still depends on configured providers, and saved presets remain explicit selections: additions do not automatically enter existing presets or frozen run selections.

The registry tests verify exact counts, unique proxy-safe names, risk annotations, and production-domain wiring. Workflow tests verify kind/catalog/config consistency. Capability-action tests compare each dedicated action's fixed tool name, accepted arguments, required arguments, and write effects with the actual MCP catalog.

## Capability coverage added

| Group                      | Newly exposed capabilities                                                                                                                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository transfer        | Export selection/preview, export, import preview/apply, durable operation reads/retries, app checkout coverage and sync. Apply/sync retain the reviewed fingerprint and stable request ID. Preview can queue inspection work and is marked mutating.           |
| Agent runs                 | Draft listing/detail/save/archive/delete, provider-import status, and cancellation of a pending native form while continuing the run. Native import ingestion remains agent-only.                                                                              |
| Crashes and dSYMs          | Symbolication, report/dSYM deletion, upload processing status/metadata/retry/deletion, collection/retention settings, and eligible symbolication agents. Output projections omit upload ownership and internal storage records.                                |
| Discovery domains          | Apps CRUD and memberships; Action Center refresh/acknowledge/dismiss/settings; CLI health execution and custom checks. App results retain the safe public projection.                                                                                          |
| Builds                     | Configuration reparsing, project deletion, script assignments, signing options, and eligible deployment-agent discovery/selection.                                                                                                                             |
| Commands                   | Portable definition export/import and permanent deletion where history permits. Existing archival behavior remains available.                                                                                                                                  |
| GitHub                     | Repository discovery/administration, preferences, auto-retry enable/disable/delete, webhook diagnostics, and cache administration including discoverable override operations.                                                                                  |
| GitLab                     | Project/webhook administration and preferences, richer merge options/commit messages/follow-ups, cancel auto-merge/retry follow-ups, configured external pipeline actions and execution results, and cache administration.                                     |
| Worktrees and codebases    | Tag definitions, settings, hidden-record purge, branch preview, and reviewed batch local-branch cleanup. Branch deletion preserves expected commit tips, force opt-in, and per-target outcomes. The worktree overview already includes unused tag definitions. |
| Tools and presets          | Preset CRUD, catalog/preset export, reviewed preset import, external-server metadata/configuration, and audit-history cleanup. Authentication values remain managed separately; metadata updates preserve omitted stored headers.                              |
| Notifications              | Subscription metadata/deletion/testing and native notification device discovery/rename/delete/test, plus APNs readiness. Device tokens and subscription keys are excluded.                                                                                     |
| Operational administration | Cache-server settings/testing/storage cleanup and selected integration cache/history operations; usage-history clearing; model-cost source settings; agent rename; workflow quick actions; telemetry and SSE saved-view/preset/filter management.              |

## Dedicated workflow actions

The new operation-specific workflow nodes share existing MCP implementations. Each has a fixed tool identity, catalog/editor fields, tool input validation, normal permission checks and audit context, and structured output at `steps.<stepId>.output`. Tool names cannot be substituted through workflow configuration. Generated request IDs are stable across attempts within the same workflow node.

Dedicated actions cover discovery/listing, repository/worktree setup, build configuration and scripts, command and skill authoring, agent administration, signing and build data, telemetry and notifications, caches, and the newly exposed capability groups. Existing `MCP_CALL` remains available for built-in and configured external tools. Asynchronous configuration/inspection actions return durable operation identities; result triggers or subsequent reads observe completion.

## Trigger coverage and correctness

Sixteen new trigger kinds bridge existing domain events: crashes, dSYMs, console/analytics ingestion, CLI health results, Tailscale state/operation results, repository transfers, apps, command/build-script/skill definitions, notifications, Action Center attention, and SSE endpoint/storage changes. Payloads use explicit public projections and operation identities. Workflow lifecycle notifications and workflow-owned attention are excluded from the general attention consumers to prevent self-trigger loops.

The existing trigger fixes are:

- `WORKTREE_DIRTY_DURATION` persists first-observed dirty time in the trigger cursor, resets on clean observations even when filters reject that observation, and fires once per continuous dirty interval. It defaults to 3,600 seconds and is evaluated on changes and minute audits.
- `SIGNING_ASSET_EXPIRING` evaluates at startup, on signing changes, and every minute. It defaults to an expiry threshold of 30 days and deduplicates observations without suppressing future threshold crossings.
- `BUILD_DATA_CLEANUP_RESULT` uses actual deletion-job completion, including failed/cancelled/invalid outcomes and parsed deletion results.
- `BUILD_DATA_THRESHOLD` observes fresh size changes with event identities, waits for known sizes, and supports threshold re-crossings including A-to-B-to-A size changes.

No database migration is required; timing state uses existing durable trigger cursors.

## Intentional boundaries and maintenance

Credential values, enrollment secrets, agent-only ingestion/reporting, native provider transcripts, raw upload bytes, browser subscription registration, signing identity imports, and portal certificate changes remain separate authenticated flows. These are explicit boundaries rather than missing parity items. Authored command/scripts and selected repository preparation contents are returned by their existing export operations; exports are configuration documents, not credential stores.

Some legacy tool result schemas remain generic. When changing such tools, tighten their contracts incrementally and use explicit projections rather than relying solely on key-based redaction. Preserve source-qualified external-tool identities, exact preset membership, run repository scope, and provider availability checks.

When adding an application capability, update its MCP group, dedicated workflow action where useful, event bridge where applicable, and this inventory. Test service argument forwarding, rejected inputs, safe outputs, risk annotations, registry exposure, workflow schema/path consistency, and event deduplication/threshold transitions.

## Validation for AIDE-163

The final application suite passed 3,622 tests across 478 files (two existing skips). The control-agent suite passed 389 tests across 51 files. ESLint, application/agent TypeScript checks, translation validation, formatting checks, and the production Webpack build passed. The default Turbopack build could not complete because its CSS worker was denied a local-port bind in this environment; the verified production build used the supported `--webpack` option. Tests that require local sockets/watchers were rerun with the required host access.
