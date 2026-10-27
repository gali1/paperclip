# Agent integration + discovery: implementation report

Date: 2026-10-27. Repository: `/home/bro/paperclip` (branch as checked out).

## 1. Initial assessment

Paperclip is a TypeScript monorepo (pnpm) with an Express server
(`server/src`), a React UI (`ui/src`), adapter packages
(`packages/adapters/*`), a Drizzle/Postgres data layer (`packages/db`), and a
Docker image that binds `0.0.0.0:3100`.

What already worked:

- Adapters for `hermes_local`, `hermes_gateway`, `openclaw_gateway`,
  `opencode_local`, `claude_local`, `codex_local`, `gemini_local`,
  `kimi_local`, `grok_local`, `pi_local`, `cursor`, `paperclip_runner`.
- Per-adapter `testEnvironment` (installation/auth/model checks) behind
  `POST /api/companies/:companyId/adapters/:type/test-environment`.
- Remote/sandbox execution targets, ACP client support (`acp` descriptor,
  `engine="acp"`, ACPX), MCP client/server, company skills with install/sync,
  session compaction/resume, tool policy + approvals + audit.
- Docker binds `0.0.0.0` and publishes 3100 in both Compose files.

What was missing or wrong:

1. No discovery. Adapters could test a configuration the user had already
   written; nothing enumerated installations, services, or containers.
2. No deployment awareness. Nothing in the server knew that `127.0.0.1` from
   inside a container is not the host, so host-native agents were unreachable
   unless the user manually wrote `host.docker.internal`.
3. `docker/docker-compose.yml` had no host-gateway mapping, so that hostname did
   not resolve on Linux even when a user knew to use it.
4. Failures were per-check messages with no notion of "installed vs running vs
   reachable vs validated", and no way to tell an unpublished port from a
   missing agent.
5. No recorded inventory of what OpenCode/Hermes provide, so "absorption" work
   had no baseline.

## 2. Root causes

| Symptom | Cause |
| --- | --- |
| Agent "not found" on a Docker install | Loopback in the container resolves to the container; nothing rewrote candidate loopback endpoints to the host gateway. |
| Agent found but unusable | Discovery did not exist; the UI only tested configs the user had typed, so endpoint/flags were guesses. |
| Containerized agent invisible | `testEnvironment` validates a config, not the host; nothing inspected published ports. |
| Linux `host.docker.internal` unresolved | No `extra_hosts: host-gateway` mapping in Compose; Docker Desktop provides it, plain Linux Docker does not. |
| `hermes --version` looked like a missing/foreign binary | The CLI takes ~30 s to start on a loaded machine, far beyond a 4 s probe; there was no non-executing identity fallback. |

## 3. Implemented changes

Server:

- `server/src/services/agent-discovery/` — new staged discovery service
  (deployment detection, host-gateway resolution, descriptor catalog, bounded
  probes, dedupe, ranking, cache, adapter validation).
- `server/src/routes/agent-discovery.ts` — three read-only endpoints, mounted in
  `server/src/app.ts` with the server's bind/port/public URL.
- `server/src/app.ts` — mounts the new router next to `adapterRoutes`.

UI:

- `ui/src/api/agents.ts` — `discover` and `deploymentDiagnostics` clients plus
  the report types.
- `ui/src/components/agent-discovery/AgentDiscoveryPanel.tsx` — detect/scan,
  candidate list with evidence, "Use this" adoption.
- `ui/src/components/new-agent/NewAgentSetup.tsx` — panel wired to the Hermes
  gateway URL field.

Deployment:

- `docker/docker-compose.yml`, `docker/docker-compose.quickstart.yml` —
  `extra_hosts: ["host.docker.internal:host-gateway"]`.
- `.env.example` — documents `PAPERCLIP_HOST_GATEWAY` and the resolution order.

Documentation:

- `docs/specs/agent-discovery.md` — behaviour, API, deployment matrix, security,
  limitations.
- `docs/specs/hermes-opencode-feature-inventory.md` — Section-14 inventory with
  classifications.
- `THIRD_PARTY_NOTICES.md` — provenance and licensing.

## 4. Agent compatibility (verified)

| Agent | Method | Verified how |
| --- | --- | --- |
| Hermes CLI | PATH/known dirs → `--version`, else entry-point identity | Live run on this host found `/home/bro/.local/bin/hermes` and parsed `Hermes Agent vgit.e0130b2.dirty …` |
| Hermes gateway | HTTP probe of documented ports 8642 / 9119 (`/api/health`) | Unit tests for probe/rewrite paths; not against a running gateway here |
| OpenCode CLI | PATH → `opencode --version` | Descriptor + unit tests (no live install probed) |
| OpenCode server | HTTP probe 4096 `/global/health` | Descriptor only |
| OpenClaw gateway | HTTP reachability on 18789, `ws://` config patch | Unit test asserts the ws:// patch |
| Claude/Codex/Gemini/Kimi/Grok/Pi/Cursor | PATH → `--version` with identity pattern | Descriptors only |

"Docker CLI present" was exercised on this host (`containers_inspected` ran);
zero containers matched, so no container candidate was produced.

## 5. Deployment behaviour

- Native: loopback is this machine; CLI agents are found on PATH; containerized
  agents are reached on their published ports via `127.0.0.1`.
- Container: loopback is the container; candidates are also probed through
  `PAPERCLIP_HOST_GATEWAY` → `PAPERCLIP_HOST_FROM_CONTAINER` →
  `host.docker.internal` → `/proc/net/route` gateway → `gateway.docker.internal`.
  A loopback bind inside a container is reported as an error by the deployment
  checks.
- Explicit user configuration is never overridden: discovery returns a
  `configPatch`; adoption is a separate, explicit action, and registered agent
  config wins during dedupe.

## 6. Security

- Routes require board org access + company access.
- No credentials are returned; endpoints are sanitized; `requiredInputs`
  replaces secret values.
- Only `--version` is executed; identity must match, otherwise the candidate is
  flagged. No shell is used.
- Container inspection only runs `docker ps`.
- Nothing writes configuration, starts processes, edits firewall rules, or
  changes bind addresses.

## 7. Testing

| Suite | Result |
| --- | --- |
| `server` discovery unit tests | 35 passed (deployment, probes, service) |
| `ui` discovery panel tests | 3 passed |
| `docker compose config` (both files) | valid; `extra_hosts` rendered |
| Live smoke on this host | native mode, Hermes CLI found and version parsed, container stage ran |
| Full `tsc --noEmit` (server) | see note below |
| `pnpm --filter @paperclipai/server typecheck` | blocked: the script builds the Rust runner and `cargo` is not installed here |
| Route-level supertest | not run: supertest cannot complete a loopback request in this sandbox (existing route tests hang identically) |

## 8. Files changed

| File | Purpose |
| --- | --- |
| `server/src/services/agent-discovery/types.ts` | Report/candidate/deployment contracts |
| `…/deployment.ts` | Container detection, gateway resolution, bind checks |
| `…/catalog.ts` | Per-adapter discovery hints |
| `…/probes.ts` | PATH lookup, version/file identity, HTTP/TCP probe, docker ps |
| `…/service.ts` | Staged sweep, dedupe, ranking, validation, cache |
| `…/index.ts` | Exports |
| `server/src/routes/agent-discovery.ts` | HTTP API |
| `server/src/app.ts` | Route mount |
| `ui/src/api/agents.ts` | API client + types |
| `ui/src/components/agent-discovery/AgentDiscoveryPanel.tsx` | Detection UI |
| `ui/src/components/new-agent/NewAgentSetup.tsx` | Hermes gateway adoption |
| `docker/docker-compose*.yml` | Host-gateway mapping |
| `.env.example` | `PAPERCLIP_HOST_GATEWAY` documentation |
| `docs/specs/*`, `THIRD_PARTY_NOTICES.md` | Documentation |

## 9. Remaining limitations

- A host-native stdio CLI cannot be executed from inside the Paperclip
  container. Discovery reports this and suggests the gateway/API path.
- Agents bound to host loopback are unreachable from a container by design.
- Non-standard ports require explicit endpoints/overrides.
- Docker discovery needs the CLI and daemon permission.
- Not implemented from the feature inventory: native scoped memory, ACP server
  role, unified skill-format validator, provider capability matrix. They are
  classified in `docs/specs/hermes-opencode-feature-inventory.md`; none was
  claimed as done.

## 10. Deployment instructions

Native:

```bash
pnpm install
pnpm --filter @paperclipai/server dev   # or: pnpm build && pnpm start
```

Docker (LAN-first, UI on `http://<host>:3100`):

```bash
cd docker
export BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
docker compose -f docker-compose.quickstart.yml up --build
```

Host-native agents reachable from the container must listen on `0.0.0.0`
(not `127.0.0.1`); Paperclip reaches them via `host.docker.internal`.

## 11. Rollback

The change is additive: one new router mount, one UI panel, two Compose keys,
and new files. To revert:

```bash
git checkout -- server/src/app.ts ui/src/api/agents.ts \
  ui/src/components/new-agent/NewAgentSetup.tsx \
  docker/docker-compose.yml docker/docker-compose.quickstart.yml .env.example
rm -rf server/src/services/agent-discovery server/src/routes/agent-discovery.ts \
  ui/src/components/agent-discovery docs/specs/agent-discovery.md \
  docs/specs/hermes-opencode-feature-inventory.md THIRD_PARTY_NOTICES.md
```

No schema migration, no persisted configuration change, no data migration, so
existing installations and agent configs are untouched. Removing
`extra_hosts` only removes a hostname alias; it does not affect published ports.
