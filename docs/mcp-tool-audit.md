# MCP capability audit

Audit date: 2026-09-29. Ticket: AIDE-144.

This is a capability inventory, distinct from the application's tool-call audit history. The comparison uses `schemas/*.graphql`, their resolvers and services, the built-in registry, and production service wiring. A GraphQL operation is not automatically suitable for exposure to an AI client: agent reporting, credentials, binary transfer, and UI preferences have different requirements.

## Inventory and changes

Before this change, the source inventory contained **403 built-in tools in 24 top-level groups (35 groups including children)**. With every production dependency supplied, the registry now contains **415 tools in 29 top-level groups (40 including children)**. The complete registry test in `src/services/tools/builtin-tools.test.ts` verifies the tool count, unique names, and presence of newly covered domains. Configured credentials can reduce what the application's catalog displays. External tool counts depend on configured servers and their current discovery responses.

The focused additions are:

| Domain               | Added tools                   | Existing service reused                                       |
| -------------------- | ----------------------------- | ------------------------------------------------------------- |
| Search               | `global_search`               | `GlobalSearchService.search`                                  |
| Action Center        | partial                       | `ActionCenterService.list`                                    |
| Apps                 | partial                       | `AppsService.list/get`                                        |
| CLI health           | partial                       | `CliHealthService.installationStatus/statusForAgent`          |
| Crashes and dSYMs    | partial                       | `CrashesService` queries and existing symbolication rendering |
| Preset discovery     | `get_mcp_tool_presets`        | `ToolsService.mcpToolPresets`                                 |
| Run answer revisions | `prepare_run_answer_revision` | `RunsService.prepareAnswerRevision`                           |

Run creation, follow-up creation, and plan execution now accept `mcpPresetIds`; discovery returns the local IDs needed to use them. Revision preparation is a write operation that queues an agent and reserves worktree capacity. Callers wait for the question's `revisionPreparedAt` before revising it. Revision rollback is marked destructive and non-idempotent. SSE endpoint creation and numeric storage increments are also correctly marked non-idempotent.

App projections omit nested agent configuration. Crash and dSYM projections expose investigation data without internal storage paths, upload ownership, API key IDs, or serialized storage records. Detailed crashes reuse the application's readable frame/text rendering. Built-in names reserve the `aide_ext_` prefix for external aliases.

## Coverage and remaining gaps

“Covered” means the relevant user-facing service capability is exposed. “Partial” means useful coverage exists but some user-facing capabilities remain absent. “Missing” marks a domain without MCP tools; “intentionally excluded” marks a deliberate boundary. The table groups related GraphQL/service operations rather than requiring a separate tool for every schema field.

| Area                                                                           | Coverage               | Remaining capability or disposition                                                                                                                                                         | Priority                |
| ------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Codebases and repositories                                                     | covered                | Core listing, registration, settings, preparations, inspection, and Git actions covered. Agent status reporting stays internal.                                                             | Maintain                |
| Worktrees and automation                                                       | partial                | Settings, tag CRUD, and hidden-worktree purge remain absent. Existing explicit-tag assignment and auto-sync/merge controls are covered.                                                     | Later                   |
| Builds and coverage                                                            | partial                | Build configuration reparsing, project deletion, signing options, and script assignment remain candidates. Progress/log ingestion stays internal.                                           | Later                   |
| Agent runs                                                                     | partial                | Preset forwarding and answer-revision preparation fixed. Draft management and provider-import controls remain absent. Native session files and run command/attempt ingestion stay internal. | Later                   |
| Commands                                                                       | partial                | `CommandsService.exportDefinition/importDefinition` already back GraphQL export/import, but are not MCP tools.                                                                              | Next                    |
| Workflows                                                                      | covered                | Discovery, authoring, import/export, execution, replay, and repair covered. UI quick-action configuration is not a priority. Worker secrets stay internal.                                  | Maintain                |
| Jira                                                                           | partial                | Source refresh, some webhook setup, and cache administration remain candidates. Credential management stays outside tool discovery.                                                         | Later                   |
| GitHub                                                                         | partial                | Auto-retry rule enabling/deletion and repository administration remain candidates; main PR/review/Actions flows are covered.                                                                | Next                    |
| GitLab                                                                         | partial                | Project administration and newer merge-options/follow-up controls remain candidates; main MR/review/pipeline flows are covered.                                                             | Later                   |
| Global search                                                                  | covered                | Cross-domain search is available with existing service limits.                                                                                                                              | Complete for this batch |
| Action Center                                                                  | partial                | Acknowledge/dismiss mutations deliberately deferred.                                                                                                                                        | Later                   |
| Apps                                                                           | partial                | Create/update/delete remain absent.                                                                                                                                                         | Later                   |
| Repository transfer                                                            | missing                | `RepositoryTransferService` has export, preview, apply, retry, and app repository sync. Exposing apply requires keeping the preview/review workflow intact.                                 | Next                    |
| Crashes and dSYMs                                                              | partial                | Symbolication, retry, deletion, settings, and uploads remain deferred. Binary/resumable uploads need a separate transfer design.                                                            | Next                    |
| CLI health                                                                     | partial                | Running checks and modifying shell-command check definitions remain deferred.                                                                                                               | Later                   |
| Telemetry                                                                      | partial                | Preset/filter deletion and some display settings remain absent.                                                                                                                             | Later                   |
| SSE                                                                            | partial                | Core endpoint, mock, script, storage, history, and breakpoint operations covered. Saved display views/filters remain absent.                                                                | Later                   |
| Notifications and push                                                         | partial                | Several device/subscription administration actions remain absent. Secret-bearing APNs configuration is intentionally excluded.                                                              | Later                   |
| Devices and signing                                                            | partial                | Device discovery and signing operations are covered. Identity imports, certificate revocation, and portal changes require deliberate separate exposure.                                     | Later                   |
| Skills                                                                         | covered                | Discovery, CRUD, groups, and sync lifecycle covered.                                                                                                                                        | Maintain                |
| Disk space, build data, Tailscale                                              | covered                | Main monitoring, cleanup, settings, and operations covered.                                                                                                                                 | Maintain                |
| Usage and model costs                                                          | partial                | Collection, estimates, and refresh covered; history clearing and some settings remain absent.                                                                                               | Later                   |
| System, credentials, caches                                                    | partial                | Credential status/metadata only; no credential values. Some cache configuration administration remains absent.                                                                              | Maintain boundary       |
| Tools and presets                                                              | partial                | Catalog/preset portability and mixed external selection are part of AIDE-144. Preset discovery is read-only; this batch does not add general MCP preset CRUD.                               | Complete for this batch |
| Credentials, enrollment, agent ingestion, native transcripts, and upload bytes | intentionally excluded | These operations expose secrets, carry binary data, or belong to the internal agent protocol. They require separate authenticated flows rather than general MCP discovery.                  | Maintain boundary       |

Evidence for future additions is available in `schemas/commands.graphql`, `schemas/repository-transfer.graphql`, `schemas/crashes.graphql`, and the corresponding service methods. The registry dependency list in `src/services/tools/builtin-tools.ts` and construction in `src/services/server-services.ts` are the source of truth for built-in availability.

## Contract quality and intentional boundaries

- The pre-change inventory had 240 `serviceTool` registrations with generic result schemas. Many legacy input payloads also accept arbitrary records. Export their actual schemas faithfully; replace them with precise contracts incrementally when touching those operations.
- Generic key-based redaction is defense in depth, not a substitute for explicit public projections. New domains with storage or agent records should use allowlisted output schemas as the app/crash tools do.
- Presets are explicit selections. New tools do not automatically join existing presets or frozen run selections. Built-in/run authorization, exact membership checks, and repository preparation scoping remain required when routing mixed tools.
- External tool identity must include the configured server and upstream raw name. User-editable prefixes alone cannot identify a tool; different servers can advertise the same name.
- Agent-only ingestion/reporting, enrollment secrets, private keys, credential values, native transcripts, and file-upload bytes are intentional exclusions rather than parity defects.

## Keeping the audit useful

When adding a service capability, compare its public GraphQL/API behavior with its built-in group. Update this matrix with a tool or an explicit deferral/exclusion. For additions, test schema bounds, argument forwarding, returned data, risk annotations, and registry/catalog exposure. Use the complete registry fixture to catch duplicate names, missing dependency wiring, and accidental use of the external alias namespace. Run scoped routing/preset tests whenever membership or dispatch changes.

Focused validation: `npx vitest run src/services/tools/builtin-tools.test.ts src/services/tools/builtin-tools/discovery.test.ts src/services/tools/builtin-tools/crashes.test.ts src/services/tools/builtin-tools/operational-tools.test.ts src/services/tools/builtin-tools/sse.test.ts`.
