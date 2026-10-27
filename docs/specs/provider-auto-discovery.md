# AUTO provider discovery

Status: implemented (server subsystem, HTTP API, GUI panel, tests).

AUTO answers one question in the provider-selection step: *what can this
Paperclip instance already reach, and what would I have to supply to use it?*
It is a discovery assistant — it never enables a provider, never writes
configuration, and never transmits a credential.

## Sources and stages

| Stage | What it inspects | Bounds |
| --- | --- | --- |
| `paperclip_config` | Environment variable **names** already referenced by this company's agents | one query, 200 agents |
| `environment` | `envKeys`/`baseUrlEnvKeys` of every signature, plus generic `*_BASE_URL` variables | in-process, no I/O |
| `config_files` | Bounded allowlist: `~/.config/opencode/auth.json`, `~/.local/share/opencode/auth.json`, `~/.config/litellm/config.yaml`, `~/.continue/config.json` | 256 KiB per file, 4 files |
| `local_services` | Documented ports for Ollama (11434), LM Studio (1234), LocalAI (8080), vLLM (8000), LiteLLM (4000) | 1.8 s per probe, 6 concurrent |
| `containers` | `docker ps` image/name hints matched to signatures, published ports | 3 s, read-only CLI |
| `endpoint_probes` | Configured base URLs (env/config/container) via model listing | 1.8 s each, 6 concurrent, 25 s scan budget |
| `normalize` | Dedupe by provider + endpoint, merge sources, rank by readiness | in-memory |

Each stage is failure-isolated: a failed stage is marked `failed` with its
message, the scan continues, and the final snapshot lists what was checked.
`skipped` means the source was unavailable (for example no Docker CLI), not that
nothing existed.

## Provider registry

`server/src/services/provider-discovery/registry.ts` holds one descriptor per
provider: credential variable names (including aliases such as `OPENAI_KEY`,
`CLAUDE_API_KEY`, `COHERE_API_KEY`/`CO_API_KEY`, `PPLX_API_KEY`), base-URL
variables, default endpoints, auth scheme, documented local ports, model-list
format (`openai` vs `ollama`), container image hints, and the mapping into
Paperclip's existing setup provider keys.

Covered out of the box: OpenAI, Anthropic, Google Gemini, Azure OpenAI, AWS
Bedrock, Mistral, Cohere, Groq, DeepSeek, xAI, Together, Fireworks, Perplexity,
OpenRouter, OpenCode Zen, Z.AI, Kimi/Moonshot, MiniMax, Ollama, LM Studio,
LocalAI, vLLM, LiteLLM, plus a generic OpenAI-compatible endpoint.

Adding a provider is a data change only.

## Classification

| Status | Meaning |
| --- | --- |
| `ready` | Endpoint answered unauthenticated and returned a model list |
| `needs_configuration` | Endpoint reached but requires a credential (401/403) |
| `compatible_unverified` | Endpoint answered but is not identifiable, or returned no models |
| `detected_unverified` | Credential/config found, but no non-billable validation exists |
| `not_reachable` | Known service identified (for example a container) but unreachable |

A present API key is **never** treated as proof: hosted providers stay
`detected_unverified`, because validating them would mean a credentialed,
potentially billable request that AUTO does not make. Public provider APIs are
never probed.

## Security

- Only environment **names** and booleans leave the scanner; values are read in
  memory to decide "present vs placeholder" and discarded. Tests assert a
  secret string never appears in the serialized snapshot.
- Probes are unauthenticated `GET`s to model-listing paths. No credential is
  ever placed in a probe, so one cannot leak to a discovered endpoint.
- Config files are read through a fixed allowlist with a bounded read; hidden
  credentials are only reduced to a boolean.
- No shell is executed against discovered content; no configuration, firewall,
  container, or service definition is modified.
- Discovered responses are treated as untrusted: model names and URLs are
  sanitized/truncated before display.
- Adopting a result only prefills the existing form (provider, model, base URL).
  Credential entry stays in the existing secure field and secret-store flow.

## API

```
GET  /api/provider-discovery/catalog
POST /api/companies/:companyId/provider-discovery/scans            → 202 snapshot
GET  /api/companies/:companyId/provider-discovery/scans/:scanId
POST /api/companies/:companyId/provider-discovery/scans/:scanId/cancel
```

Scans are in-memory, company-scoped jobs with a 15-minute TTL; polling returns
the stage list, findings, warnings, and limitations. Cancellation aborts
in-flight probes and marks the result partial.

## GUI

`ui/src/components/provider-discovery/AutoProviderDiscovery.tsx` is mounted in
the agent setup credential step (above the API-key provider field). It offers:

- an **AUTO scan** button (and rescan), with a cancel control;
- stage chips showing which sources completed, failed, or were skipped;
- a provider list with status, category, location, credential presence, endpoint,
  sources, models, requirements, and warnings;
- All / Ready / Needs-setup filtering;
- **Use this**, which hands `{providerKey, defaultModel, baseUrl}` to the form.

Unverified endpoints are never auto-selected; the button stays disabled when the
current adapter form has no matching provider field.

## Deployment differences

- Native: host environment, host files, and loopback ports are all visible.
- Container: the process sees only its own environment/files; host services are
  reached via the Docker host gateway, listed in the scan's `deployment` block.
  The scan adds an explicit limitation that host filesystem, host environment,
  and host processes were **not** inspected — it never claims a host-wide scan.
- Docker Desktop (macOS/Windows) already provides `host.docker.internal`; on
  Linux the Compose files add `extra_hosts: ["host.docker.internal:host-gateway"]`.
- Missing Docker permissions produce a `skipped` container stage and a
  limitation, not a failure or a false success.

## Tests

`server/src/services/provider-discovery/service.test.ts` (16 tests): env
credential detection, nonstandard alias, placeholder rejection, config-file
source, malformed config isolation, local server ready + models, gateway 401 →
needs configuration, unknown compatible endpoint, credential+endpoint
consolidation, no hosted probe with a key present, container → host gateway,
unavailable Docker as limitation, stage failure isolation, cancellation,
company scoping, and empty-vs-incomplete completion.

`ui/src/components/provider-discovery/AutoProviderDiscovery.test.tsx` (4 tests):
scan progress/inventory rendering, adoption without credential exposure,
needs-setup filtering, and limitation disclosure.

## Troubleshooting

- *No providers and every stage completed*: genuinely nothing configured.
- *`environment` completed but nothing found*: keys are set under an unexpected
  name — add the alias to the registry, or use a generic `*_BASE_URL` variable.
- *`local_services` completed with 0 answering*: the service is not running, is
  bound to a different interface, or uses a non-documented port. Add it as a
  base-URL variable or configure it manually.
- *`containers` skipped*: Docker CLI missing or the daemon socket is not
  permitted. Point Paperclip at the service by URL instead.
- *Container install, host provider missing*: the agent must listen on `0.0.0.0`
  on the host; verify with the scan's `deployment.hostGatewayCandidates`.
