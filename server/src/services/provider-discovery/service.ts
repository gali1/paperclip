/**
 * AUTO provider discovery.
 *
 * Scans the sources Paperclip can legitimately read — its own agent
 * configuration, the process environment, a bounded allowlist of client config
 * files, documented local service ports, reachable containers — and returns one
 * de-duplicated provider inventory with an explicit confidence classification.
 *
 * Hard rules enforced here:
 * - credentials are never transmitted, echoed, logged, or stored in a result;
 *   the inventory records only the *name* of the variable that holds one;
 * - probes are unauthenticated GETs against model-listing paths, so no scan can
 *   produce a billable inference call;
 * - every stage is bounded and failure-isolated, and cancellation is checked
 *   between probes.
 *
 * @module server/services/provider-discovery/service
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { buildDeploymentContext } from "../agent-discovery/deployment.js";
import { listDockerContainers, probeHttpHealth, sanitizeEndpoint } from "../agent-discovery/probes.js";
import type { ContainerInfo, DeploymentContext, HttpProbeResult } from "../agent-discovery/types.js";
import {
  CONFIG_FILE_RULES,
  GENERIC_BASE_URL_ENV_KEYS,
  PLACEHOLDER_CREDENTIAL_VALUES,
  PROVIDER_SIGNATURES,
  getProviderSignature,
  type ProviderSignature,
} from "./registry.js";

const PROBE_TIMEOUT_MS = 1_800;
const SCAN_BUDGET_MS = 25_000;
const MAX_CONCURRENT_PROBES = 6;
const MAX_CONFIG_FILE_BYTES = 256 * 1024;
const JOB_TTL_MS = 15 * 60_000;
const MAX_JOBS_PER_COMPANY = 10;

export type FindingStatus =
  | "ready"
  | "needs_configuration"
  | "not_reachable"
  | "compatible_unverified"
  /** Configuration or credential found, but no non-billable validation exists. */
  | "detected_unverified";

export type FindingSourceKind =
  | "paperclip_config"
  | "environment"
  | "config_file"
  | "local_service"
  | "container"
  | "generic_endpoint";

export type Location = "local" | "host" | "container" | "remote" | "unknown";

export interface FindingSource {
  kind: FindingSourceKind;
  detail: string;
}

export interface ProviderFinding {
  id: string;
  providerId: string;
  label: string;
  category: ProviderSignature["category"];
  status: FindingStatus;
  sources: FindingSource[];
  endpoint?: string;
  location: Location;
  credential: "present" | "missing" | "unknown" | "not_required";
  /** Names only, never values. */
  credentialEnvKeys: string[];
  models: string[];
  requirements: string[];
  warnings: string[];
  confidence: "high" | "medium" | "low";
  setup: {
    providerKey?: string;
    aiConnectionProvider?: string;
    baseUrl?: string;
    defaultModel?: string;
  };
}

export type ScanStageName =
  | "paperclip_config"
  | "environment"
  | "config_files"
  | "local_services"
  | "containers"
  | "endpoint_probes"
  | "normalize";

export interface ScanStageState {
  stage: ScanStageName;
  status: "pending" | "running" | "completed" | "skipped" | "failed";
  detail?: string;
  found?: number;
}

export interface ScanSnapshot {
  id: string;
  companyId: string;
  status: "running" | "completed" | "cancelled" | "failed";
  stage: ScanStageName | null;
  stages: ScanStageState[];
  deployment: Pick<DeploymentContext, "mode" | "hostGatewayCandidates" | "loopbackIsProcessLocalOnly" | "platform">;
  findings: ProviderFinding[];
  warnings: string[];
  limitations: string[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface ProviderDiscoveryDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir(): string;
  /** Returns null when the file does not exist. Never used for arbitrary paths. */
  readBoundedFile(path: string, maxBytes: number): string | null;
  now(): number;
  probeHttp(url: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<HttpProbeResult>;
  listContainers(timeoutMs: number): Promise<{ available: boolean; containers: ContainerInfo[]; error?: string }>;
  /** Environment variable names already configured on Paperclip agents. */
  listConfiguredEnvKeys(companyId: string): Promise<string[]>;
}

export interface ProviderDiscoveryService {
  start(companyId: string): ScanSnapshot;
  get(companyId: string, scanId: string): ScanSnapshot | null;
  cancel(companyId: string, scanId: string): ScanSnapshot | null;
}

const STAGE_ORDER: ScanStageName[] = [
  "paperclip_config",
  "environment",
  "config_files",
  "local_services",
  "containers",
  "endpoint_probes",
  "normalize",
];

function defaultReadBoundedFile(path: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, "r");
    const buffer = Buffer.alloc(maxBytes);
    const bytes = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytes).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function defaultDeps(overrides: Partial<ProviderDiscoveryDeps> = {}): ProviderDiscoveryDeps {
  return {
    env: process.env,
    platform: process.platform,
    homeDir: () => os.homedir(),
    readBoundedFile: defaultReadBoundedFile,
    now: () => Date.now(),
    probeHttp: (url, opts) => probeHttpHealth(url, { timeoutMs: opts.timeoutMs }),
    listContainers: listDockerContainers,
    listConfiguredEnvKeys: async () => [],
    ...overrides,
  };
}

function isPlaceholder(value: string | undefined): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  return PLACEHOLDER_CREDENTIAL_VALUES.has(trimmed.toLowerCase());
}

export function normalizeEndpoint(raw: string): string | null {
  try {
    const url = new URL(raw);
    url.hash = "";
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return null;
  }
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

function locationFor(endpoint: string | undefined, deployment: DeploymentContext): Location {
  if (!endpoint) return "unknown";
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") return "local";
    if (deployment.hostGatewayCandidates.some((candidate) => candidate.toLowerCase() === host)) {
      return "host";
    }
    if (deployment.reachableHostAddresses.includes(host)) return "host";
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return "remote";
    return "remote";
  } catch {
    return "unknown";
  }
}

function extractModels(
  probe: HttpProbeResult,
  format: "openai" | "ollama" | "none",
): string[] {
  const json = probe.json as Record<string, unknown> | undefined;
  if (!json || format === "none") return [];
  const list = format === "ollama" ? json.models : json.data;
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const record = entry as Record<string, unknown>;
      const value = format === "ollama" ? record.name : record.id;
      return typeof value === "string" ? value : null;
    })
    .filter((value): value is string => Boolean(value))
    .slice(0, 40);
}

class ProviderInventoryBuilder {
  private readonly findings = new Map<string, ProviderFinding>();

  add(finding: ProviderFinding): void {
    const key = this.keyFor(finding);
    const configOnlyKey = `${finding.providerId}|config`;
    // A credential/config observation and a probed endpoint for the same
    // provider are one result, not two.
    if (key !== configOnlyKey && this.findings.has(configOnlyKey)) {
      const configOnly = this.findings.get(configOnlyKey) as ProviderFinding;
      this.findings.delete(configOnlyKey);
      finding = {
        ...finding,
        sources: [...configOnly.sources, ...finding.sources],
        credentialEnvKeys: [
          ...new Set([...configOnly.credentialEnvKeys, ...finding.credentialEnvKeys]),
        ],
        credential: finding.credential === "unknown" ? configOnly.credential : finding.credential,
        warnings: [...new Set([...configOnly.warnings, ...finding.warnings])],
        requirements: [...new Set([...configOnly.requirements, ...finding.requirements])],
      };
      finding.warnings = [
        ...new Set([
          ...finding.warnings,
          "Multiple discovery sources refer to this provider; they were consolidated.",
        ]),
      ];
    }
    const existing = this.findings.get(key);
    if (!existing) {
      this.findings.set(key, finding);
      return;
    }
    // Prefer the most concrete observation, but keep every source.
    const rank: Record<FindingStatus, number> = {
      ready: 0,
      needs_configuration: 1,
      compatible_unverified: 2,
      not_reachable: 3,
      detected_unverified: 4,
    };
    const winner = rank[finding.status] < rank[existing.status] ? finding : existing;
    const merged: ProviderFinding = {
      ...winner,
      sources: [
        ...existing.sources,
        ...finding.sources.filter(
          (source) => !existing.sources.some((s) => s.kind === source.kind && s.detail === source.detail),
        ),
      ],
      credentialEnvKeys: [
        ...new Set([...existing.credentialEnvKeys, ...finding.credentialEnvKeys]),
      ],
      models: winner.models.length ? winner.models : existing.models,
      requirements: [...new Set([...existing.requirements, ...finding.requirements])],
      warnings: [...new Set([...existing.warnings, ...finding.warnings])],
      confidence: winner.confidence,
    };
    if (merged.sources.length > 1) {
      merged.warnings = [
        ...new Set([
          ...merged.warnings,
          "Multiple discovery sources refer to this provider; they were consolidated.",
        ]),
      ];
    }
    this.findings.set(key, merged);
  }

  private keyFor(finding: ProviderFinding): string {
    // Unknown endpoints are only the same result when the URL is the same;
    // a known provider is the same result across base-URL spellings.
    const endpoint = finding.endpoint ? normalizeEndpoint(finding.endpoint) : null;
    if (!endpoint) return `${finding.providerId}|config`;
    if (finding.providerId === "compatible") return `${finding.providerId}|${endpoint}`;
    try {
      const url = new URL(endpoint);
      return `${finding.providerId}|${url.protocol}//${url.host}`;
    } catch {
      return `${finding.providerId}|${endpoint}`;
    }
  }

  snapshot(): ProviderFinding[] {
    const order: Record<FindingStatus, number> = {
      ready: 0,
      needs_configuration: 1,
      compatible_unverified: 2,
      detected_unverified: 3,
      not_reachable: 4,
    };
    return [...this.findings.values()].sort(
      (a, b) =>
        order[a.status] - order[b.status] ||
        a.category.localeCompare(b.category) ||
        a.label.localeCompare(b.label),
    );
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      results.push(await work(current));
    }
  });
  await Promise.all(workers);
  return results;
}

export function createProviderDiscoveryService(options: {
  deps?: Partial<ProviderDiscoveryDeps>;
  deployment?: {
    bindHost: string;
    port: number;
    publicUrl?: string;
    deploymentMode?: string;
    deploymentExposure?: string;
  };
  budgetMs?: number;
} = {}): ProviderDiscoveryService {
  const deps = defaultDeps(options.deps);
  const budgetMs = options.budgetMs ?? SCAN_BUDGET_MS;
  const jobs = new Map<string, { snapshot: ScanSnapshot; controller: AbortController; companyId: string }>();

  function deploymentContext(): DeploymentContext {
    return buildDeploymentContext({
      env: deps.env,
      platform: deps.platform,
      bindHost: options.deployment?.bindHost ?? deps.env.HOST ?? "127.0.0.1",
      port: options.deployment?.port ?? Number(deps.env.PORT ?? 3100),
      publicUrl: options.deployment?.publicUrl,
      deploymentMode: options.deployment?.deploymentMode,
      deploymentExposure: options.deployment?.deploymentExposure,
    });
  }

  function pruneJobs(now: number): void {
    for (const [id, job] of jobs) {
      const finished = job.snapshot.finishedAt ? Date.parse(job.snapshot.finishedAt) : null;
      if (finished && now - finished > JOB_TTL_MS) jobs.delete(id);
    }
    const perCompany = [...jobs.values()].filter((job) => job.companyId);
    if (perCompany.length > MAX_JOBS_PER_COMPANY * 4) {
      const sorted = perCompany.sort(
        (a, b) => Date.parse(a.snapshot.startedAt) - Date.parse(b.snapshot.startedAt),
      );
      for (const job of sorted.slice(0, sorted.length - MAX_JOBS_PER_COMPANY * 4)) {
        const id = [...jobs.entries()].find(([, value]) => value === job)?.[0];
        if (id) jobs.delete(id);
      }
    }
  }

  function markStage(snapshot: ScanSnapshot, stage: ScanStageName, status: ScanStageState["status"], detail?: string): void {
    const entry = snapshot.stages.find((item) => item.stage === stage);
    if (entry) {
      entry.status = status;
      if (detail) entry.detail = detail;
    }
    if (status === "running") snapshot.stage = stage;
    if (status === "completed" || status === "failed" || status === "skipped") {
      if (snapshot.stage === stage) snapshot.stage = null;
    }
  }

  function addFinding(snapshot: ScanSnapshot, inventory: ProviderInventoryBuilder, finding: ProviderFinding): void {
    inventory.add(finding);
    snapshot.findings = inventory.snapshot();
    const stage = snapshot.stage;
    if (stage) {
      const entry = snapshot.stages.find((item) => item.stage === stage);
      if (entry) entry.found = snapshot.findings.length;
    }
  }

  function baseFinding(
    signature: ProviderSignature,
  ): Pick<ProviderFinding, "providerId" | "label" | "category"> {
    return { providerId: signature.id, label: signature.label, category: signature.category };
  }

  async function probeCandidate(input: {
    signature?: ProviderSignature;
    endpoint: string;
    modelsPath: string;
    modelsFormat: "openai" | "ollama" | "none";
    signal: AbortSignal;
    source: FindingSource;
    deployment: DeploymentContext;
  }): Promise<ProviderFinding> {
    // A configured base URL usually already ends in /v1, while documented-port
    // hints carry the full /v1/models path. Do not produce /v1/v1/models.
    const base = normalizeBaseUrl(input.endpoint);
    const modelsPath =
      input.modelsPath.startsWith("/v1/") && /\/v1$/.test(base)
        ? input.modelsPath.slice(3)
        : input.modelsPath;
    const url = `${base}${modelsPath}`;
    const probe = await deps.probeHttp(url, { timeoutMs: PROBE_TIMEOUT_MS, signal: input.signal });
    const models = extractModels(probe, input.modelsFormat);
    const signature = input.signature;
    const endpoint = normalizeBaseUrl(input.endpoint);
    const requirements: string[] = [];
    const warnings: string[] = [];
    let status: FindingStatus;

    if (probe.status === 401 || probe.status === 403) {
      status = "needs_configuration";
      requirements.push(signature?.auth === "none" ? "Credentials required" : "API key required");
    } else if (!probe.ok) {
      status = "not_reachable";
      warnings.push(
        probe.error
          ? `Probe failed: ${probe.error}.`
          : `Endpoint answered ${probe.status ?? "nothing"}.`,
      );
    } else if (!signature) {
      status = "compatible_unverified";
      requirements.push("Confirm this endpoint's API compatibility and model ids.");
    } else if (models.length > 0) {
      status = "ready";
    } else if (signature.category === "local" || signature.category === "gateway") {
      status = "compatible_unverified";
      warnings.push("Endpoint answered but returned no model list.");
    } else {
      status = "compatible_unverified";
    }

    return {
      ...(signature ? baseFinding(signature) : {
        providerId: "compatible",
        label: "OpenAI-compatible endpoint",
        category: "compatible" as const,
      }),
      id: crypto.createHash("sha1").update(`${signature?.id ?? "compatible"}|${endpoint}`).digest("hex").slice(0, 16),
      status,
      sources: [input.source],
      endpoint: sanitizeEndpoint(endpoint),
      location: locationFor(endpoint, input.deployment),
      credential: status === "needs_configuration" ? "missing" : signature?.auth === "none" ? "not_required" : "unknown",
      credentialEnvKeys: [],
      models,
      requirements,
      warnings,
      confidence: status === "ready" ? "high" : status === "needs_configuration" ? "medium" : "low",
      setup: {
        ...(signature?.setupProviderKey ? { providerKey: signature.setupProviderKey } : {}),
        ...(signature?.aiConnectionProvider ? { aiConnectionProvider: signature.aiConnectionProvider } : {}),
        baseUrl: endpoint,
        ...(models[0] ? { defaultModel: models[0] } : {}),
      },
    };
  }

  async function runScan(job: { snapshot: ScanSnapshot; controller: AbortController }): Promise<void> {
    const { snapshot, controller } = job;
    const deployment = deploymentContext();
    const inventory = new ProviderInventoryBuilder();
    const deadline = deps.now() + budgetMs;
    const cancelled = () => controller.signal.aborted;

    const finish = (status: ScanSnapshot["status"], error?: string) => {
      snapshot.status = status;
      snapshot.stage = null;
      snapshot.finishedAt = new Date(deps.now()).toISOString();
      if (error) snapshot.error = error;
      snapshot.findings = inventory.snapshot();
    };

    try {
      // ── Stage 1: existing Paperclip configuration ─────────────────────────
      markStage(snapshot, "paperclip_config", "running");
      try {
        const configuredKeys = await deps.listConfiguredEnvKeys(snapshot.companyId);
        const seen = new Set<string>();
        for (const envKey of configuredKeys) {
          const signature = PROVIDER_SIGNATURES.find((entry) => entry.envKeys.includes(envKey));
          if (!signature || seen.has(signature.id)) continue;
          seen.add(signature.id);
          addFinding(snapshot, inventory, {
            ...baseFinding(signature),
            id: crypto.createHash("sha1").update(`paperclip|${signature.id}`).digest("hex").slice(0, 16),
            status: "detected_unverified",
            sources: [{ kind: "paperclip_config", detail: `Already used by a Paperclip agent (${envKey})` }],
            location: "unknown",
            credential: "present",
            credentialEnvKeys: [envKey],
            models: [],
            requirements: ["Validate the connection from the agent setup screen."],
            warnings: [],
            confidence: "medium",
            setup: {
              ...(signature.setupProviderKey ? { providerKey: signature.setupProviderKey } : {}),
              ...(signature.aiConnectionProvider ? { aiConnectionProvider: signature.aiConnectionProvider } : {}),
            },
          });
        }
        markStage(snapshot, "paperclip_config", "completed", `${configuredKeys.length} configured key name(s) inspected`);
      } catch (error) {
        markStage(snapshot, "paperclip_config", "failed", (error as Error).message);
        snapshot.warnings.push("Existing Paperclip configuration could not be read; continuing.");
      }

      // ── Stage 2: environment ──────────────────────────────────────────────
      markStage(snapshot, "environment", "running");
      const envBaseUrls: Array<{ endpoint: string; signature?: ProviderSignature; source: FindingSource }> = [];
      let envHits = 0;
      try {
        for (const signature of PROVIDER_SIGNATURES) {
          const presentKeys = signature.envKeys.filter((key) => !isPlaceholder(deps.env[key]));
          const baseUrlKey = (signature.baseUrlEnvKeys ?? []).find((key) => !isPlaceholder(deps.env[key]));
          const baseUrl = baseUrlKey ? normalizeBaseUrl(deps.env[baseUrlKey] as string) : "";
          if (presentKeys.length === 0 && !baseUrl && !signature.localEndpoints?.length) continue;

          if (baseUrl) {
            envBaseUrls.push({
              endpoint: baseUrl,
              signature,
              source: { kind: "environment", detail: `Base URL from ${baseUrlKey}` },
            });
          }
          if (presentKeys.length === 0) continue;
          envHits += 1;
          addFinding(snapshot, inventory, {
            ...baseFinding(signature),
            id: crypto.createHash("sha1").update(`env|${signature.id}`).digest("hex").slice(0, 16),
            status: "detected_unverified",
            sources: [{ kind: "environment", detail: `Credential present in ${presentKeys.join(", ")}` }],
            location: "unknown",
            credential: "present",
            credentialEnvKeys: presentKeys,
            models: [],
            requirements: [
              signature.category === "hosted"
                ? "No non-billable validation was attempted for a hosted provider."
                : "Validate the endpoint from the agent setup screen.",
            ],
            warnings: [],
            confidence: "medium",
            setup: {
              ...(signature.setupProviderKey ? { providerKey: signature.setupProviderKey } : {}),
              ...(signature.aiConnectionProvider ? { aiConnectionProvider: signature.aiConnectionProvider } : {}),
              ...(baseUrl ? { baseUrl } : {}),
            },
          });
        }

        for (const genericKey of GENERIC_BASE_URL_ENV_KEYS) {
          const value = deps.env[genericKey];
          if (isPlaceholder(value)) continue;
          envBaseUrls.push({
            endpoint: normalizeBaseUrl(value as string),
            source: { kind: "generic_endpoint", detail: `Base URL from ${genericKey}` },
          });
        }
        markStage(snapshot, "environment", "completed", `${envHits} credential variable group(s), ${envBaseUrls.length} base URL(s)`);
      } catch (error) {
        markStage(snapshot, "environment", "failed", (error as Error).message);
        snapshot.warnings.push("Environment inspection failed; continuing.");
      }

      if (cancelled()) return finish("cancelled");

      // ── Stage 3: bounded config files ─────────────────────────────────────
      markStage(snapshot, "config_files", "running");
      let filesRead = 0;
      try {
        for (const rule of CONFIG_FILE_RULES) {
          if (deps.now() > deadline) {
            snapshot.limitations.push("Config-file scan stopped at the time budget.");
            break;
          }
          const path = `${deps.homeDir()}/${rule.relativePath}`;
          const raw = deps.readBoundedFile(path, MAX_CONFIG_FILE_BYTES);
          if (raw === null) continue;
          filesRead += 1;
          if (rule.format === "json") {
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              snapshot.warnings.push(`Could not parse ${rule.relativePath}; skipped.`);
              continue;
            }
            for (const [providerId, rule2] of Object.entries(rule.jsonProviderKeys ?? {})) {
              const entry = parsed[providerId];
              if (!entry || typeof entry !== "object") continue;
              const record = entry as Record<string, unknown>;
              const present = (rule2.credentialKeys ?? []).some((key) => !isPlaceholder(
                typeof record[key] === "string" ? (record[key] as string) : undefined,
              ));
              const baseUrlKey = (rule2.baseUrlKeys ?? []).find(
                (key) => typeof record[key] === "string" && (record[key] as string).trim(),
              );
              if (!present && !baseUrlKey) continue;
              const signature = getProviderSignature(providerId);
              addFinding(snapshot, inventory, {
                ...(signature
                  ? baseFinding(signature)
                  : { providerId, label: providerId, category: "compatible" as const }),
                id: crypto.createHash("sha1").update(`file|${providerId}|${rule.relativePath}`).digest("hex").slice(0, 16),
                status: "detected_unverified",
                sources: [{ kind: "config_file", detail: rule.relativePath }],
                location: "unknown",
                credential: present ? "present" : "unknown",
                credentialEnvKeys: [],
                models: [],
                requirements: ["Validate this provider from the agent setup screen."],
                warnings: [],
                confidence: "medium",
                setup: {
                  ...(signature?.setupProviderKey ? { providerKey: signature.setupProviderKey } : {}),
                  ...(baseUrlKey ? { baseUrl: normalizeBaseUrl(record[baseUrlKey] as string) } : {}),
                },
              });
            }
          } else {
            for (const pattern of rule.textPatterns ?? []) {
              const baseMatch = pattern.baseUrl ? pattern.baseUrl.exec(raw) : null;
              const credentialMatch = pattern.credential ? pattern.credential.exec(raw) : null;
              if (!baseMatch && !credentialMatch) continue;
              const signature = getProviderSignature(pattern.providerId);
              addFinding(snapshot, inventory, {
                ...(signature
                  ? baseFinding(signature)
                  : { providerId: pattern.providerId, label: pattern.providerId, category: "compatible" as const }),
                id: crypto.createHash("sha1").update(`file|${pattern.providerId}|${rule.relativePath}`).digest("hex").slice(0, 16),
                status: "detected_unverified",
                sources: [{ kind: "config_file", detail: rule.relativePath }],
                location: "unknown",
                credential: credentialMatch ? "present" : "unknown",
                credentialEnvKeys: [],
                models: [],
                requirements: ["Validate this provider from the agent setup screen."],
                warnings: [],
                confidence: "medium",
                setup: {
                  ...(signature?.setupProviderKey ? { providerKey: signature.setupProviderKey } : {}),
                  ...(baseMatch?.[1] ? { baseUrl: normalizeBaseUrl(baseMatch[1]) } : {}),
                },
              });
            }
          }
        }
        markStage(snapshot, "config_files", "completed", `${filesRead} file(s) read`);
      } catch (error) {
        markStage(snapshot, "config_files", "failed", (error as Error).message);
        snapshot.warnings.push("Config-file inspection failed; continuing.");
      }

      if (cancelled()) return finish("cancelled");

      // ── Stage 4: documented local service ports ───────────────────────────
      markStage(snapshot, "local_services", "running");
      const probeTargets: Array<{
        signature?: ProviderSignature;
        endpoint: string;
        modelsPath: string;
        modelsFormat: "openai" | "ollama" | "none";
        source: FindingSource;
      }> = [];
      const localTargets: typeof probeTargets = [];
      for (const signature of PROVIDER_SIGNATURES) {
        for (const hint of signature.localEndpoints ?? []) {
          localTargets.push({
            signature,
            endpoint: `http://127.0.0.1:${hint.port}${hint.basePath ?? ""}`,
            modelsPath: hint.modelsPath,
            modelsFormat: hint.modelsFormat,
            source: { kind: "local_service", detail: `Documented port ${hint.port}` },
          });
        }
      }
      try {
        const probed = await mapWithConcurrency(localTargets, MAX_CONCURRENT_PROBES, async (target) => {
          if (cancelled() || deps.now() > deadline) return null;
          const finding = await probeCandidate({
            signature: target.signature,
            endpoint: target.endpoint,
            modelsPath: target.modelsPath,
            modelsFormat: target.modelsFormat,
            signal: controller.signal,
            source: target.source,
            deployment,
          });
          // A closed documented port is not a finding: only report services
          // that answered at all.
          if (finding.status === "not_reachable" && finding.warnings.some((w) => w.includes("ECONNREFUSED"))) {
            return null;
          }
          return finding;
        });
        for (const finding of probed) {
          if (finding) addFinding(snapshot, inventory, finding);
        }
        const reachable = probed.filter(Boolean).length;
        markStage(snapshot, "local_services", "completed", `${localTargets.length} documented port(s), ${reachable} answering`);
      } catch (error) {
        markStage(snapshot, "local_services", "failed", (error as Error).message);
        snapshot.warnings.push("Local service probing failed; continuing.");
      }

      if (cancelled()) return finish("cancelled");

      // ── Stage 5: containers ───────────────────────────────────────────────
      markStage(snapshot, "containers", "running");
      try {
        const listing = await deps.listContainers(3_000);
        if (!listing.available) {
          markStage(snapshot, "containers", "skipped", listing.error ?? "container runtime unavailable");
          snapshot.limitations.push(
            "Container inspection is unavailable (Docker CLI missing or not permitted); services in other containers were not scanned.",
          );
        } else {
          const host =
            deployment.mode === "container"
              ? (deployment.hostGatewayCandidates[0] ?? "host.docker.internal")
              : "127.0.0.1";
          let matched = 0;
          for (const container of listing.containers) {
            const haystack = `${container.image} ${container.name}`.toLowerCase();
            const signature = PROVIDER_SIGNATURES.find((entry) =>
              (entry.containerHints ?? []).some((hint) => haystack.includes(hint)),
            );
            if (!signature) continue;
            matched += 1;
            const hint = signature.localEndpoints?.[0];
            const published = container.publishedPorts.find(
              (port) => !hint || port.containerPort === hint.port,
            ) ?? container.publishedPorts[0];
            if (!published) {
              addFinding(snapshot, inventory, {
                ...baseFinding(signature),
                id: crypto.createHash("sha1").update(`container|${signature.id}|${container.id}`).digest("hex").slice(0, 16),
                status: "not_reachable",
                sources: [{ kind: "container", detail: `${container.name} (${container.image})` }],
                location: "container",
                credential: "unknown",
                credentialEnvKeys: [],
                models: [],
                requirements: ["Publish the service port so Paperclip can reach it."],
                warnings: [`${container.name} publishes no host port.`],
                confidence: "medium",
                setup: { ...(signature.setupProviderKey ? { providerKey: signature.setupProviderKey } : {}) },
              });
              continue;
            }
            probeTargets.push({
              signature,
              endpoint: `http://${host}:${published.hostPort}${hint?.basePath ?? ""}`,
              modelsPath: hint?.modelsPath ?? "/v1/models",
              modelsFormat: hint?.modelsFormat ?? "openai",
              source: { kind: "container", detail: `${container.name} (${container.image}) → host port ${published.hostPort}` },
            });
          }
          markStage(
            snapshot,
            "containers",
            "completed",
            `${listing.containers.length} container(s) inspected; ${matched} matched a known service`,
          );
        }
      } catch (error) {
        markStage(snapshot, "containers", "failed", (error as Error).message);
        snapshot.warnings.push("Container inspection failed; continuing.");
      }

      if (cancelled()) return finish("cancelled");

      // ── Stage 6: probe configured and discovered endpoints ────────────────
      markStage(snapshot, "endpoint_probes", "running");
      try {
        for (const target of envBaseUrls) {
          probeTargets.push({
            signature: target.signature,
            endpoint: target.endpoint,
            modelsPath: target.signature?.localEndpoints?.[0]?.modelsPath ?? "/v1/models",
            modelsFormat: target.signature?.localEndpoints?.[0]?.modelsFormat ?? "openai",
            source: target.source,
          });
        }
        // Only endpoints discovered on this machine or explicitly configured are
        // probed. Public/hosted provider APIs are never called during a scan.
        const probeable = probeTargets.filter((target) => {
          const location = locationFor(target.endpoint, deployment);
          return location === "local" || location === "host" || location === "container" || location === "remote";
        });
        const findings = await mapWithConcurrency(probeable, MAX_CONCURRENT_PROBES, async (target) => {
          if (cancelled() || deps.now() > deadline) return null;
          // Hosted signatures with a public default URL stay unprobed: that
          // would be a billable/credentialed request.
          if (
            target.signature?.category === "hosted" &&
            target.endpoint.startsWith(target.signature.defaultBaseUrl ?? "\u0000")
          ) {
            return null;
          }
          return probeCandidate({
            signature: target.signature,
            endpoint: target.endpoint,
            modelsPath: target.modelsPath,
            modelsFormat: target.modelsFormat,
            signal: controller.signal,
            source: target.source,
            deployment,
          });
        });
        for (const finding of findings) {
          if (finding) addFinding(snapshot, inventory, finding);
        }
        markStage(snapshot, "endpoint_probes", "completed", `${probeable.length} endpoint(s) probed`);
      } catch (error) {
        markStage(snapshot, "endpoint_probes", "failed", (error as Error).message);
        snapshot.warnings.push("Endpoint probing failed; continuing.");
      }

      if (cancelled()) return finish("cancelled");

      // ── Stage 7: normalize ────────────────────────────────────────────────
      markStage(snapshot, "normalize", "running");
      snapshot.findings = inventory.snapshot();
      const duplicates = snapshot.findings.filter((finding) =>
        finding.warnings.some((warning) => warning.includes("consolidated")),
      ).length;
      markStage(
        snapshot,
        "normalize",
        "completed",
        `${snapshot.findings.length} provider(s), ${duplicates} consolidated`,
      );

      if (snapshot.findings.length === 0) {
        snapshot.limitations.push(
          "No providers were found. This is a genuine empty result only if every stage above completed; check skipped stages for permissions or runtime limits.",
        );
      }
      finish("completed");
    } catch (error) {
      snapshot.warnings.push(`Scan failed: ${(error as Error).message}`);
      finish("failed", (error as Error).message);
    }
  }

  function snapshotFor(snapshot: ScanSnapshot): ScanSnapshot {
    // Defensive copy so a poll cannot mutate job state.
    return JSON.parse(JSON.stringify(snapshot)) as ScanSnapshot;
  }

  return {
    start(companyId: string): ScanSnapshot {
      pruneJobs(deps.now());
      const deployment = deploymentContext();
      const snapshot: ScanSnapshot = {
        id: crypto.randomUUID(),
        companyId,
        status: "running",
        stage: null,
        stages: STAGE_ORDER.map((stage) => ({ stage, status: "pending" })),
        deployment: {
          mode: deployment.mode,
          hostGatewayCandidates: deployment.hostGatewayCandidates,
          loopbackIsProcessLocalOnly: deployment.loopbackIsProcessLocalOnly,
          platform: deployment.platform,
        },
        findings: [],
        warnings: [],
        limitations: [],
        startedAt: new Date(deps.now()).toISOString(),
      };
      if (deployment.mode === "container") {
        snapshot.limitations.push(
          "Paperclip runs in a container: host filesystem, host environment variables and host processes are not visible. Host-side services were probed only through published ports/gateway aliases.",
        );
      }
      const job = { snapshot, controller: new AbortController(), companyId };
      jobs.set(snapshot.id, job);
      void runScan(job);
      return snapshotFor(snapshot);
    },

    get(companyId: string, scanId: string): ScanSnapshot | null {
      const job = jobs.get(scanId);
      if (!job || job.companyId !== companyId) return null;
      return snapshotFor(job.snapshot);
    },

    cancel(companyId: string, scanId: string): ScanSnapshot | null {
      const job = jobs.get(scanId);
      if (!job || job.companyId !== companyId) return null;
      if (job.snapshot.status === "running") {
        job.controller.abort();
        job.snapshot.status = "cancelled";
        job.snapshot.stage = null;
        job.snapshot.finishedAt = new Date(deps.now()).toISOString();
        job.snapshot.limitations.push("Scan cancelled by the user; results are partial.");
      }
      return snapshotFor(job.snapshot);
    },
  };
}

export function listDiscoverableProviders() {
  return PROVIDER_SIGNATURES.map((signature) => ({
    id: signature.id,
    label: signature.label,
    category: signature.category,
    auth: signature.auth,
    credentialEnvKeys: signature.envKeys,
    baseUrlEnvKeys: signature.baseUrlEnvKeys ?? [],
    defaultBaseUrl: signature.defaultBaseUrl ?? null,
    localPorts: (signature.localEndpoints ?? []).map((hint) => hint.port),
    setupProviderKey: signature.setupProviderKey ?? null,
  }));
}
