/**
 * Deployment-aware agent discovery.
 *
 * The service walks the stages described in the product requirement in order and
 * stops as soon as it has enough trustworthy candidates:
 *
 *   1. existing configuration   — agents already registered with Paperclip
 *   2. local environment        — executables on PATH and in known install dirs
 *   3. local services           — documented API ports on this host
 *   4. container runtime        — running containers with published ports
 *   5. remote endpoints         — explicitly configured URLs
 *   6. validation               — the adapter's own environment test
 *   7. ranking + dedupe         — deterministic default, duplicates merged
 *
 * It never writes configuration, never starts a process, and never returns a
 * credential. Adopting a candidate is the caller's decision.
 *
 * @module server/services/agent-discovery/service
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { getDiscoveryDescriptor, type AdapterDiscoveryDescriptor } from "./catalog.js";
import { buildDeploymentContext } from "./deployment.js";
import {
  defaultIsExecutable,
  listDockerContainers,
  probeExecutableVersion,
  probeHttpHealth,
  probeTcpPort,
  readFilePrefix,
  resolveExecutablePath,
  sanitizeEndpoint,
} from "./probes.js";
import type {
  DeploymentContext,
  DiscoveredAgent,
  DiscoveryEvidence,
  DiscoveryServiceDeps,
  DiscoverySourceKind,
  HttpProbeResult,
  RegisteredAgent,
} from "./types.js";

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_DISCOVERY_BUDGET_MS = 12_000;
const DEFAULT_VALIDATION_BUDGET_MS = 8_000;
const MAX_PROBES_PER_STAGE = 8;
const MAX_VALIDATIONS = 3;

/** Source priority used to pick a deterministic default candidate. */
const SOURCE_RANK: Record<DiscoverySourceKind, number> = {
  registered_agent: 0,
  cli: 1,
  local_api: 2,
  docker_container: 3,
  remote_endpoint: 4,
};

export interface DiscoveryInput {
  companyId: string;
  adapterType: string;
  /** Explicit remote endpoints supplied by the user (advanced path). */
  remoteEndpoints?: string[];
  /** Extra adapter config to merge into every candidate patch (advanced path). */
  configOverrides?: Record<string, unknown>;
  /** Skip the Docker CLI stage (default: run it when the descriptor has hints). */
  includeContainers?: boolean;
  /** Run the adapter environment test (default: true). */
  validate?: boolean;
  /** Bypass the short-lived cache. */
  refresh?: boolean;
  /** Overall budget for the HTTP/probe work. */
  timeoutMs?: number;
}

export interface DiscoveryServiceOptions {
  deps?: Partial<DiscoveryServiceDeps>;
  cacheTtlMs?: number;
  /** Static deployment facts supplied by the server at boot. */
  deployment?: {
    bindHost: string;
    port: number;
    publicUrl?: string;
    deploymentMode?: string;
    deploymentExposure?: string;
  };
}

interface CandidateDraft {
  adapterType: string;
  source: DiscoverySourceKind;
  transport: DiscoveredAgent["transport"];
  label: string;
  executablePath?: string;
  version?: string | null;
  endpoint?: string;
  agentId?: string;
  agentName?: string;
  reachable: boolean;
  capabilities: string[];
  warnings: string[];
  evidence: DiscoveryEvidence[];
  config: Record<string, unknown>;
  requiredInputs: string[];
  validationStatus?: "pass" | "warn" | "fail" | "skipped";
}

export interface ConnectivityProbe {
  host: string;
  port: number;
  reachable: boolean;
  role: "host_gateway" | "loopback";
}

export interface DiscoveryService {
  discover(input: DiscoveryInput): Promise<import("./types.js").DiscoveryReport>;
  deploymentContext(): DeploymentContext;
  probeConnectivity(port: number, hosts?: string[]): Promise<ConnectivityProbe[]>;
  clearCache(): void;
}

function defaultDeps(overrides: Partial<DiscoveryServiceDeps> = {}): DiscoveryServiceDeps {
  return {
    now: () => Date.now(),
    env: process.env,
    platform: process.platform,
    existsSync: (path) => fs.existsSync(path),
    readFileSync: (path) => {
      try {
        return fs.readFileSync(path, "utf8");
      } catch {
        return "";
      }
    },
    readFilePrefix: readFilePrefix,
    isExecutable: defaultIsExecutable,
    homeDir: () => os.homedir(),
    pathSeparator: () => (process.platform === "win32" ? ";" : ":"),
    networkInterfaces: () => os.networkInterfaces(),
    probeExecutable: probeExecutableVersion,
    probeHttp: probeHttpHealth,
    probeTcp: probeTcpPort,
    listContainers: listDockerContainers,
    testEnvironment: async () => null,
    listRegisteredAgents: async () => [],
    ...overrides,
  };
}

function fingerprint(adapterType: string, source: string, identity: string): string {
  return crypto
    .createHash("sha1")
    .update(`${adapterType}\u0000${source}\u0000${identity.toLowerCase()}`)
    .digest("hex")
    .slice(0, 16);
}

function firstMatchLine(output: string | undefined, pattern: RegExp | undefined): string | null {
  if (!output) return null;
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (pattern) {
    const match = lines.find((line) => pattern.test(line));
    return match ? match.slice(0, 160) : null;
  }
  return lines[0] ? lines[0].slice(0, 160) : null;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hostPort(host: string, port: number, scheme: "http" | "https"): string {
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${scheme}://${bracketed}:${port}`;
}

/** Loopback rewritten to the Docker/VM host, only when we are inside a container. */
function rewriteLoopbackForContainer(url: string, deployment: DeploymentContext): string[] {
  if (!deployment.loopbackIsProcessLocalOnly) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname.toLowerCase())) return [];
  return deployment.hostGatewayCandidates.map((host) => {
    const rewritten = new URL(url);
    rewritten.hostname = host;
    return rewritten.toString();
  });
}

async function withBudget<T>(work: Promise<T>, budgetMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(250, budgetMs));
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createDiscoveryService(options: DiscoveryServiceOptions = {}): DiscoveryService {
  const deps = defaultDeps(options.deps);
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cache = new Map<string, { at: number; report: import("./types.js").DiscoveryReport }>();
  const staticDeployment = options.deployment;

  function deploymentContext(): DeploymentContext {
    return buildDeploymentContext({
      env: deps.env,
      platform: deps.platform,
      existsSync: deps.existsSync,
      readFileSync: deps.readFileSync,
      networkInterfaces: deps.networkInterfaces(),
      bindHost: staticDeployment?.bindHost ?? deps.env.HOST ?? "127.0.0.1",
      port: staticDeployment?.port ?? Number(deps.env.PORT ?? 3100),
      publicUrl: staticDeployment?.publicUrl,
      deploymentMode: staticDeployment?.deploymentMode,
      deploymentExposure: staticDeployment?.deploymentExposure,
    });
  }

  function extractAgentIdentity(agent: RegisteredAgent, descriptor: AdapterDiscoveryDescriptor): {
    endpoint?: string;
    executable?: string;
    config: Record<string, unknown>;
    requiredInputs: string[];
  } {
    const config: Record<string, unknown> = {};
    const requiredInputs: string[] = [];
    const commandKey = descriptor.commandConfigKey;
    const endpointKey = descriptor.endpointConfigKey;
    const credentialKey = descriptor.credentialConfigKey;

    const executable = commandKey ? safeString(agent.adapterConfig[commandKey]) : null;
    const endpoint = endpointKey ? safeString(agent.adapterConfig[endpointKey]) : null;
    if (commandKey && executable) config[commandKey] = executable;
    if (endpointKey && endpoint) config[endpointKey] = endpoint;
    if (credentialKey && !safeString(agent.adapterConfig[credentialKey])) {
      requiredInputs.push(credentialKey);
    }
    return {
      ...(endpoint ? { endpoint } : {}),
      ...(executable ? { executable } : {}),
      config,
      requiredInputs,
    };
  }

  async function discover(input: DiscoveryInput): Promise<import("./types.js").DiscoveryReport> {
    const startedAt = deps.now();
    const deployment = deploymentContext();
    const descriptor = getDiscoveryDescriptor(input.adapterType);
    const budgetMs = Math.max(1_000, Math.min(input.timeoutMs ?? DEFAULT_DISCOVERY_BUDGET_MS, 60_000));
    const includeContainers = input.includeContainers !== false;
    const shouldValidate = input.validate !== false;

    // Overrides change the derived config (and therefore the validation
    // result), so they are part of the key. Hash them rather than keeping a
    // credential-bearing object alive as a map key.
    const overridesFingerprint = input.configOverrides
      ? crypto.createHash("sha1").update(JSON.stringify(input.configOverrides)).digest("hex")
      : "";
    const cacheKey = JSON.stringify([
      input.companyId,
      input.adapterType,
      includeContainers,
      shouldValidate,
      input.remoteEndpoints ?? [],
      overridesFingerprint,
    ]);
    if (!input.refresh) {
      const cached = cache.get(cacheKey);
      if (cached && deps.now() - cached.at < cacheTtlMs) {
        return {
          ...cached.report,
          cache: { hit: true, ageMs: deps.now() - cached.at },
        };
      }
    }

    const checks: DiscoveryEvidence[] = [...deployment.checks];
    const notes: string[] = [];
    const drafts: CandidateDraft[] = [];
    const deadline = startedAt + budgetMs;

    // ── Stage 1: existing Paperclip configuration ──────────────────────────
    let registered: RegisteredAgent[] = [];
    try {
      registered = await deps.listRegisteredAgents(input.companyId, input.adapterType);
      checks.push({
        stage: "existing_configuration",
        code: "registered_agents_checked",
        level: "info",
        message: registered.length
          ? `${registered.length} existing ${input.adapterType} agent(s) found.`
          : `No existing ${input.adapterType} agent is registered for this company.`,
      });
    } catch (error) {
      checks.push({
        stage: "existing_configuration",
        code: "registered_agents_unavailable",
        level: "warn",
        message: "Existing agents could not be read; discovery continued without them.",
        detail: (error as Error).message,
      });
    }

    for (const agent of registered) {
      const identity = extractAgentIdentity(agent, descriptor);
      const resolvedCommand = identity.executable
        ? resolveExecutablePath({
            command: identity.executable,
            env: deps.env,
            platform: deps.platform,
            isExecutable: deps.isExecutable,
            existsSync: deps.existsSync,
            homeDir: deps.homeDir(),
          })
        : null;
      drafts.push({
        adapterType: descriptor.adapterType,
        source: "registered_agent",
        transport: descriptor.transport,
        label: `${agent.name} (registered)`,
        ...(identity.executable
          ? { executablePath: resolvedCommand ?? identity.executable }
          : {}),
        ...(identity.endpoint ? { endpoint: sanitizeEndpoint(identity.endpoint) } : {}),
        agentId: agent.id,
        agentName: agent.name,
        reachable: true,
        capabilities: descriptor.capabilities ?? [],
        warnings: [],
        evidence: [
          {
            stage: "existing_configuration",
            code: "agent_registered",
            level: "info",
            message: "Previously configured in Paperclip; reused instead of creating a duplicate.",
          },
        ],
        config: identity.config,
        requiredInputs: identity.requiredInputs,
      });
    }

    // ── Stage 2: local executables ─────────────────────────────────────────
    const commandCandidates = new Set<string>(descriptor.commands);
    for (const agent of registered) {
      const key = descriptor.commandConfigKey;
      const configured = key ? safeString(agent.adapterConfig[key]) : null;
      if (configured) commandCandidates.add(configured);
    }
    const overrideCommand = descriptor.commandConfigKey
      ? safeString(input.configOverrides?.[descriptor.commandConfigKey])
      : null;
    if (overrideCommand) commandCandidates.add(overrideCommand);

    if (commandCandidates.size > 0) {
      const resolved = new Map<string, string>();
      for (const command of [...commandCandidates].slice(0, MAX_PROBES_PER_STAGE)) {
        const path = resolveExecutablePath({
          command,
          env: deps.env,
          platform: deps.platform,
          isExecutable: deps.isExecutable,
          existsSync: deps.existsSync,
          homeDir: deps.homeDir(),
        });
        if (path) resolved.set(path, command);
      }

      const probes = await Promise.all(
        [...resolved.entries()].map(async ([path, command]) => ({
          path,
          command,
          result: await withBudget(
            deps.probeExecutable(path, descriptor.versionArgs ?? ["--version"], 4_000),
            Math.max(500, deadline - deps.now()),
            { path, ok: false, error: "probe_timeout" },
          ),
        })),
      );

      for (const { path, command, result } of probes) {
        const versionLine = firstMatchLine(result.output, descriptor.identityPattern);
        const timedOut = result.error === "timeout" || result.error === "probe_timeout";
        // Slow-starting CLIs (a Python entry point can take 30 s to print a
        // version) must not look like a different binary. Fall back to a
        // bounded read of the entry point, which never executes anything.
        const fileIdentity =
          !versionLine && descriptor.identityPattern
            ? descriptor.identityPattern.test(deps.readFilePrefix(path, 8_192))
            : false;
        const identityVerified = descriptor.identityPattern
          ? Boolean(versionLine) || fileIdentity
          : result.ok;
        // The file exists and is executable, so it is reachable even when the
        // version probe could not finish inside the budget.
        const reachable = result.ok || timedOut;
        drafts.push({
          adapterType: descriptor.adapterType,
          source: "cli",
          transport: descriptor.transport,
          label: versionLine ? `${descriptor.label} — ${versionLine}` : `${descriptor.label} (${command})`,
          executablePath: path,
          version: versionLine,
          reachable,
          capabilities: descriptor.capabilities ?? [],
          warnings: identityVerified
            ? []
            : [
                `The binary at ${path} did not report a recognizable ${descriptor.adapterType} version; confirm it is the intended agent before use.`,
              ],
          evidence: [
            {
              stage: "local_environment",
              code: result.ok ? "executable_found" : timedOut ? "executable_probe_timeout" : "executable_unusable",
              level: reachable ? "info" : "warn",
              message: result.ok
                ? `Found executable: ${path}`
                : timedOut
                  ? `Found executable at ${path}; the version probe did not finish within its budget.`
                  : `Executable exists at ${path} but did not run: ${result.error ?? "unknown error"}`,
            },
            ...(fileIdentity
              ? [
                  {
                    stage: "local_environment" as const,
                    code: "identity_from_executable_file",
                    level: "info" as const,
                    message:
                      "Binary contents match the expected agent; the version probe was unavailable.",
                  },
                ]
              : []),
            ...(versionLine
              ? [
                  {
                    stage: "local_environment" as const,
                    code: "version_detected",
                    level: "info" as const,
                    message: `Version: ${versionLine}`,
                  },
                ]
              : []),
            ...(identityVerified
              ? []
              : [
                  {
                    stage: "local_environment" as const,
                    code: "identity_unverified",
                    level: "warn" as const,
                    message: "Binary identity could not be confirmed from its version output.",
                  },
                ]),
          ],
          config:
            descriptor.commandConfigKey ? { [descriptor.commandConfigKey]: path } : {},
          requiredInputs: [],
        });
      }

      if (resolved.size === 0) {
        checks.push({
          stage: "local_environment",
          code: "executable_not_found",
          level: "warn",
          message: `No ${descriptor.adapterType} executable was found on PATH or in the known install directories.`,
          ...(descriptor.installHint ? { detail: descriptor.installHint } : {}),
        });
      }
    }

    // ── Stage 3: documented local API services ─────────────────────────────
    for (const service of descriptor.localServices ?? []) {
      const scheme = service.scheme ?? "http";
      const hosts = ["127.0.0.1"];
      if (deployment.loopbackIsProcessLocalOnly) {
        hosts.push(...deployment.hostGatewayCandidates.slice(0, 3));
      }
      for (const host of hosts) {
        if (deps.now() > deadline) {
          notes.push("Probe budget exhausted before every local service was checked.");
          break;
        }
        const url = hostPort(host, service.port, scheme);
        const probe: HttpProbeResult = await withBudget(
          deps.probeHttp(`${url}${service.path}`, { timeoutMs: 2_000 }),
          Math.max(500, deadline - deps.now()),
          { ok: false, status: null, url, error: "probe_timeout" },
        );
        const bodyOk = service.expectBodyIncludes
          ? (probe.bodySnippet ?? "").includes(service.expectBodyIncludes)
          : true;
        const jsonOk = service.expectJson ? probe.json !== undefined : true;
        const reachable = probe.ok && bodyOk && jsonOk;
        const isGateway = host !== "127.0.0.1";
        // Probe over HTTP even for WebSocket agents (the port answers), but the
        // config patch must carry the scheme the adapter actually speaks.
        const configUrl =
          descriptor.transport === "websocket"
            ? `ws://${host}:${service.port}`
            : url;
        drafts.push({
          adapterType: descriptor.adapterType,
          source: "local_api",
          transport: descriptor.transport === "websocket" ? "websocket" : "http",
          label: `${service.name} — ${host}:${service.port}${isGateway ? " (host gateway)" : ""}`,
          endpoint: sanitizeEndpoint(configUrl),
          reachable,
          capabilities: descriptor.capabilities ?? [],
          warnings: reachable
            ? []
            : [
                `Port ${service.port} on ${host} did not answer like a ${service.name} endpoint (status ${probe.status ?? "none"}${probe.error ? `, ${probe.error}` : ""}).`,
              ],
          evidence: [
            {
              stage: isGateway ? "container_runtime" : "local_services",
              code: reachable ? "service_reachable" : "service_unreachable",
              level: reachable ? "info" : "info",
              message: reachable
                ? `${service.name} answered at ${url}${service.path}.`
                : `No usable ${service.name} at ${url}${service.path}.`,
              detail: probe.bodySnippet,
            },
            ...(isGateway
              ? [
                  {
                    stage: "container_runtime" as const,
                    code: "container_to_host_rewrite",
                    level: "info" as const,
                    message:
                      "Paperclip runs in a container, so the host is reached through the gateway alias instead of loopback.",
                  },
                ]
              : []),
          ],
          config: descriptor.endpointConfigKey
            ? { [descriptor.endpointConfigKey]: sanitizeEndpoint(configUrl) }
            : {},
          requiredInputs: descriptor.credentialConfigKey ? [descriptor.credentialConfigKey] : [],
        });
      }
    }

    // ── Stage 4: running containers ────────────────────────────────────────
    const imageHints = descriptor.containerImageHints ?? [];
    if (includeContainers && imageHints.length > 0) {
      const listing = await withBudget(
        deps.listContainers(3_000),
        Math.max(500, deadline - deps.now()),
        { available: false, containers: [], error: "probe_timeout" },
      );
      if (!listing.available) {
        checks.push({
          stage: "container_runtime",
          code: "container_runtime_unavailable",
          level: "warn",
          message:
            "Container inspection is unavailable (Docker CLI missing or not permitted); containerized agents were not scanned. Configure an endpoint manually if one is running.",
          detail: listing.error,
        });
      } else {
        const matching = listing.containers.filter((container) => {
          const haystack = `${container.image} ${container.name}`.toLowerCase();
          return imageHints.some((hint) => haystack.includes(hint.toLowerCase()));
        });
        checks.push({
          stage: "container_runtime",
          code: "containers_inspected",
          level: "info",
          message: `${listing.containers.length} running container(s) inspected; ${matching.length} matched ${descriptor.adapterType}.`,
        });
        for (const container of matching) {
          const ports = container.publishedPorts.length
            ? container.publishedPorts
            : [];
          if (ports.length === 0) {
            drafts.push({
              adapterType: descriptor.adapterType,
              source: "docker_container",
              transport: descriptor.transport,
              label: `${container.name} (container, unpublished)`,
              reachable: false,
              capabilities: descriptor.capabilities ?? [],
              warnings: [
                `${container.name} looks like ${descriptor.adapterType} but publishes no host port, so Paperclip cannot reach it. Publish the service port in the Compose file.`,
              ],
              evidence: [
                {
                  stage: "container_runtime",
                  code: "container_port_unpublished",
                  level: "warn",
                  message: `Image ${container.image} is running but no host port is published.`,
                },
              ],
              config: {},
              requiredInputs: [],
            });
            continue;
          }
          const host =
            deployment.mode === "container"
              ? (deployment.hostGatewayCandidates[0] ?? "host.docker.internal")
              : "127.0.0.1";
          for (const port of ports) {
            const url = hostPort(host, port.hostPort, "http");
            const probe = await withBudget(
              deps.probeHttp(url, { timeoutMs: 1_500 }),
              Math.max(400, deadline - deps.now()),
              { ok: false, status: null, url, error: "probe_timeout" },
            );
            drafts.push({
              adapterType: descriptor.adapterType,
              source: "docker_container",
              transport: descriptor.transport,
              label: `${container.name} — ${host}:${port.hostPort}`,
              endpoint: sanitizeEndpoint(url),
              reachable: probe.ok,
              capabilities: descriptor.capabilities ?? [],
              warnings: probe.ok
                ? []
                : [
                    `${container.name} publishes port ${port.hostPort}, but nothing answered on it from Paperclip's namespace.`,
                  ],
              evidence: [
                {
                  stage: "container_runtime",
                  code: probe.ok ? "container_reachable" : "container_unreachable",
                  level: "info",
                  message: `Container ${container.name} (${container.image}) → ${url}`,
                },
              ],
              config: descriptor.endpointConfigKey ? { [descriptor.endpointConfigKey]: url } : {},
              requiredInputs: descriptor.credentialConfigKey ? [descriptor.credentialConfigKey] : [],
            });
          }
        }
      }
    }

    // ── Stage 5: explicit remote endpoints ─────────────────────────────────
    for (const raw of (input.remoteEndpoints ?? []).slice(0, MAX_PROBES_PER_STAGE)) {
      let normalized: string;
      try {
        normalized = new URL(raw.trim()).toString();
      } catch {
        checks.push({
          stage: "remote_endpoints",
          code: "remote_endpoint_invalid",
          level: "warn",
          message: `Ignoring an endpoint that is not an absolute URL: ${raw}`,
        });
        continue;
      }
      const candidates = [normalized, ...rewriteLoopbackForContainer(normalized, deployment)];
      for (const endpoint of candidates) {
        const isRewrite = endpoint !== normalized;
        const probe = await withBudget(
          deps.probeHttp(endpoint, { timeoutMs: 2_500 }),
          Math.max(500, deadline - deps.now()),
          { ok: false, status: null, url: endpoint, error: "probe_timeout" },
        );
        drafts.push({
          adapterType: descriptor.adapterType,
          source: "remote_endpoint",
          transport: descriptor.transport,
          label: `${descriptor.label} — ${new URL(endpoint).host}${isRewrite ? " (host gateway)" : ""}`,
          endpoint: sanitizeEndpoint(endpoint),
          reachable: probe.ok,
          capabilities: descriptor.capabilities ?? [],
          warnings: probe.ok
            ? []
            : [
                `Endpoint did not answer (status ${probe.status ?? "none"}${probe.error ? `, ${probe.error}` : ""}).`,
                ...(isRewrite
                  ? []
                  : [
                      "If this endpoint is on the Docker host, loopback is the container itself; retry with the host gateway address.",
                    ]),
              ],
          evidence: [
            {
              stage: "remote_endpoints",
              code: probe.ok ? "remote_endpoint_reachable" : "remote_endpoint_unreachable",
              level: probe.ok ? "info" : "warn",
              message: probe.ok
                ? `Endpoint responded at ${sanitizeEndpoint(endpoint)}.`
                : `No response from ${sanitizeEndpoint(endpoint)}.`,
              detail: probe.bodySnippet,
            },
            ...(isRewrite
              ? [
                  {
                    stage: "container_runtime" as const,
                    code: "loopback_rewritten",
                    level: "info" as const,
                    message:
                      "A loopback endpoint was also probed through the container host gateway, because loopback inside a container is the container.",
                  },
                ]
              : []),
          ],
          config: descriptor.endpointConfigKey
            ? { [descriptor.endpointConfigKey]: sanitizeEndpoint(endpoint) }
            : {},
          requiredInputs: descriptor.credentialConfigKey ? [descriptor.credentialConfigKey] : [],
        });
      }
    }

    // ── Dedupe: same executable or endpoint reached twice ──────────────────
    const merged = new Map<string, CandidateDraft>();
    for (const draft of drafts) {
      const identity = draft.endpoint ?? draft.executablePath ?? draft.agentId ?? draft.label;
      const key = identity.toLowerCase();
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, draft);
        continue;
      }
      existing.evidence.push(...draft.evidence);
      existing.warnings.push(...draft.warnings.filter((warning) => !existing.warnings.includes(warning)));
      existing.reachable = existing.reachable || draft.reachable;
      existing.capabilities = [...new Set([...existing.capabilities, ...draft.capabilities])];
      existing.version ??= draft.version;
      existing.executablePath ??= draft.executablePath;
      existing.endpoint ??= draft.endpoint;
      // A registered agent's config wins; live probes only fill the gaps so a
      // saved endpoint is never silently replaced by a guess.
      existing.config = { ...draft.config, ...existing.config };
      existing.requiredInputs = [
        ...new Set([...existing.requiredInputs, ...draft.requiredInputs]),
      ];
    }

    // ── Stage 6: validation through the adapter's own environment test ─────
    const ordered = [...merged.values()].sort((a, b) => {
      if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
      return SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
    });

    let validationsRun = 0;
    for (const draft of ordered) {
      const validationConfig = {
        ...draft.config,
        ...(input.configOverrides ?? {}),
      };
      const hasConfig = Object.keys(validationConfig).length > 0;
      if (!shouldValidate || !hasConfig || validationsRun >= MAX_VALIDATIONS) {
        continue;
      }
      validationsRun += 1;
      const result = await withBudget(
        deps.testEnvironment(draft.adapterType, validationConfig).catch(() => null),
        DEFAULT_VALIDATION_BUDGET_MS,
        null,
      );
      if (!result) {
        draft.evidence.push({
          stage: "validation",
          code: "validation_unavailable",
          level: "warn",
          message:
            "The adapter environment test did not return a result within its budget; the candidate is reachable but unverified.",
        });
        continue;
      }
      (draft as CandidateDraft).validationStatus = result.status;
      draft.evidence.push({
        stage: "validation",
        code: `validation_${result.status}`,
        level: result.status === "fail" ? "warn" : "info",
        message:
          result.status === "pass"
            ? "Adapter environment test passed."
            : `Adapter environment test reported ${result.status}.`,
        detail: result.checks
          .filter((check) => check.level !== "info")
          .map((check) => check.message)
          .slice(0, 3)
          .join(" | "),
      });
    }

    // ── Stage 7: rank, fingerprint, present ───────────────────────────────
    const candidates: DiscoveredAgent[] = ordered
      .map((draft) => {
        const identity = draft.endpoint ?? draft.executablePath ?? draft.agentId ?? draft.label;
        const validationStatus = draft.validationStatus ?? "skipped";
        return {
          id: fingerprint(draft.adapterType, draft.source, identity),
          adapterType: draft.adapterType,
          source: draft.source,
          transport: draft.transport,
          label: draft.label,
          ...(draft.executablePath ? { executablePath: draft.executablePath } : {}),
          ...(draft.version !== undefined ? { version: draft.version } : {}),
          ...(draft.endpoint ? { endpoint: draft.endpoint } : {}),
          ...(draft.agentId ? { agentId: draft.agentId } : {}),
          ...(draft.agentName ? { agentName: draft.agentName } : {}),
          reachable: draft.reachable,
          validated: validationStatus === "pass" || validationStatus === "warn",
          validationStatus,
          configPatch: draft.config,
          requiredInputs: draft.requiredInputs,
          capabilities: draft.capabilities,
          warnings: draft.warnings,
          evidence: draft.evidence,
        } satisfies DiscoveredAgent;
      })
      .sort((a, b) => {
        const score = (candidate: DiscoveredAgent) =>
          (candidate.validated ? 0 : 4) +
          (candidate.reachable ? 0 : 2) +
          SOURCE_RANK[candidate.source] * 0.1;
        return score(a) - score(b);
      });

    if (candidates.length === 0) {
      notes.push(
        descriptor.installHint
          ? `Nothing was found. ${descriptor.installHint}`
          : "Nothing was found. Provide an executable path or endpoint in the advanced configuration.",
      );
    }
    const distinct = new Set(candidates.map((candidate) => candidate.endpoint ?? candidate.executablePath));
    if (distinct.size < candidates.length) {
      notes.push("Duplicate candidates were merged into a single entry.");
    }

    const report: import("./types.js").DiscoveryReport = {
      adapterType: input.adapterType,
      companyId: input.companyId,
      generatedAt: new Date(deps.now()).toISOString(),
      durationMs: deps.now() - startedAt,
      deployment,
      candidates,
      checks,
      cache: { hit: false, ageMs: 0 },
      notes,
    };

    if (cache.size > 100) cache.clear();
    cache.set(cacheKey, { at: deps.now(), report });
    return report;
  }

  async function probeConnectivity(port: number, hosts?: string[]): Promise<ConnectivityProbe[]> {
    const deployment = deploymentContext();
    const targets = hosts?.length
      ? hosts
      : deployment.mode === "container"
        ? [...deployment.hostGatewayCandidates, "127.0.0.1"]
        : ["127.0.0.1"];
    const unique = [...new Set(targets)];
    return await Promise.all(
      unique.map(async (host) => ({
        host,
        port,
        reachable: await deps.probeTcp(host, port, 1_500),
        role: host === "127.0.0.1" || host === "localhost"
          ? "loopback"
          : "host_gateway",
      })),
    );
  }

  return {
    discover,
    deploymentContext,
    probeConnectivity,
    clearCache: () => cache.clear(),
  };
}
