import { describe, expect, it, vi } from "vitest";
import { createDiscoveryService } from "./service.js";
import type { DiscoveryServiceDeps, RegisteredAgent } from "./types.js";

function makeDeps(overrides: Partial<DiscoveryServiceDeps> = {}): DiscoveryServiceDeps {
  return {
    now: () => 1_000_000,
    env: { PATH: "/opt/bin" },
    platform: "linux",
    existsSync: (path) => path === "/opt/bin/hermes",
    readFileSync: () => "",
    readFilePrefix: () => "",
    isExecutable: () => true,
    homeDir: () => "/home/tester",
    pathSeparator: () => ":",
    networkInterfaces: () => ({}),
    probeExecutable: async (path) => ({ path, ok: true, output: "hermes 0.9.1" }),
    probeHttp: async (url) => ({ ok: false, status: null, url, error: "ECONNREFUSED" }),
    probeTcp: async () => false,
    listContainers: async () => ({ available: false, containers: [], error: "docker_cli_not_found" }),
    testEnvironment: async () => ({ status: "pass", checks: [] }),
    listRegisteredAgents: async () => [],
    ...overrides,
  };
}

const deployment = { bindHost: "127.0.0.1", port: 3100, deploymentMode: "authenticated", deploymentExposure: "private" };

describe("agent discovery — native host", () => {
  it("finds a CLI agent, proves its identity, and validates the config", async () => {
    const probeExecutable = vi.fn(async (path: string) => ({ path, ok: true, output: "hermes 0.9.1" }));
    const testEnvironment = vi.fn(async () => ({ status: "pass" as const, checks: [] }));
    const service = createDiscoveryService({
      deployment,
      deps: makeDeps({ probeExecutable, testEnvironment }),
    });

    const report = await service.discover({ companyId: "company-1", adapterType: "hermes_local" });

    expect(report.deployment.mode).toBe("native");
    const candidate = report.candidates.find((entry) => entry.source === "cli");
    expect(candidate).toBeDefined();
    expect(candidate?.executablePath).toBe("/opt/bin/hermes");
    expect(candidate?.version).toBe("hermes 0.9.1");
    expect(candidate?.reachable).toBe(true);
    expect(candidate?.validated).toBe(true);
    expect(candidate?.configPatch).toEqual({ command: "/opt/bin/hermes" });
    expect(probeExecutable).toHaveBeenCalledWith(
      "/opt/bin/hermes",
      ["--version"],
      expect.any(Number),
    );
    expect(testEnvironment).toHaveBeenCalledWith("hermes_local", {
      command: "/opt/bin/hermes",
    });
  });

  it("explains the failure and the install hint when nothing is installed", async () => {
    const service = createDiscoveryService({
      deployment,
      deps: makeDeps({ existsSync: () => false, isExecutable: () => false }),
    });

    const report = await service.discover({ companyId: "company-1", adapterType: "hermes_local" });

    expect(report.candidates).toEqual([]);
    expect(report.checks.map((check) => check.code)).toContain("executable_not_found");
    expect(report.checks.find((check) => check.code === "executable_not_found")?.detail).toContain(
      "pip install hermes-agent",
    );
    expect(report.notes.join(" ")).toContain("Nothing was found");
  });

  it("reports a binary whose version output does not match the expected agent", async () => {
    const service = createDiscoveryService({
      deployment,
      deps: makeDeps({
        probeExecutable: async (path) => ({ path, ok: true, output: "something-else 1.0" }),
      }),
    });

    const report = await service.discover({ companyId: "company-1", adapterType: "hermes_local" });
    const candidate = report.candidates.find((entry) => entry.source === "cli");

    expect(candidate?.warnings.join(" ")).toContain("did not report a recognizable");
    expect(candidate?.evidence.map((entry) => entry.code)).toContain("identity_unverified");
  });

  it("still identifies a slow CLI from its entry point when --version times out", async () => {
    const service = createDiscoveryService({
      deployment,
      deps: makeDeps({
        probeExecutable: async (path) => ({ path, ok: false, error: "timeout" }),
        readFilePrefix: () => "#!/bin/sh\nexec python3 -m hermes_agent \"$@\"\n",
      }),
    });

    const report = await service.discover({ companyId: "company-1", adapterType: "hermes_local" });
    const candidate = report.candidates.find((entry) => entry.source === "cli");

    expect(candidate?.reachable).toBe(true);
    expect(candidate?.warnings).toEqual([]);
    expect(candidate?.evidence.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["executable_probe_timeout", "identity_from_executable_file"]),
    );
  });

  it("keeps a registered agent and merges the live executable into it", async () => {
    const registered: RegisteredAgent[] = [
      {
        id: "agent-1",
        name: "Ada",
        adapterConfig: { command: "hermes" },
        status: "idle",
      },
    ];
    const service = createDiscoveryService({
      deployment,
      deps: makeDeps({ listRegisteredAgents: async () => registered }),
    });

    const report = await service.discover({ companyId: "company-1", adapterType: "hermes_local" });
    const candidates = report.candidates.filter((entry) => entry.executablePath === "/opt/bin/hermes");

    expect(candidates).toHaveLength(1);
    expect(candidates[0].source).toBe("registered_agent");
    expect(candidates[0].agentId).toBe("agent-1");
    expect(candidates[0].version).toBe("hermes 0.9.1");
    expect(candidates[0].evidence.map((entry) => entry.code)).toContain("agent_registered");
  });
});

describe("agent discovery — container to host", () => {
  it("rewrites a loopback endpoint to the host gateway and keeps the reachable one", async () => {
    const probeHttp = vi.fn(async (url: string) =>
      url.includes("host.docker.internal") && url.includes(":8642")
        ? { ok: true, status: 200, url, json: { status: "ok" }, bodySnippet: '{"status":"ok"}' }
        : { ok: false, status: null, url, error: "ECONNREFUSED" },
    );
    const service = createDiscoveryService({
      deployment: { ...deployment, bindHost: "0.0.0.0" },
      deps: makeDeps({
        env: { PAPERCLIP_CONTAINER: "1" },
        existsSync: (path) => path === "/.dockerenv",
        readFileSync: (path) =>
          path === "/proc/net/route"
            ? "Iface\tDestination\tGateway\neth0\t00000000\t0102A8C0\t0003"
            : "",
        probeHttp,
      }),
    });

    const report = await service.discover({ companyId: "company-1", adapterType: "hermes_gateway" });

    expect(report.deployment.mode).toBe("container");
    const reachable = report.candidates.filter((candidate) => candidate.reachable);
    expect(reachable).toHaveLength(1);
    expect(reachable[0].endpoint).toContain("host.docker.internal");
    expect(reachable[0].configPatch).toEqual({ apiBaseUrl: reachable[0].endpoint });
    expect(reachable[0].requiredInputs).toContain("apiKey");
    expect(report.candidates.some((candidate) => candidate.endpoint?.includes("127.0.0.1"))).toBe(true);
  });

  it("gives a WebSocket agent a ws:// config patch", async () => {
    const service = createDiscoveryService({
      deployment,
      deps: makeDeps({
        existsSync: () => false,
        isExecutable: () => false,
        probeHttp: async (url) => ({ ok: true, status: 200, url }),
      }),
    });

    const report = await service.discover({ companyId: "company-1", adapterType: "openclaw_gateway" });
    const candidate = report.candidates.find((entry) => entry.source === "local_api");

    expect(candidate?.transport).toBe("websocket");
    expect(candidate?.endpoint).toBe("ws://127.0.0.1:18789/");
    expect(candidate?.configPatch).toEqual({ url: "ws://127.0.0.1:18789/" });
  });

  it("flags a matching container that publishes no host port", async () => {
    const service = createDiscoveryService({
      deployment: { ...deployment, bindHost: "0.0.0.0" },
      deps: makeDeps({
        env: { PAPERCLIP_CONTAINER: "1" },
        existsSync: (path) => path === "/.dockerenv",
        listContainers: async () => ({
          available: true,
          containers: [
            { id: "abc", name: "opencode-agent", image: "opencode-ai:latest", state: "running", publishedPorts: [] },
          ],
        }),
      }),
    });

    const report = await service.discover({ companyId: "company-1", adapterType: "opencode_local" });
    const container = report.candidates.find((candidate) => candidate.source === "docker_container");

    expect(container?.reachable).toBe(false);
    expect(container?.warnings.join(" ")).toContain("publishes no host port");
    expect(container?.evidence.map((entry) => entry.code)).toContain("container_port_unpublished");
  });

  it("discovers a published container port on a native host through 127.0.0.1", async () => {
    const service = createDiscoveryService({
      deployment,
      deps: makeDeps({
        existsSync: () => false,
        isExecutable: () => false,
        probeHttp: async (url) =>
          url.startsWith("http://127.0.0.1:4097")
            ? { ok: true, status: 200, url, json: { healthy: true } }
            : { ok: false, status: null, url, error: "ECONNREFUSED" },
        listContainers: async () => ({
          available: true,
          containers: [
            {
              id: "abc",
              name: "opencode",
              image: "opencode-ai:latest",
              state: "running",
              publishedPorts: [{ hostPort: 4097, containerPort: 4096 }],
            },
          ],
        }),
      }),
    });

    const report = await service.discover({ companyId: "company-1", adapterType: "opencode_local" });
    const container = report.candidates.find((candidate) => candidate.source === "docker_container");

    expect(container?.reachable).toBe(true);
    expect(container?.endpoint).toBe("http://127.0.0.1:4097/");
  });
});

describe("agent discovery — reporting", () => {
  it("marks a candidate unvalidated when the adapter test fails", async () => {
    const service = createDiscoveryService({
      deployment,
      deps: makeDeps({
        testEnvironment: async () => ({
          status: "fail" as const,
          checks: [{ code: "auth_missing", level: "error" as const, message: "No API key" }],
        }),
      }),
    });

    const report = await service.discover({ companyId: "company-1", adapterType: "hermes_local" });
    const candidate = report.candidates[0];

    expect(candidate.validationStatus).toBe("fail");
    expect(candidate.validated).toBe(false);
    expect(candidate.evidence.find((entry) => entry.stage === "validation")?.detail).toContain(
      "No API key",
    );
  });

  it("caches a report and serves it until the TTL expires", async () => {
    let now = 1_000_000;
    const listRegisteredAgents = vi.fn(async () => []);
    const service = createDiscoveryService({
      deployment,
      cacheTtlMs: 5_000,
      deps: makeDeps({ now: () => now, listRegisteredAgents }),
    });

    const first = await service.discover({ companyId: "company-1", adapterType: "hermes_local" });
    const second = await service.discover({ companyId: "company-1", adapterType: "hermes_local" });

    expect(first.cache.hit).toBe(false);
    expect(second.cache.hit).toBe(true);
    expect(listRegisteredAgents).toHaveBeenCalledTimes(1);

    now += 6_000;
    const third = await service.discover({ companyId: "company-1", adapterType: "hermes_local" });
    expect(third.cache.hit).toBe(false);
  });

  it("keys the cache by config overrides so a different endpoint is re-probed", async () => {
    const listRegisteredAgents = vi.fn(async () => []);
    const service = createDiscoveryService({
      deployment,
      deps: makeDeps({
        listRegisteredAgents,
        probeHttp: async (url) => ({ ok: true, status: 200, url, json: {} }),
      }),
    });

    await service.discover({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      configOverrides: { apiBaseUrl: "http://10.0.0.5:8642" },
    });
    await service.discover({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      configOverrides: { apiBaseUrl: "http://10.0.0.6:8642" },
    });

    expect(listRegisteredAgents).toHaveBeenCalledTimes(2);
  });

  it("probing twice with refresh truly re-runs the sweep", async () => {
    const listRegisteredAgents = vi.fn(async () => []);
    const service = createDiscoveryService({
      deployment,
      deps: makeDeps({ listRegisteredAgents }),
    });

    await service.discover({ companyId: "company-1", adapterType: "hermes_local" });
    await service.discover({ companyId: "company-1", adapterType: "hermes_local", refresh: true });

    expect(listRegisteredAgents).toHaveBeenCalledTimes(2);
  });

  it("probes an explicit remote endpoint and reports an invalid one", async () => {
    const service = createDiscoveryService({
      deployment,
      deps: makeDeps({
        probeHttp: async (url) =>
          url.includes("agent.example")
            ? { ok: true, status: 200, url, json: { ok: true } }
            : { ok: false, status: null, url, error: "ECONNREFUSED" },
      }),
    });

    const report = await service.discover({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      remoteEndpoints: ["https://agent.example:8642", "not-a-url"],
    });

    expect(
      report.candidates.some(
        (candidate) => candidate.source === "remote_endpoint" && candidate.reachable,
      ),
    ).toBe(true);
    expect(report.checks.map((check) => check.code)).toContain("remote_endpoint_invalid");
  });

  it("never copies a credential into the returned config patch", async () => {
    const service = createDiscoveryService({
      deployment,
      deps: makeDeps({
        probeHttp: async (url) => ({ ok: true, status: 200, url, json: {} }),
      }),
    });

    const report = await service.discover({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      configOverrides: { apiBaseUrl: "http://10.0.0.5:8642", apiKey: "super-secret" },
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("super-secret");
    expect(report.candidates.every((candidate) => !("apiKey" in candidate.configPatch))).toBe(true);
  });
});
