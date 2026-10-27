# Feature inventory: OpenCode and Hermes-Agent vs Paperclip

Scope: what the two reference projects actually implement (verified by reading
their trees at `/home/bro/opencode` and `/home/bro/hermes-agent`), and how each
capability maps onto Paperclip today.

Classification:

- **A — present**: Paperclip already provides an equivalent.
- **B — partial**: an equivalent exists but the listed gap remains.
- **C — missing, beneficial**: worth porting; see the ported/not-ported note.
- **D — not worth porting**: with the reason.

## Licensing

All three projects are MIT (Paperclip © Paperclip AI, OpenCode © opencode,
Hermes-Agent © Nous Research). Reuse is permitted with attribution. Everything
in this work was **reimplemented from observed behaviour**, not copied; no
source files, prompts, or schemas were transplanted. See `THIRD_PARTY_NOTICES.md`.

## 1. Built-in tools

### OpenCode (`packages/opencode/src/tool/`, registry in `tool/registry.ts`)

`read`, `write`, `edit`, `patch` (apply_patch), `anchored_edit`, `glob`, `grep`,
`shell`, `task` (sub-agent), webfetch (`fetch`), websearch (`search`), `todo`,
`skill`, `question`, `lsp`, `plan`, `mempalace` (memory), `invalid`, and an
optional `execute` code-mode tool. Plugins can register more (`custom`).

### Hermes-Agent (`tools/*_tool.py`, 279 files in `tools/`)

`terminal`, `code_execution`, `browser` (+ `browser_cdp`, `browser_dialog`,
`browser_vault`), `computer_use`, file/preview tooling (`open_preview`,
`read_preview`, `close_preview`, `annotate_preview`, `apply_layout`,
`drive_preview`, `focus_pane`, `read_window`, `read_terminal`,
`close_terminal`), `delegate` (sub-agents), `clarify`, `todo`, `memory`,
`session_search`, `skills`, `skill_manager`, `mcp`, media (`image_generation`,
`video_generation`, `tts`, `audio`), messaging (`send_message`,
`react_to_message`, `discord`, `feishu_doc`, `feishu_drive`), `x_search`,
`tour`, `tip`.

### Paperclip

- Harness-side tools are delivered per run through the runner tool authority
  (`server/src/services/native-runtime/paperclip-runner-tool-authority.ts`) and
  the adapter contract; each adapter brings its own harness tools.
- External tools go through the MCP registry and the tool gateway
  (`server/src/services/tool-gateway.ts`, `packages/mcp-server`).
- A real permission/approval/audit engine already exists:
  `server/src/services/tool-access-policy.ts` with `toolPolicies`,
  `toolActionRequests`, `toolInvocations`, `toolAccessAuditEvents`.

**Classification:** tool *execution* and *governance* = **A**. A single
provider-agnostic tool schema registry that normalizes tool-call formats across
providers = **B** (Paperclip delegates model calls to the harness; it does not
own a cross-provider tool-call normalizer, and does not need one while harnesses
own the loop). Portable media/browser tools = **C**, covered by existing MCP
servers rather than new native tools. Hermes' desktop/preview toolset = **D**
(host-UI specific, not meaningful for a server-side orchestrator).

## 2. Skills

### OpenCode (`packages/core/src/skill/`, `packages/opencode/src/skill/`)

Markdown `SKILL.md` with YAML frontmatter, discovered from bounded directories,
loaded on demand, injected as guidance; a `skill` tool lets the model pull one.

### Hermes-Agent (`skills/`, `optional-skills/`)

`SKILL.md` with YAML frontmatter (`name`, `description`, `version`, `author`,
`license`, `platforms`, `metadata.hermes.tags`), grouped in category folders,
plus a `skill_manager` tool and progressive disclosure through `skill_view`.

### Paperclip

A/B: Paperclip has a full company skill system — catalog, install, per-agent
assignment/sync, GitHub skill sources, snapshots, test runs
(`server/src/services/company-skills.ts`, `skill-sources.ts`, `skills-catalog.ts`),
and adapters implement `listSkills`/`syncSkills` (Hermes and OpenCode adapters
both sync skills into the harness). Format compatibility with `SKILL.md` = **A**.
Missing: a unified compatibility validator that reports per-skill differences
between the two upstream formats and Paperclip's — **C** (documented, not ported;
the adapter sync paths already cover the practical case).

## 3. Memory

### Hermes-Agent

`agent/memory/` implements a real subsystem: `store.py`, `graph.py` (entities +
relations), `evidence.py`, `ranking.py`, `temporal.py`, `contradiction.py`,
`dedup.py`, `mining.py`, `context.py`; `agent/memory_manager.py` orchestrates
providers with session-scoped `prefetch` / `sync` / `on_session_end`, and
`plugins/memory/` ships provider backends (byterover, holographic, rekal,
retaindb). A `memory` tool exposes explicit operations.

### OpenCode (this fork)

`mempalace` tool with `memory_recall`, `memory_search`, `memory_similar`,
`memory_related`, `memory_link`, `memory_conflict(s)`, `memory_delete`,
`memory_health`; Hindsight-derived retrieval with evidence and contradiction
detection (`tool/mempalace_hindsight.py`, `mempalace_rekal_engine.py`).

### Paperclip

**B**: memory is available only as an external MCP provider (Cognee
`remember`/`recall`/`forget`, `server/src/services/cognee-connection.ts`). There
is no native, scoped (session/project/user), provider-independent memory store
with retrieval, redaction, and user-visible injection.

**C — highest-value gap.** A full port (graph + contradiction detection +
multiple provider backends) is large and duplicates provider functionality; the
recommended port is the *contract*: scoped store, explicit CRUD/search, token-
budgeted injection, redaction, purge — which any provider can back. Not
implemented in this change.

## 4. ACP (Agent Client Protocol)

### OpenCode (`packages/opencode/src/acp/`)

Server side: `service.ts` (session lifecycle), `agent.ts`, `session.ts`,
`permission.ts`, `tool.ts`, `content.ts`, `event.ts`, `usage.ts`,
`config-option.ts`, `directory.ts`. Sessions are created/loaded/resumed/forked
over stdio; tool calls and permission requests stream to the client.

### Hermes-Agent (`acp_adapter/`)

Server side: `server.py`, `session.py`, `events.py`, `permissions.py`,
`edit_approval.py`, `tools.py`, `model_catalog.py`, `auth.py`, `commands.py`,
`content.py`, `provenance.py`, with `__main__.py` as the stdio entry point.

### Paperclip

**A as client.** Adapters declare `acp?: AcpTargetDescriptor`
(`packages/adapter-utils/src/types.ts`), `claude_local`/`codex_local` can run
`engine="acp"`, `paperclip_runner` drives ACPX
(`packages/adapter-utils/src/acpx-engine`, `native-runtime/acpx-qualification.ts`),
and discovery can now locate ACP-capable agents by executable/endpoint.
**C as server.** Paperclip does not expose its own tools/skills/memory over ACP
to editors. Not implemented in this change (it needs a permission-gated ACP
server surface, and Paperclip's tool policy engine would have to be the
authority; the ACP spec must be read in full first).

## 5. MCP, plugins, hooks, commands, permissions

| Capability | OpenCode | Hermes | Paperclip |
| --- | --- | --- | --- |
| MCP | `packages/core/src/config/mcp.ts`, per-server config, OAuth tests | `mcp_serve.py`, `optional-mcps/` | **A** — MCP client/server, tool gateways, per-tool policies, ask-first approvals |
| Plugins | plugin hooks + custom tools (`tool/registry.ts` `fromPlugin`) | `plugins/`, `plugin-catalog/` | **A** — plugin SDK, worker manager, job scheduler, UI slots |
| Slash commands | `packages/opencode/src/command`, `acp/commands.ts` | `hermes_cli` command surface | **A** for harness commands; **D** to unify (UI-specific) |
| Permission model | `permission/` (per-tool allow/ask/deny) | `tools/approval*.py` (floors, detection, gateway) | **A** — richer: policies, grants, action requests, audit |

## 6. Provider and model abstraction

- **OpenCode**: provider registry, per-model capability metadata, streaming parts
  (`text`, `reasoning`, `tool`), token accounting, context limits.
- **Hermes**: `providers/` with per-provider adapters, model metadata, reasoning
  content handling, usage accounting, toolset distributions
  (`toolsets.py`, `toolset_distributions.py`).
- **Paperclip**: **B**. It normalizes *harnesses*, not providers: adapters own
  provider calls and Paperclip stores `aiConnections` + provider profiles
  (`native-runtime/provider-profile.ts`). Model capability checks exist per
  adapter (`testEnvironment`, `models`), but there is no single capability matrix
  shared by tools/skills/memory. Porting a full provider layer would duplicate
  the harnesses; the useful subset (capability detection + graceful degradation)
  is **C**.

## 7. Sessions, resumption, compaction

- OpenCode: session store, resume, fork, revert, summarization; ACP session
  lifecycle.
- Hermes: session database (`hermes_state_sessions.py`), resume, rewind,
  checkpointing (`tools/checkpoint_manager.py`), trajectory compression
  (`trajectory_compressor.py`), FTS search (`hermes_state_fts.py`).
- Paperclip: **A** — `session-compaction.ts`, `native-session-resume.ts`,
  `native-session-executor.ts`, per-adapter session codecs, restart recovery
  (`native-restart-recovery.ts`), checkpoint/backup handling.

## 8. Scheduling, messaging, delegation

- OpenCode: `task` sub-agent tool; no scheduler.
- Hermes: `cron/`, `gateway/` (Telegram, Slack, Discord, Teams, web),
  `delegate` sub-agents, `send_message`, routines.
- Paperclip: **A** — routines, approvals, chat channels (Slack/Teams/Discord/
  Telegram), child issues and delegation, native question bridge.

## 9. Discovery and connectivity (the subject of this change)

Neither reference project solves "find any agent regardless of where it runs".
OpenCode has no agent discovery; Hermes documents gateway URLs by hand. Paperclip
previously had per-adapter environment tests only.

**C — implemented in this change.** See `docs/specs/agent-discovery.md`.

## Summary

| Area | Status |
| --- | --- |
| Tool execution + permission/audit | A |
| MCP | A |
| Skills (discovery, install, sync, per-agent) | A |
| ACP client | A |
| Sessions/compaction/resume | A |
| Scheduling/messaging/delegation | A |
| Native scoped memory | **B/C — not ported** |
| ACP server role | **C — not ported** |
| Provider-agnostic capability matrix | **B** |
| Unified skill-format compatibility validator | **C — not ported** |
| Agent discovery + deployment-aware connectivity | **C — ported (this change)** |
