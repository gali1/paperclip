/**
 * Bounded probes used by agent discovery.
 *
 * Every probe here is deliberately small: a single `execFile` with a timeout,
 * one HTTP GET with an abort signal, or a TCP connect. Nothing recurses over
 * the filesystem, nothing shells out through `/bin/sh`, and nothing retries
 * forever.
 *
 * @module server/services/agent-discovery/probes
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { knownBinaryDirectories } from "./catalog.js";
import type { ContainerInfo, ExecutableProbeResult, HttpProbeResult } from "./types.js";

const execFileAsync = promisify(execFile);

const MAX_PROBE_OUTPUT = 4_000;
const MAX_BODY_SNIPPET = 240;

/** Resolve a binary name to an absolute path without scanning the filesystem. */
export function resolveExecutablePath(input: {
  command: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isExecutable: (candidate: string) => boolean;
  existsSync: (candidate: string) => boolean;
  homeDir?: string;
}): string | null {
  const command = input.command.trim();
  if (!command) return null;

  if (command.includes("/") || (input.platform === "win32" && command.includes("\\"))) {
    const absolute = command.startsWith("~")
      ? path.join(input.homeDir ?? os.homedir(), command.slice(1))
      : path.resolve(command);
    return input.existsSync(absolute) ? absolute : null;
  }

  const platform = input.platform ?? process.platform;
  const extensions =
    platform === "win32"
      ? (input.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  const directories = [
    ...(input.env.PATH ?? "").split(platform === "win32" ? ";" : ":"),
    ...knownBinaryDirectories(input.homeDir ?? os.homedir(), platform),
  ]
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (input.existsSync(candidate) && input.isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** Read at most `maxBytes` from the start of a file (never loads a whole binary). */
export function readFilePrefix(path: string, maxBytes = 8_192): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, "r");
    const buffer = Buffer.alloc(maxBytes);
    const bytes = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytes).toString("utf8");
  } catch {
    return "";
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

export function defaultIsExecutable(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    // Windows has no execute bit; existence of a file with a known extension is
    // the platform's notion of executable.
    if (process.platform === "win32") return true;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `<binary> --version` with a hard timeout.
 *
 * This is the only place discovery executes an unknown binary, and it is
 * limited to a version flag so identity can be checked before any agent is
 * offered to the user.
 */
export async function probeExecutableVersion(
  executablePath: string,
  args: string[] = ["--version"],
  timeoutMs = 4_000,
): Promise<ExecutableProbeResult> {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, args, {
      timeout: timeoutMs,
      maxBuffer: MAX_PROBE_OUTPUT,
      windowsHide: true,
      // No shell: the path is passed as argv[0] verbatim.
      shell: false,
    });
    const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
    return { path: executablePath, ok: true, output: output.slice(0, MAX_PROBE_OUTPUT) };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };
    const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim();
    const timedOut = err.killed === true || err.signal === "SIGTERM" || err.code === "ETIMEDOUT";
    // A non-zero exit still proves the binary exists and ran. A timeout does
    // not: some CLIs (a Python entry point, for example) need far longer than
    // any sensible discovery budget just to print a version.
    return {
      path: executablePath,
      ok: !timedOut && err.code !== "ENOENT",
      output: output.slice(0, MAX_PROBE_OUTPUT),
      error: timedOut ? "timeout" : err.code === "ENOENT" ? "not_found" : (err.message ?? "probe_failed"),
    };
  }
}

/** Strip credentials and query strings before an endpoint is logged or returned. */
export function sanitizeEndpoint(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|password/i.test(key)) url.searchParams.set(key, "«redacted»");
    }
    return url.toString();
  } catch {
    return raw.replace(/\/\/[^/@]+@/, "//");
  }
}

export async function probeHttpHealth(
  url: string,
  opts: { timeoutMs: number; headers?: Record<string, string> } = { timeoutMs: 2_500 },
): Promise<HttpProbeResult> {
  const sanitized = sanitizeEndpoint(url);
  const timeoutMs = Math.max(250, Math.min(opts.timeoutMs, 10_000));
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json, text/plain;q=0.5", ...(opts.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = (await response.text().catch(() => "")).slice(0, 4_000);
    let json: unknown = undefined;
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        json = JSON.parse(trimmed);
      } catch {
        json = undefined;
      }
    }
    return {
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      url: sanitized,
      bodySnippet: text.replace(/\s+/g, " ").trim().slice(0, MAX_BODY_SNIPPET),
      ...(json !== undefined ? { json } : {}),
    };
  } catch (error) {
    const err = error as Error & { cause?: { code?: string } };
    return {
      ok: false,
      status: null,
      url: sanitized,
      error: err.cause?.code ?? err.name ?? "probe_failed",
    };
  }
}

/**
 * List running containers via the Docker CLI, when it is installed and the
 * current user may talk to the daemon.
 *
 * Discovery never mounts or reads the Docker socket directly and never asks for
 * privileged access: an unavailable CLI simply disables this stage.
 */
export async function listDockerContainers(
  timeoutMs = 3_000,
): Promise<{ available: boolean; containers: ContainerInfo[]; error?: string }> {
  try {
    const { stdout } = await execFileAsync("docker", ["ps", "--no-trunc", "--format", "{{json .}}"], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      shell: false,
    });
    const containers: ContainerInfo[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const raw = JSON.parse(trimmed) as Record<string, unknown>;
        const portsRaw = String(raw.Ports ?? "");
        const publishedPorts = [...portsRaw.matchAll(/(?:[\d.]+|\[[^\]]+\]):(\d+)->(\d+)\/(?:tcp|udp)/g)]
          .map((match) => ({ hostPort: Number(match[1]), containerPort: Number(match[2]) }))
          .filter((entry) => Number.isFinite(entry.hostPort) && Number.isFinite(entry.containerPort));
        containers.push({
          id: String(raw.ID ?? ""),
          name: String(raw.Names ?? ""),
          image: String(raw.Image ?? ""),
          state: String(raw.State ?? ""),
          publishedPorts,
        });
      } catch {
        // Ignore malformed lines; the CLI output format is not ours to trust.
      }
    }
    return { available: true, containers };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return {
      available: false,
      containers: [],
      error: err.code === "ENOENT" ? "docker_cli_not_found" : (err.message ?? "docker_unavailable"),
    };
  }
}

export function defaultHomeDir(): string {
  return os.homedir();
}

/** Single TCP connect with a hard timeout; used for host-gateway reachability. */
export async function probeTcpPort(host: string, port: number, timeoutMs = 1_500): Promise<boolean> {
  const net = await import("node:net");
  return await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(Math.max(100, Math.min(timeoutMs, 5_000)));
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}
