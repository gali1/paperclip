/**
 * Deployment introspection for agent discovery and connectivity diagnostics.
 *
 * The single rule this module encodes: `localhost` inside a container is the
 * container, not the host. Everything else (host gateway lookup, bind address
 * sanity checks) follows from knowing which namespace this process runs in.
 *
 * All inputs are injectable so the behaviour is testable without Docker.
 *
 * @module server/services/agent-discovery/deployment
 */

import fs from "node:fs";
import os from "node:os";
import type { DeploymentContext, DiscoveryEvidence } from "./types.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0:0:0:0:0:0:0:1"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", ""]);

export function isLoopbackHost(host: string | null | undefined): boolean {
  return LOOPBACK_HOSTS.has((host ?? "").trim().toLowerCase());
}

export function isWildcardBind(host: string | null | undefined): boolean {
  return WILDCARD_HOSTS.has((host ?? "").trim().toLowerCase());
}

export interface ContainerDetectionInput {
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string) => string;
}

export interface ContainerDetection {
  inContainer: boolean;
  evidence: string[];
  runtime: "docker" | "podman" | "kubernetes" | "unknown" | null;
}

/**
 * Detect whether this process runs inside a container.
 *
 * Deliberately conservative: an env override wins, then the well-known marker
 * files, then the pid-1 cgroup. We never shell out.
 */
export function detectContainer(input: ContainerDetectionInput = {}): ContainerDetection {
  const env = input.env ?? process.env;
  const existsSync = input.existsSync ?? fs.existsSync;
  const readFileSync =
    input.readFileSync ??
    ((path: string) => {
      try {
        return fs.readFileSync(path, "utf8");
      } catch {
        return "";
      }
    });

  const evidence: string[] = [];
  let runtime: ContainerDetection["runtime"] = null;

  const override = (env.PAPERCLIP_CONTAINER ?? "").trim().toLowerCase();
  if (override === "1" || override === "true" || override === "yes") {
    evidence.push("env:PAPERCLIP_CONTAINER");
  }

  if (existsSync("/.dockerenv")) {
    evidence.push("file:/.dockerenv");
    runtime ??= "docker";
  }
  if (existsSync("/run/.containerenv")) {
    evidence.push("file:/run/.containerenv");
    runtime ??= "podman";
  }

  const cgroup = readFileSync("/proc/1/cgroup");
  if (cgroup) {
    if (/(?:^|\/)(?:docker|containerd)(?:\/|$)/.test(cgroup)) {
      evidence.push("cgroup:docker");
      runtime ??= "docker";
    } else if (/kubepods/.test(cgroup)) {
      evidence.push("cgroup:kubernetes");
      runtime ??= "kubernetes";
    } else if (/libpod|lxc/.test(cgroup)) {
      evidence.push("cgroup:podman-or-lxc");
      runtime ??= "podman";
    }
  }

  if ((env.KUBERNETES_SERVICE_HOST ?? "").trim()) {
    evidence.push("env:KUBERNETES_SERVICE_HOST");
    runtime ??= "kubernetes";
  }

  return { inContainer: evidence.length > 0, evidence, runtime };
}

/**
 * The default IPv4 gateway from /proc/net/route (Linux).
 *
 * The gateway field is little-endian hex, so `0102A8C0` is 192.168.2.1.
 * Returns null on anything unexpected; callers fall back to host aliases.
 */
export function readDefaultGatewayIpv4(readFileSync: (path: string) => string): string | null {
  const raw = readFileSync("/proc/net/route");
  if (!raw) return null;
  for (const line of raw.split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 3) continue;
    if (columns[1] !== "00000000") continue;
    const gateway = columns[2];
    if (!/^[0-9a-fA-F]{8}$/.test(gateway)) continue;
    const bytes = [
      parseInt(gateway.slice(6, 8), 16),
      parseInt(gateway.slice(4, 6), 16),
      parseInt(gateway.slice(2, 4), 16),
      parseInt(gateway.slice(0, 2), 16),
    ];
    if (bytes.some((byte) => Number.isNaN(byte))) continue;
    return bytes.join(".");
  }
  return null;
}

/**
 * Ordered list of hostnames/IPs that reach the host from inside a container.
 *
 * `host.docker.internal` works on Docker Desktop (macOS/Windows) and on Linux
 * only when the container was started with an explicit host-gateway mapping,
 * which is why the raw gateway IP is kept as a second candidate. Docker
 * Compose adds `host.docker.internal` itself in recent versions.
 */
export function resolveHostGatewayCandidates(input: {
  env: NodeJS.ProcessEnv;
  readFileSync: (path: string) => string;
}): string[] {
  const candidates: string[] = [];
  const push = (value: string | null | undefined) => {
    const trimmed = (value ?? "").trim();
    if (!trimmed) return;
    if (!candidates.includes(trimmed)) candidates.push(trimmed);
  };

  push(input.env.PAPERCLIP_HOST_GATEWAY);
  push(input.env.PAPERCLIP_HOST_FROM_CONTAINER);
  push("host.docker.internal");
  push(readDefaultGatewayIpv4(input.readFileSync));
  push("gateway.docker.internal");
  return candidates;
}

export function collectReachableHostAddresses(
  interfaces: NodeJS.Dict<Array<{ address: string; family: string | number; internal: boolean }>>,
): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const family = typeof entry.family === "string" ? entry.family : String(entry.family);
      if (family !== "IPv4" && family !== "4") continue;
      if (entry.internal) continue;
      if (entry.address.startsWith("127.")) continue;
      if (!addresses.includes(entry.address)) addresses.push(entry.address);
    }
  }
  return addresses;
}

export interface BuildDeploymentContextInput {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string) => string;
  networkInterfaces?: NodeJS.Dict<Array<{ address: string; family: string | number; internal: boolean }>>;
  bindHost: string;
  port: number;
  publicUrl?: string;
  deploymentMode?: string;
  deploymentExposure?: string;
}

/**
 * Build the deployment context plus the checks that explain it.
 *
 * These checks are advisory: they never change configuration, they only tell
 * the operator what the current binding actually implies.
 */
export function buildDeploymentContext(input: BuildDeploymentContextInput): DeploymentContext {
  const env = input.env ?? process.env;
  const readFileSync = input.readFileSync ?? ((path: string) => {
    try {
      return fs.readFileSync(path, "utf8");
    } catch {
      return "";
    }
  });
  const detection = detectContainer({
    env,
    existsSync: input.existsSync,
    readFileSync,
  });
  const inContainer = detection.inContainer;
  const checks: DiscoveryEvidence[] = [];

  const bindHost = input.bindHost?.trim() || "127.0.0.1";
  const port = input.port;
  const hostGatewayCandidates = inContainer
    ? resolveHostGatewayCandidates({ env, readFileSync })
    : [];

  if (inContainer) {
    checks.push({
      stage: "local_services",
      code: "deployment_container_detected",
      level: "info",
      message: `Paperclip is running inside a container (${detection.runtime ?? "unknown runtime"}).`,
      detail: detection.evidence.join(", "),
    });
    if (isLoopbackHost(bindHost)) {
      checks.push({
        stage: "local_services",
        code: "deployment_container_loopback_bind",
        level: "error",
        message:
          "The server is bound to loopback inside a container, so published ports cannot reach it. Bind to 0.0.0.0 (PAPERCLIP_BIND=lan) or set an explicit host.",
        detail: `bindHost=${bindHost}`,
      });
    }
    if (hostGatewayCandidates.length === 0) {
      checks.push({
        stage: "local_services",
        code: "deployment_no_host_gateway",
        level: "warn",
        message:
          "No host gateway candidate could be derived. Set PAPERCLIP_HOST_GATEWAY or add extra_hosts: [\"host.docker.internal:host-gateway\"].",
      });
    }
  } else if (!isLoopbackHost(bindHost) && input.deploymentMode === "local_trusted") {
    checks.push({
      stage: "local_services",
      code: "deployment_unauthenticated_exposure",
      level: "warn",
      message:
        "The server is reachable beyond loopback while authentication is disabled (local_trusted). Use authenticated mode for shared or network-accessible deployments.",
      detail: `bindHost=${bindHost}`,
    });
  }

  const publicUrl = input.publicUrl?.trim();
  if (publicUrl) {
    try {
      const hostname = new URL(publicUrl).hostname;
      if (isLoopbackHost(hostname) && input.deploymentExposure === "public") {
        checks.push({
          stage: "remote_endpoints",
          code: "deployment_public_url_loopback",
          level: "warn",
          message:
            "PAPERCLIP_PUBLIC_URL points at loopback while exposure is public; remote browsers will not resolve it. Set the externally reachable URL.",
          detail: publicUrl,
        });
      }
    } catch {
      checks.push({
        stage: "remote_endpoints",
        code: "deployment_public_url_invalid",
        level: "warn",
        message: "PAPERCLIP_PUBLIC_URL is not a valid absolute URL.",
        detail: publicUrl,
      });
    }
  }

  return {
    mode: inContainer ? "container" : "native",
    platform: input.platform ?? process.platform,
    containerEvidence: detection.evidence,
    bindHost,
    port,
    ...(publicUrl ? { publicUrl } : {}),
    ...(input.deploymentMode ? { deploymentMode: input.deploymentMode } : {}),
    ...(input.deploymentExposure ? { deploymentExposure: input.deploymentExposure } : {}),
    hostGatewayCandidates,
    reachableHostAddresses: collectReachableHostAddresses(
      input.networkInterfaces ?? os.networkInterfaces(),
    ),
    loopbackIsProcessLocalOnly: inContainer,
    checks,
  };
}
