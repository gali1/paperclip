/**
 * Types for deployment-aware agent discovery.
 *
 * Discovery answers a single question for the UI and API: "what can this
 * Paperclip instance actually talk to right now, and how do I configure it?"
 * Every candidate carries its evidence so a failure can be explained instead of
 * guessed at.
 *
 * @module server/services/agent-discovery/types
 */

export type DiscoverySourceKind =
  | "registered_agent"
  | "cli"
  | "local_api"
  | "docker_container"
  | "remote_endpoint";

export type DiscoveryStage =
  | "existing_configuration"
  | "local_environment"
  | "local_services"
  | "container_runtime"
  | "remote_endpoints"
  | "validation";

export type DiscoveryLevel = "info" | "warn" | "error";

export type DiscoveryTransport = "cli" | "http" | "websocket" | "acp";

export interface DiscoveryEvidence {
  stage: DiscoveryStage;
  code: string;
  level: DiscoveryLevel;
  message: string;
  detail?: string;
}

export interface DiscoveredAgent {
  /** Stable fingerprint; safe to use as a React key or to reconcile duplicates. */
  id: string;
  adapterType: string;
  source: DiscoverySourceKind;
  transport: DiscoveryTransport;
  label: string;
  /** Absolute path when the candidate is a local executable. */
  executablePath?: string;
  version?: string | null;
  /** Normalized http(s)/ws(s) endpoint when the candidate speaks a protocol. */
  endpoint?: string;
  /** An existing Paperclip agent row this candidate corresponds to. */
  agentId?: string;
  agentName?: string;
  /** True when the probe reached the executable/service. */
  reachable: boolean;
  /** True only when the adapter's own environment test accepted the config. */
  validated: boolean;
  validationStatus?: "pass" | "warn" | "fail" | "skipped";
  /** Adapter config to apply if the user adopts this candidate. Never contains secrets. */
  configPatch: Record<string, unknown>;
  /** Non-secret fields the user still has to supply (for example an API key). */
  requiredInputs: string[];
  capabilities: string[];
  warnings: string[];
  evidence: DiscoveryEvidence[];
}

export interface DeploymentContext {
  mode: "native" | "container";
  platform: NodeJS.Platform;
  containerEvidence: string[];
  bindHost: string;
  port: number;
  publicUrl?: string;
  deploymentMode?: string;
  deploymentExposure?: string;
  /** How this process can reach the Docker/VM host, best first. Empty when native. */
  hostGatewayCandidates: string[];
  /** IPv4 addresses the GUI is reachable on when bound to all interfaces. */
  reachableHostAddresses: string[];
  loopbackIsProcessLocalOnly: boolean;
  checks: DiscoveryEvidence[];
}

export interface DiscoveryReport {
  adapterType: string;
  companyId: string;
  generatedAt: string;
  durationMs: number;
  deployment: DeploymentContext;
  candidates: DiscoveredAgent[];
  /** Ordered list of the checks that ran, including the ones that failed. */
  checks: DiscoveryEvidence[];
  cache: { hit: boolean; ageMs: number };
  notes: string[];
}

export interface RegisteredAgent {
  id: string;
  name: string;
  adapterConfig: Record<string, unknown>;
  status?: string | null;
  lastHeartbeatAt?: Date | string | null;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  /** Host ports published for this container, e.g. [{ hostPort: 8642, containerPort: 8642 }]. */
  publishedPorts: Array<{ hostPort: number; containerPort: number }>;
}

export interface HttpProbeResult {
  ok: boolean;
  status: number | null;
  url: string;
  bodySnippet?: string;
  json?: unknown;
  error?: string;
}

export interface ExecutableProbeResult {
  path: string;
  ok: boolean;
  output?: string;
  error?: string;
}

export interface DiscoveryServiceDeps {
  now(): number;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  /** Bounded read used for cheap identity checks on script entry points. */
  readFilePrefix(path: string, maxBytes: number): string;
  isExecutable(path: string): boolean;
  homeDir(): string;
  pathSeparator(): string;
  networkInterfaces(): NodeJS.Dict<Array<{ address: string; family: string | number; internal: boolean }>>;
  probeExecutable(path: string, args: string[], timeoutMs: number): Promise<ExecutableProbeResult>;
  probeHttp(url: string, opts: { timeoutMs: number; headers?: Record<string, string> }): Promise<HttpProbeResult>;
  probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean>;
  listContainers(timeoutMs: number): Promise<{ available: boolean; containers: ContainerInfo[]; error?: string }>;
  testEnvironment(adapterType: string, config: Record<string, unknown>): Promise<{
    status: "pass" | "warn" | "fail";
    checks: Array<{ code?: string; level: DiscoveryLevel; message: string }>;
  } | null>;
  listRegisteredAgents(companyId: string, adapterType: string): Promise<RegisteredAgent[]>;
}
