import { describe, expect, it } from "vitest";
import {
  buildDeploymentContext,
  collectReachableHostAddresses,
  detectContainer,
  isLoopbackHost,
  isWildcardBind,
  readDefaultGatewayIpv4,
  resolveHostGatewayCandidates,
} from "./deployment.js";

const ROUTE_TABLE = [
  "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
  "eth0\t00000000\t0102A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0",
  "eth0\t0002A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0",
].join("\n");

function readerFrom(files: Record<string, string>) {
  return (path: string) => files[path] ?? "";
}

describe("detectContainer", () => {
  it("treats an explicit env marker as container evidence", () => {
    const result = detectContainer({ env: { PAPERCLIP_CONTAINER: "1" }, existsSync: () => false, readFileSync: () => "" });
    expect(result.inContainer).toBe(true);
    expect(result.evidence).toContain("env:PAPERCLIP_CONTAINER");
  });

  it("detects Docker from /.dockerenv", () => {
    const result = detectContainer({
      env: {},
      existsSync: (path) => path === "/.dockerenv",
      readFileSync: () => "",
    });
    expect(result.inContainer).toBe(true);
    expect(result.runtime).toBe("docker");
  });

  it("detects Kubernetes from the pid-1 cgroup", () => {
    const result = detectContainer({
      env: {},
      existsSync: () => false,
      readFileSync: () => "0::/kubepods/burstable/podabc/def",
    });
    expect(result.inContainer).toBe(true);
    expect(result.runtime).toBe("kubernetes");
  });

  it("reports a plain host as native", () => {
    const result = detectContainer({
      env: {},
      existsSync: () => false,
      readFileSync: () => "0::/user.slice/user-1000.slice/session-1.scope",
    });
    expect(result.inContainer).toBe(false);
    expect(result.evidence).toEqual([]);
  });
});

describe("readDefaultGatewayIpv4", () => {
  it("decodes the little-endian gateway field", () => {
    expect(readDefaultGatewayIpv4(readerFrom({ "/proc/net/route": ROUTE_TABLE }))).toBe("192.168.2.1");
  });

  it("returns null when there is no default route", () => {
    expect(
      readDefaultGatewayIpv4(
        readerFrom({
          "/proc/net/route": "Iface\tDestination\tGateway\neth0\t0002A8C0\t00000000",
        }),
      ),
    ).toBeNull();
  });
});

describe("resolveHostGatewayCandidates", () => {
  it("orders explicit overrides before aliases and the raw gateway", () => {
    const candidates = resolveHostGatewayCandidates({
      env: { PAPERCLIP_HOST_GATEWAY: "10.9.9.9" },
      readFileSync: readerFrom({ "/proc/net/route": ROUTE_TABLE }),
    });
    expect(candidates[0]).toBe("10.9.9.9");
    expect(candidates).toContain("host.docker.internal");
    expect(candidates).toContain("192.168.2.1");
    expect(candidates.indexOf("host.docker.internal")).toBeLessThan(
      candidates.indexOf("192.168.2.1"),
    );
  });

  it("deduplicates repeated values", () => {
    const candidates = resolveHostGatewayCandidates({
      env: { PAPERCLIP_HOST_GATEWAY: "host.docker.internal" },
      readFileSync: () => "",
    });
    expect(candidates.filter((entry) => entry === "host.docker.internal")).toHaveLength(1);
  });
});

describe("buildDeploymentContext", () => {
  it("flags a loopback bind inside a container as an error", () => {
    const context = buildDeploymentContext({
      env: { PAPERCLIP_CONTAINER: "1" },
      platform: "linux",
      existsSync: () => false,
      readFileSync: readerFrom({ "/proc/net/route": ROUTE_TABLE }),
      networkInterfaces: {},
      bindHost: "127.0.0.1",
      port: 3100,
      deploymentMode: "authenticated",
      deploymentExposure: "private",
    });
    expect(context.mode).toBe("container");
    expect(context.loopbackIsProcessLocalOnly).toBe(true);
    expect(context.hostGatewayCandidates.length).toBeGreaterThan(0);
    expect(context.checks.map((check) => check.code)).toContain("deployment_container_loopback_bind");
  });

  it("has no host-gateway candidates on a native host", () => {
    const context = buildDeploymentContext({
      env: {},
      platform: "linux",
      existsSync: () => false,
      readFileSync: () => "",
      networkInterfaces: {},
      bindHost: "0.0.0.0",
      port: 3100,
      deploymentMode: "local_trusted",
    });
    expect(context.mode).toBe("native");
    expect(context.hostGatewayCandidates).toEqual([]);
    expect(context.checks.map((check) => check.code)).toContain(
      "deployment_unauthenticated_exposure",
    );
  });

  it("warns when the public URL is loopback but exposure is public", () => {
    const context = buildDeploymentContext({
      env: {},
      platform: "linux",
      existsSync: () => false,
      readFileSync: () => "",
      networkInterfaces: {},
      bindHost: "0.0.0.0",
      port: 3100,
      publicUrl: "http://localhost:3100",
      deploymentMode: "authenticated",
      deploymentExposure: "public",
    });
    expect(context.checks.map((check) => check.code)).toContain("deployment_public_url_loopback");
  });
});

describe("host helpers", () => {
  it("recognizes loopback and wildcard values", () => {
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("192.168.1.4")).toBe(false);
    expect(isWildcardBind("0.0.0.0")).toBe(true);
    expect(isWildcardBind("::")).toBe(true);
  });

  it("collects non-internal IPv4 addresses only", () => {
    expect(
      collectReachableHostAddresses({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        eth0: [
          { address: "192.168.1.10", family: "IPv4", internal: false },
          { address: "fe80::1", family: "IPv6", internal: false },
        ],
        docker0: [{ address: "172.17.0.1", family: 4, internal: false }],
      }),
    ).toEqual(["192.168.1.10", "172.17.0.1"]);
  });
});
