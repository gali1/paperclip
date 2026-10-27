import { describe, expect, it } from "vitest";
import { resolveExecutablePath, sanitizeEndpoint } from "./probes.js";

function fakeFs(existing: string[]) {
  return {
    existsSync: (path: string) => existing.includes(path),
    isExecutable: () => true,
  };
}

describe("resolveExecutablePath", () => {
  it("resolves a bare command from PATH without scanning directories", () => {
    const fs = fakeFs(["/opt/bin/hermes"]);
    expect(
      resolveExecutablePath({
        command: "hermes",
        env: { PATH: "/usr/bin:/opt/bin" },
        platform: "linux",
        ...fs,
        homeDir: "/home/tester",
      }),
    ).toBe("/opt/bin/hermes");
  });

  it("falls back to well-known user install directories", () => {
    const fs = fakeFs(["/home/tester/.local/bin/hermes"]);
    expect(
      resolveExecutablePath({
        command: "hermes",
        env: { PATH: "/usr/bin" },
        platform: "linux",
        ...fs,
        homeDir: "/home/tester",
      }),
    ).toBe("/home/tester/.local/bin/hermes");
  });

  it("accepts an absolute path only when it exists", () => {
    const fs = fakeFs(["/srv/tools/opencode"]);
    expect(
      resolveExecutablePath({
        command: "/srv/tools/opencode",
        env: {},
        platform: "linux",
        ...fs,
        homeDir: "/home/tester",
      }),
    ).toBe("/srv/tools/opencode");
    expect(
      resolveExecutablePath({
        command: "/srv/tools/missing",
        env: {},
        platform: "linux",
        ...fs,
        homeDir: "/home/tester",
      }),
    ).toBeNull();
  });

  it("returns null for an empty command", () => {
    expect(
      resolveExecutablePath({
        command: "  ",
        env: { PATH: "/usr/bin" },
        platform: "linux",
        ...fakeFs([]),
        homeDir: "/home/tester",
      }),
    ).toBeNull();
  });
});

describe("sanitizeEndpoint", () => {
  it("strips credentials embedded in the URL", () => {
    expect(sanitizeEndpoint("http://user:password@example.test:8642/api")).toBe(
      "http://example.test:8642/api",
    );
  });

  it("redacts secret-looking query parameters", () => {
    const sanitized = sanitizeEndpoint("https://example.test/run?api_key=abc123&mode=fast");
    expect(sanitized).not.toContain("abc123");
    expect(sanitized).toContain("mode=fast");
  });

  it("leaves non-URL strings usable", () => {
    expect(sanitizeEndpoint("not a url")).toBe("not a url");
  });
});
