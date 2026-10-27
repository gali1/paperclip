// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();

vi.mock("@/api/client", () => ({ api: { get: (...args: unknown[]) => get(...args), post: (...args: unknown[]) => post(...args) } }));

import { AutoProviderDiscovery } from "./AutoProviderDiscovery";
import type { ProviderScan } from "@/api/provider-discovery";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const completedScan: ProviderScan = {
  id: "scan-1",
  companyId: "company-1",
  status: "completed",
  stage: null,
  stages: [
    { stage: "environment", status: "completed", detail: "2 credential variable groups" },
    { stage: "local_services", status: "completed", detail: "5 documented ports, 1 answering" },
    { stage: "containers", status: "skipped", detail: "docker_cli_not_found" },
  ],
  deployment: {
    mode: "container",
    hostGatewayCandidates: ["host.docker.internal"],
    loopbackIsProcessLocalOnly: true,
    platform: "linux",
  },
  findings: [
    {
      id: "f1",
      providerId: "ollama",
      label: "Ollama",
      category: "local",
      status: "ready",
      sources: [{ kind: "local_service", detail: "Documented port 11434" }],
      endpoint: "http://host.docker.internal:11434/",
      location: "host",
      credential: "not_required",
      credentialEnvKeys: [],
      models: ["llama3.2:3b", "qwen2.5:7b"],
      requirements: [],
      warnings: [],
      confidence: "high",
      setup: { baseUrl: "http://host.docker.internal:11434", defaultModel: "llama3.2:3b" },
    },
    {
      id: "f2",
      providerId: "openai",
      label: "OpenAI",
      category: "hosted",
      status: "detected_unverified",
      sources: [{ kind: "environment", detail: "Credential present in OPENAI_API_KEY" }],
      location: "unknown",
      credential: "present",
      credentialEnvKeys: ["OPENAI_API_KEY"],
      models: [],
      requirements: ["No non-billable validation was attempted for a hosted provider."],
      warnings: [],
      confidence: "medium",
      setup: { providerKey: "openai" },
    },
  ],
  warnings: [],
  limitations: ["Container inspection is unavailable (Docker CLI missing or not permitted)."],
  startedAt: "2026-10-27T00:00:00.000Z",
  finishedAt: "2026-10-27T00:00:05.000Z",
};

describe("AutoProviderDiscovery", () => {
  const roots: Root[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.innerHTML = "";
    get.mockReset();
    post.mockReset();
  });

  function render(props: { onSelect?: (selection: unknown) => void } = {}) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => {
      root.render(
        <AutoProviderDiscovery
          companyId="company-1"
          providerKeys={{ openai: "OPENAI_API_KEY" }}
          onSelect={props.onSelect ?? (() => undefined)}
        />,
      );
    });
    return container;
  }

  async function startScan(container: HTMLElement) {
    post.mockResolvedValue(completedScan);
    const button = [...container.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("AUTO scan"),
    );
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("runs an AUTO scan, shows progress stages and the provider inventory", async () => {
    const container = render();
    await startScan(container);

    expect(post).toHaveBeenCalledWith("/companies/company-1/provider-discovery/scans", {});
    expect(container.textContent).toContain("Scan complete — 2 provider(s)");
    expect(container.textContent).toContain("local services");
    expect(container.textContent).toContain("Ollama");
    expect(container.textContent).toContain("Ready");
    expect(container.textContent).toContain("key in OPENAI_API_KEY");
    expect(container.textContent).toContain("Detected, not validated");
    expect(container.textContent).toContain("via host.docker.internal");
  });

  it("lets the user adopt a discovered provider without receiving a credential", async () => {
    const onSelect = vi.fn();
    const container = render({ onSelect });
    await startScan(container);

    const use = container.querySelector('button[aria-label="Use Ollama"]');
    expect(use).not.toBeNull();
    await act(async () => {
      use?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSelect).toHaveBeenCalledWith({
      providerId: "ollama",
      providerKey: undefined,
      defaultModel: "llama3.2:3b",
      baseUrl: "http://host.docker.internal:11434",
      credentialPresent: false,
    });
    expect(JSON.stringify(onSelect.mock.calls)).not.toMatch(/sk-|api[_-]?key=/i);
  });

  it("filters to providers that still need setup", async () => {
    const container = render();
    await startScan(container);

    const needs = [...container.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("Needs setup"),
    );
    await act(async () => {
      needs?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).not.toContain("Ollama");
    expect(container.textContent).toContain("OpenAI");
  });

  it("surfaces scan limitations instead of claiming a complete host scan", async () => {
    const container = render();
    await startScan(container);

    expect(container.textContent).toContain("Scan notes");
    expect(container.textContent).toContain("Docker CLI missing");
  });
});
