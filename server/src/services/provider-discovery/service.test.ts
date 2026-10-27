import { describe, expect, it, vi } from "vitest";
import { createProviderDiscoveryService, type ProviderDiscoveryDeps, type ScanSnapshot } from "./service.js";

const deployment = {
  bindHost: "127.0.0.1",
  port: 3100,
  deploymentMode: "authenticated",
  deploymentExposure: "private",
};

function makeDeps(overrides: Partial<ProviderDiscoveryDeps> = {}): ProviderDiscoveryDeps {
  return {
    env: { PATH: "/usr/bin" },
    platform: "linux",
    homeDir: () => "/home/tester",
    readBoundedFile: () => null,
    now: () => Date.now(),
    probeHttp: async (url) => ({ ok: false, status: null, url, error: "ECONNREFUSED" }),
    listContainers: async () => ({ available: false, containers: [], error: "docker_cli_not_found" }),
    listConfiguredEnvKeys: async () => [],
    ...overrides,
  };
}

async function waitForScan(
  service: ReturnType<typeof createProviderDiscoveryService>,
  companyId: string,
  scanId: string,
): Promise<ScanSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = service.get(companyId, scanId);
    if (!snapshot) throw new Error("scan disappeared");
    if (snapshot.status !== "running") return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("scan did not finish");
}

async function runScan(deps: Partial<ProviderDiscoveryDeps>): Promise<ScanSnapshot> {
  const service = createProviderDiscoveryService({ deps: makeDeps(deps), deployment });
  const started = service.start("company-1");
  return waitForScan(service, "company-1", started.id);
}

describe("provider discovery — configuration sources", () => {
  it("detects a provider from a supported environment variable without leaking it", async () => {
    const report = await runScan({ env: { OPENAI_API_KEY: "sk-live-super-secret-value" } });

    const openai = report.findings.find((finding) => finding.providerId === "openai");
    expect(openai?.status).toBe("detected_unverified");
    expect(openai?.credential).toBe("present");
    expect(openai?.credentialEnvKeys).toEqual(["OPENAI_API_KEY"]);
    expect(JSON.stringify(report)).not.toContain("sk-live-super-secret-value");
  });

  it("recognises a nonstandard credential alias", async () => {
    const report = await runScan({ env: { OPENAI_KEY: "sk-alias-value" } });
    const openai = report.findings.find((finding) => finding.providerId === "openai");

    expect(openai?.credential).toBe("present");
    expect(openai?.credentialEnvKeys).toContain("OPENAI_KEY");
  });

  it("ignores placeholder credentials", async () => {
    const report = await runScan({ env: { ANTHROPIC_API_KEY: "changeme" } });
    expect(report.findings.some((finding) => finding.providerId === "anthropic")).toBe(false);
  });

  it("reads a bounded client config file and reports it as a config source", async () => {
    const report = await runScan({
      readBoundedFile: (path) =>
        path.endsWith(".config/opencode/auth.json")
          ? JSON.stringify({ openrouter: { type: "api", key: "or-secret-value" } })
          : null,
    });

    const openrouter = report.findings.find((finding) => finding.providerId === "openrouter");
    expect(openrouter?.sources.map((source) => source.kind)).toContain("config_file");
    expect(JSON.stringify(report)).not.toContain("or-secret-value");
  });

  it("survives a malformed config file and records a warning", async () => {
    const report = await runScan({ readBoundedFile: () => "{ not json" });

    expect(report.status).toBe("completed");
    expect(report.warnings.join(" ")).toContain("Could not parse");
  });
});

describe("provider discovery — endpoints and classification", () => {
  it("marks a reachable local inference server with models as ready", async () => {
    const report = await runScan({
      probeHttp: async (url) =>
        url.includes(":11434/api/tags")
          ? {
              ok: true,
              status: 200,
              url,
              json: { models: [{ name: "llama3.2:3b" }, { name: "qwen2.5:7b" }] },
            }
          : { ok: false, status: null, url, error: "ECONNREFUSED" },
    });

    const ollama = report.findings.find((finding) => finding.providerId === "ollama");
    expect(ollama?.status).toBe("ready");
    expect(ollama?.location).toBe("local");
    expect(ollama?.models).toEqual(["llama3.2:3b", "qwen2.5:7b"]);
    expect(ollama?.setup.defaultModel).toBe("llama3.2:3b");
  });

  it("classifies a gateway that demands a key as needing configuration", async () => {
    const report = await runScan({
      probeHttp: async (url) =>
        url.includes(":4000/v1/models")
          ? { ok: false, status: 401, url, error: undefined }
          : { ok: false, status: null, url, error: "ECONNREFUSED" },
    });

    const litellm = report.findings.find((finding) => finding.providerId === "litellm");
    expect(litellm?.status).toBe("needs_configuration");
    expect(litellm?.credential).toBe("missing");
  });

  it("presents an unknown OpenAI-compatible endpoint as unverified", async () => {
    const report = await runScan({
      env: { OPENAI_COMPATIBLE_BASE_URL: "http://192.168.1.50:9000/v1" },
      probeHttp: async (url) =>
        url.includes("192.168.1.50:9000/v1/models")
          ? { ok: true, status: 200, url, json: { data: [{ id: "custom-model" }] } }
          : { ok: false, status: null, url, error: "ECONNREFUSED" },
    });

    const compatible = report.findings.find((finding) => finding.providerId === "compatible");
    expect(compatible?.status).toBe("compatible_unverified");
    expect(compatible?.models).toEqual(["custom-model"]);
    expect(compatible?.requirements.join(" ")).toContain("compatibility");
  });

  it("consolidates a credential and an endpoint for the same provider", async () => {
    const report = await runScan({
      env: { OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: "http://127.0.0.1:4000/v1" },
      probeHttp: async (url) =>
        url.includes("127.0.0.1:4000/v1/models")
          ? { ok: true, status: 200, url, json: { data: [{ id: "gpt-4o-mini" }] } }
          : { ok: false, status: null, url, error: "ECONNREFUSED" },
    });

    const openai = report.findings.filter((finding) => finding.providerId === "openai");
    expect(openai).toHaveLength(1);
    expect(openai[0].status).toBe("ready");
    expect(openai[0].credential).toBe("present");
    expect(openai[0].sources.length).toBeGreaterThan(1);
    expect(openai[0].warnings.join(" ")).toContain("consolidated");
  });

  it("never probes a hosted provider's public API even with a credential present", async () => {
    const probeHttp = vi.fn(async (url: string) => ({
      ok: false,
      status: null,
      url,
      error: "ECONNREFUSED",
    }));
    const report = await runScan({ env: { ANTHROPIC_API_KEY: "sk-ant-test" }, probeHttp });

    expect(probeHttp.mock.calls.every(([url]) => !String(url).includes("api.anthropic.com"))).toBe(true);
    expect(report.findings.find((finding) => finding.providerId === "anthropic")?.status).toBe(
      "detected_unverified",
    );
  });
});

describe("provider discovery — containers and runtime limits", () => {
  it("reaches a containerized service through the host gateway when Paperclip is containerized", async () => {
    const service = createProviderDiscoveryService({
      deployment: { ...deployment, bindHost: "0.0.0.0" },
      deps: makeDeps({
        env: { PAPERCLIP_CONTAINER: "1" },
        probeHttp: async (url) =>
          url.includes(":11434/api/tags")
            ? { ok: true, status: 200, url, json: { models: [{ name: "phi3" }] } }
            : { ok: false, status: null, url, error: "ECONNREFUSED" },
        listContainers: async () => ({
          available: true,
          containers: [
            {
              id: "abc",
              name: "ollama",
              image: "ollama/ollama:latest",
              state: "running",
              publishedPorts: [{ hostPort: 11434, containerPort: 11434 }],
            },
          ],
        }),
      }),
    });

    const started = service.start("company-1");
    const report = await waitForScan(service, "company-1", started.id);

    const ollama = report.findings.find(
      (finding) => finding.providerId === "ollama" && finding.endpoint?.includes("host.docker.internal"),
    );
    expect(ollama?.status).toBe("ready");
    expect(ollama?.location).toBe("host");
    expect(report.deployment.mode).toBe("container");
    expect(report.limitations.join(" ")).toContain("host filesystem");
  });

  it("reports an unavailable container runtime as a limitation, not a failure", async () => {
    const report = await runScan({ listContainers: async () => ({ available: false, containers: [], error: "docker_cli_not_found" }) });

    expect(report.status).toBe("completed");
    const stage = report.stages.find((entry) => entry.stage === "containers");
    expect(stage?.status).toBe("skipped");
    expect(report.limitations.join(" ")).toContain("Container inspection is unavailable");
  });

  it("isolates a failing stage and keeps the scan going", async () => {
    const report = await runScan({
      env: { GROQ_API_KEY: "gsk_test" },
      listConfiguredEnvKeys: async () => {
        throw new Error("database unavailable");
      },
    });

    expect(report.status).toBe("completed");
    expect(report.stages.find((entry) => entry.stage === "paperclip_config")?.status).toBe("failed");
    expect(report.findings.some((finding) => finding.providerId === "groq")).toBe(true);
  });
});

describe("provider discovery — lifecycle", () => {
  it("cancels a running scan and marks the result partial", async () => {
    const service = createProviderDiscoveryService({ deps: makeDeps(), deployment });
    const started = service.start("company-1");
    const cancelled = service.cancel("company-1", started.id);

    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.limitations.join(" ")).toContain("cancelled");
    const final = await waitForScan(service, "company-1", started.id);
    expect(final.status).toBe("cancelled");
  });

  it("scopes scans to the company that started them", async () => {
    const service = createProviderDiscoveryService({ deps: makeDeps(), deployment });
    const started = service.start("company-1");

    expect(service.get("company-2", started.id)).toBeNull();
    expect(service.cancel("company-2", started.id)).toBeNull();
    await waitForScan(service, "company-1", started.id);
  });

  it("distinguishes an empty completion from an incomplete one", async () => {
    const report = await runScan({ listContainers: async () => ({ available: false, containers: [], error: "no-docker" }) });

    expect(report.findings).toEqual([]);
    expect(report.stages.every((entry) => entry.status !== "pending")).toBe(true);
    expect(report.limitations.join(" ")).toContain("genuine empty result");
  });
});
