# Agent discovery and deployment-independent connectivity

Status: implemented (server service, HTTP API, UI panel, tests).

This document describes how Paperclip finds and reaches agents regardless of
whether Paperclip itself runs on the host or in a container, and what the
operator still has to decide.

## Problem

Before this change, every adapter could only *test a configuration the user had
already written*. Nothing enumerated what existed on the machine, nothing
distinguished "binary installed" from "API answering" from "fully working
agent", and nothing understood that `127.0.0.1` means a different machine
depending on where Paperclip runs. The predictable results were:

- Users had to know the executable path or gateway URL up front.
- A Docker install could not see a Hermes gateway or OpenClaw gateway running
  on the host, because `http://127.0.0.1:8642` resolved to the container.
- A container whose service port was not published looked identical to a
  missing agent.
- Failures surfaced as generic connection errors with no next step.

## What was added

```
server/src/services/agent-discovery/
  types.ts        report/candidate/deployment shapes
  deployment.ts   container detection, host-gateway resolution, bind checks
  catalog.ts      per-adapter discovery hints (one entry per agent)
  probes.ts       bounded PATH lookup, --version probe, HTTP/TCP probe, docker ps
  service.ts      staged sweep, dedupe, ranking, validation, cache
  index.ts        public exports
server/src/routes/agent-discovery.ts   HTTP surface
ui/src/components/agent-discovery/     discovery panel
ui/src/api/agents.ts                   discover / deploymentDiagnostics clients
```

## Stages

The sweep is ordered and each stage records evidence, so a failure is explained
rather than guessed.

| Stage | What it inspects | Bounds |
| --- | --- | --- |
| 1. Existing configuration | Agents of that adapter type already registered in the company | one query, max 20 rows |
| 2. Local environment | Descriptor binary names on `PATH`, `~/.local/bin`, `~/.bun/bin`, `~/.npm-global/bin`, `/usr/local/bin`, Homebrew (macOS) | max 8 candidates, `--version` only, 4 s each |
| 3. Local services | Documented API ports/paths (Hermes 8642 + 9119, OpenCode 4096, OpenClaw 18789) | 2 s per endpoint |
| 4. Container runtime | `docker ps` metadata matched against image/name hints and published ports | 3 s, read-only, no socket mount |
| 5. Remote endpoints | Only URLs the caller supplied | max 8 |
| 6. Validation | The adapter's own `testEnvironment` with the derived config | max 3 candidates, 8 s each |
| 7. Register/present | Dedupe by endpoint or executable, deterministic ranking, cache | 30 s TTL, 100 entries |

Container awareness changes stages 3–5:

- Inside a container, every loopback service or endpoint is probed twice: once
  as given (it may be a sidecar in the same container) and once rewritten to
  each host-gateway candidate (`host.docker.internal`, the `/proc/net/route`
  default gateway, `gateway.docker.internal`, or `PAPERCLIP_HOST_GATEWAY`).
- On a native install, a container's published port is probed on `127.0.0.1`,
  and loopback is left alone.

## API

```
GET  /api/companies/:companyId/adapters/discovery/catalog
GET  /api/companies/:companyId/adapters/discovery/deployment[?probePort=8642]
POST /api/companies/:companyId/adapters/:type/discover
```

`discover` body (all optional):

```json
{
  "remoteEndpoints": ["https://hermes.internal:8642"],
  "configOverrides": { "apiBaseUrl": "https://hermes.internal:8642" },
  "includeContainers": true,
  "validate": true,
  "refresh": false,
  "timeoutMs": 12000
}
```

Response (abridged):

```json
{
  "adapterType": "hermes_gateway",
  "deployment": {
    "mode": "container",
    "bindHost": "0.0.0.0",
    "port": 3100,
    "hostGatewayCandidates": ["host.docker.internal", "172.17.0.1"],
    "loopbackIsProcessLocalOnly": true,
    "checks": [{ "code": "deployment_container_detected", "level": "info" }]
  },
  "candidates": [
    {
      "source": "local_api",
      "label": "Hermes API — host.docker.internal:8642 (host gateway)",
      "endpoint": "http://host.docker.internal:8642/",
      "reachable": true,
      "validated": true,
      "validationStatus": "pass",
      "configPatch": { "apiBaseUrl": "http://host.docker.internal:8642/" },
      "requiredInputs": ["apiKey"],
      "evidence": [{ "stage": "container_runtime", "code": "container_to_host_rewrite" }]
    }
  ],
  "recommendedCandidateId": "…",
  "notes": []
}
```

`GET .../deployment?probePort=` answers the concrete container question: for
this host port, which aliases can Paperclip actually reach?

## Deployment behaviour

| Paperclip | Agent | How discovery reaches it |
| --- | --- | --- |
| native | CLI on host | `PATH` + known install dirs, identity-checked with `--version` |
| native | API on host | `127.0.0.1:<documented port>` |
| native | container | published host port on `127.0.0.1`; unpublished → explicit warning |
| container | CLI on host | **not directly possible** — a container cannot execute host binaries; the report says so and offers the gateway path |
| container | API on host | `host.docker.internal` / gateway IP / `PAPERCLIP_HOST_GATEWAY` |
| container | another container | Compose service DNS or published host port via gateway |
| either | remote host | explicit endpoint, probed as given |

Binding and publishing are separate concerns. The image and Compose files bind
`0.0.0.0` and publish `3100`; `deployment.checks` flags a loopback bind inside a
container as an `error` because publishing cannot rescue it.

## Security

- Discovery is read-only. It never writes configuration, never starts a
  process, never modifies firewall rules, and never changes an agent's bind
  address.
- The only execution performed is `<binary> --version` for binaries found by
  name, with a 4 s timeout, no shell, and an identity check against the
  adapter's expected version output. A name match alone never marks a candidate
  usable.
- Credentials are never returned. Candidates expose `requiredInputs` (for
  example `apiKey`) instead of secret values, and endpoints are sanitized
  (userinfo stripped, secret-looking query parameters redacted) before being
  logged or returned.
- Container inspection uses the Docker CLI and only reads `docker ps`; it does
  not mount the socket or require privileged access. When the CLI is missing the
  stage reports `container_runtime_unavailable` and the sweep continues.
- Routes require board org access plus company access; they expose host topology
  and are therefore treated as administrative reads.

## Tests

Identity is proven without trusting a filename: the resolved binary is asked for
its version, and when that probe exceeds its 4 s budget (a Python entry point can
need 30 s just to start) discovery reads at most 8 KiB of the entry point and
matches the adapter's identity pattern instead. Nothing is executed beyond
`--version`, and a file that matches neither test stays `identity_unverified`.

`server/src/services/agent-discovery/*.test.ts` (34 tests) cover container
detection, gateway decoding, bind warnings, CLI discovery, identity mismatch,
registered-agent dedupe, container→host rewriting, unpublished ports, native
container ports, validation failure, caching, remote endpoints, slow-CLI
identity fallback, and credential redaction.
`ui/src/components/agent-discovery/AgentDiscoveryPanel.test.tsx` (3 tests)
covers probe-on-demand, adoption, and empty results.

Route-level supertest coverage was drafted and then removed: in this environment
supertest cannot complete a loopback request at all (the repository's existing
route tests hang the same way), so a route test here would assert the sandbox,
not the route. The route itself is thin: authentication via the shared helpers,
one `findServerAdapter` existence check, and delegation to the service.

## Limitations

- A stdio-only CLI agent cannot be executed from inside the Paperclip container.
  Use the agent's API/WebSocket server if it has one, run Paperclip natively with
  that agent, or point Paperclip at a remote endpoint.
- `host.docker.internal` on Linux requires the `extra_hosts` mapping now present
  in both Compose files (or `--add-host` for `docker run`). Rootless Docker and
  Kubernetes may use a different gateway; `PAPERCLIP_HOST_GATEWAY` overrides.
- An agent bound to host loopback (`127.0.0.1`) is unreachable from a container
  by design. Discovery reports this; it does not attempt to bypass it.
- Docker discovery needs the `docker` CLI and permission to reach the daemon.
  Without it, configure the endpoint explicitly.
- The sweep probes documented ports only. Non-standard ports require
  `configOverrides`/`remoteEndpoints`.

## Adding a new agent

Add one descriptor to `server/src/services/agent-discovery/catalog.ts`:
`adapterType`, `transport`, binary names, `identityPattern`, documented service
ports/paths, endpoint and credential config keys, and container image hints. No
other discovery code changes.
