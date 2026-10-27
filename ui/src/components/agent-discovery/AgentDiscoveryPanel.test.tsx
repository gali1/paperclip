// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDiscoveryReport } from "@/api/agents";

const discover = vi.fn();

vi.mock("@/api/agents", () => ({
  agentsApi: {
    discover: (...args: unknown[]) => discover(...args),
  },
}));

import { AgentDiscoveryPanel } from "./AgentDiscoveryPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const report: AgentDiscoveryReport = {
  adapterType: "hermes_gateway",
  companyId: "company-1",
  generatedAt: "2026-10-27T00:00:00.000Z",
  durationMs: 42,
  deployment: {
    mode: "container",
    platform: "linux",
    containerEvidence: ["file:/.dockerenv"],
    bindHost: "0.0.0.0",
    port: 3100,
    hostGatewayCandidates: ["host.docker.internal", "172.17.0.1"],
    reachableHostAddresses: [],
    loopbackIsProcessLocalOnly: true,
    checks: [],
  },
  candidates: [
    {
      id: "cand-1",
      adapterType: "hermes_gateway",
      source: "local_api",
      transport: "http",
      label: "Hermes API — host.docker.internal:8642 (host gateway)",
      endpoint: "http://host.docker.internal:8642/",
      reachable: true,
      validated: true,
      validationStatus: "pass",
      configPatch: { apiBaseUrl: "http://host.docker.internal:8642/" },
      requiredInputs: ["apiKey"],
      capabilities: ["http"],
      warnings: [],
      evidence: [],
    },
  ],
  checks: [],
  cache: { hit: false, ageMs: 0 },
  notes: [],
  recommendedCandidateId: "cand-1",
};

describe("AgentDiscoveryPanel", () => {
  const roots: Root[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => root.unmount());
    }
    document.body.innerHTML = "";
    discover.mockReset();
  });

  function renderPanel(props: { onApply?: (candidate: typeof report.candidates[number]) => void } = {}) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => {
      root.render(
        <AgentDiscoveryPanel companyId="company-1" adapterType="hermes_gateway" {...props} />,
      );
    });
    return container;
  }

  it("probes on demand and renders reachable candidates with their warnings", async () => {
    discover.mockResolvedValue(report);
    const container = renderPanel();

    const button = [...container.querySelectorAll("button")].find((entry) =>
      entry.textContent?.trim() === "Detect",
    );
    expect(button).toBeDefined();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(discover).toHaveBeenCalledWith("company-1", "hermes_gateway", { refresh: false });
    expect(container.textContent).toContain("Hermes API — host.docker.internal:8642");
    expect(container.textContent).toContain("reachable");
    expect(container.textContent).toContain("Still required: apiKey");
    expect(container.textContent).toContain("Running in a container");
  });

  it("applies the candidate config patch only when the user asks", async () => {
    discover.mockResolvedValue(report);
    const onApply = vi.fn();
    const container = renderPanel({ onApply });

    await act(async () => {
      const detect = [...container.querySelectorAll("button")].find(
        (entry) => entry.textContent?.trim() === "Detect",
      );
      detect?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onApply).not.toHaveBeenCalled();

    const use = container.querySelector('button[aria-label^="Use "]');
    expect(use).not.toBeNull();
    await act(async () => {
      use?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onApply).toHaveBeenCalledWith(report.candidates[0]);
  });

  it("explains an empty result instead of rendering an empty list", async () => {
    discover.mockResolvedValue({
      ...report,
      candidates: [],
      notes: ["Nothing was found. Install with: pip install hermes-agent"],
    });
    const container = renderPanel();

    await act(async () => {
      const detect = [...container.querySelectorAll("button")].find(
        (entry) => entry.textContent?.trim() === "Detect",
      );
      detect?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Nothing was found.");
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });
});
