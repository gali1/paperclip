/**
 * Per-adapter discovery hints.
 *
 * Adding support for a new agent is a single entry here plus its adapter
 * package: no discovery code changes. Every hint is a *candidate*, never a
 * conclusion — the probe stage must still confirm identity and reachability.
 *
 * Facts encoded here are taken from the adapter packages and their docs:
 * - commands mirror each adapter's `config.command` default,
 * - service ports/paths mirror the vendor's documented API server,
 * - `identityPattern` is matched against `<command> --version` output.
 *
 * @module server/services/agent-discovery/catalog
 */

import type { DiscoveryTransport } from "./types.js";

export interface LocalServiceHint {
  /** Human label for the discovered endpoint, e.g. "Hermes API server". */
  name: string;
  port: number;
  path: string;
  scheme?: "http" | "https";
  /** Response must parse as JSON before the endpoint is considered valid. */
  expectJson?: boolean;
  /** Optional substring test against the response body. */
  expectBodyIncludes?: string;
}

export interface AdapterDiscoveryDescriptor {
  adapterType: string;
  label: string;
  transport: DiscoveryTransport;
  /** Binary names to look for on PATH and in well-known install dirs. */
  commands: string[];
  /** Regex the `--version` output must match to prove binary identity. */
  identityPattern?: RegExp;
  versionArgs?: string[];
  installHint?: string;
  /** Adapter config key that carries the executable path/command. */
  commandConfigKey?: string;
  /** Documented local API servers this agent can expose. */
  localServices?: LocalServiceHint[];
  /** Adapter config key that carries an API/WebSocket base URL. */
  endpointConfigKey?: string;
  /** Adapter config key that carries a credential (never returned to the client). */
  credentialConfigKey?: string;
  /** Image-name fragments that identify a container running this agent. */
  containerImageHints?: string[];
  capabilities?: string[];
}

const DESCRIPTORS: AdapterDiscoveryDescriptor[] = [
  {
    adapterType: "hermes_local",
    label: "Hermes Agent (CLI)",
    transport: "cli",
    commands: ["hermes"],
    identityPattern: /hermes/i,
    installHint: "Install with: pip install hermes-agent (or the setup-hermes.sh installer).",
    commandConfigKey: "command",
    capabilities: ["cli", "sessions", "skills", "memory", "mcp"],
    containerImageHints: ["hermes"],
  },
  {
    adapterType: "hermes_gateway",
    label: "Hermes API server",
    transport: "http",
    commands: [],
    localServices: [
      { name: "Hermes API", port: 8642, path: "/api/health", expectJson: true },
      { name: "Hermes dashboard", port: 9119, path: "/api/health", expectJson: true },
    ],
    endpointConfigKey: "apiBaseUrl",
    credentialConfigKey: "apiKey",
    capabilities: ["http", "streaming", "sessions", "skills", "mcp"],
    containerImageHints: ["hermes"],
  },
  {
    adapterType: "opencode_local",
    label: "OpenCode (CLI)",
    transport: "cli",
    commands: ["opencode"],
    identityPattern: /opencode/i,
    installHint: "Install with: npm i -g opencode-ai (or curl -fsSL https://opencode.ai/install | bash).",
    commandConfigKey: "command",
    localServices: [{ name: "OpenCode server", port: 4096, path: "/global/health", expectJson: true }],
    capabilities: ["cli", "acp", "sessions", "skills", "mcp"],
    containerImageHints: ["opencode"],
  },
  {
    adapterType: "openclaw_gateway",
    label: "OpenClaw Gateway",
    transport: "websocket",
    commands: ["openclaw"],
    identityPattern: /openclaw/i,
    installHint: "Install OpenClaw, then run: openclaw gateway --port 18789",
    endpointConfigKey: "url",
    credentialConfigKey: "authToken",
    localServices: [{ name: "OpenClaw gateway", port: 18789, path: "/", expectJson: false }],
    capabilities: ["websocket", "sessions"],
    containerImageHints: ["openclaw"],
  },
  {
    adapterType: "claude_local",
    label: "Claude Code",
    transport: "cli",
    commands: ["claude"],
    identityPattern: /claude/i,
    installHint: "Install with: npm i -g @anthropic-ai/claude-code",
    commandConfigKey: "command",
    capabilities: ["cli", "acp", "sessions", "skills", "mcp"],
    containerImageHints: ["claude"],
  },
  {
    adapterType: "codex_local",
    label: "Codex CLI",
    transport: "cli",
    commands: ["codex"],
    identityPattern: /codex/i,
    installHint: "Install with: npm i -g @openai/codex",
    commandConfigKey: "command",
    capabilities: ["cli", "acp", "sessions", "mcp"],
    containerImageHints: ["codex"],
  },
  {
    adapterType: "gemini_local",
    label: "Gemini CLI",
    transport: "cli",
    commands: ["gemini"],
    identityPattern: /gemini/i,
    installHint: "Install with: npm i -g @google/gemini-cli",
    commandConfigKey: "command",
    capabilities: ["cli", "sessions"],
    containerImageHints: ["gemini"],
  },
  {
    adapterType: "kimi_local",
    label: "Kimi CLI",
    transport: "cli",
    commands: ["kimi"],
    identityPattern: /kimi/i,
    commandConfigKey: "command",
    capabilities: ["cli", "sessions"],
    containerImageHints: ["kimi"],
  },
  {
    adapterType: "pi_local",
    label: "Pi CLI",
    transport: "cli",
    commands: ["pi"],
    identityPattern: /\bpi\b/i,
    commandConfigKey: "command",
    capabilities: ["cli", "sessions"],
    containerImageHints: ["pi-agent"],
  },
  {
    adapterType: "grok_local",
    label: "Grok CLI",
    transport: "cli",
    commands: ["grok"],
    identityPattern: /grok/i,
    commandConfigKey: "command",
    capabilities: ["cli", "sessions"],
    containerImageHints: ["grok"],
  },
  {
    adapterType: "cursor",
    label: "Cursor Agent CLI",
    transport: "cli",
    commands: ["cursor-agent", "cursor"],
    identityPattern: /cursor/i,
    commandConfigKey: "command",
    capabilities: ["cli", "sessions"],
    containerImageHints: ["cursor"],
  },
];

const BY_TYPE = new Map(DESCRIPTORS.map((descriptor) => [descriptor.adapterType, descriptor]));

/**
 * Look up the descriptor for an adapter type.
 *
 * Unknown (for example third-party plugin) adapters get a minimal descriptor so
 * stage 1 (existing configuration) still works; they simply have no local
 * binary/service hints to probe.
 */
export function getDiscoveryDescriptor(adapterType: string): AdapterDiscoveryDescriptor {
  const known = BY_TYPE.get(adapterType);
  if (known) return known;
  return {
    adapterType,
    label: adapterType,
    transport: "cli",
    commands: [],
    capabilities: [],
  };
}

export function listDiscoveryDescriptors(): AdapterDiscoveryDescriptor[] {
  return [...DESCRIPTORS];
}

/** Well-known user-level binary directories, checked in addition to PATH. */
export function knownBinaryDirectories(home: string, platform: NodeJS.Platform): string[] {
  const dirs = [
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    `${home}/.npm-global/bin`,
    `${home}/bin`,
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  if (platform === "darwin") {
    dirs.unshift("/opt/homebrew/bin", "/opt/homebrew/sbin");
  }
  if (platform === "win32") {
    dirs.push(`${home}/AppData/Roaming/npm`, `${home}/AppData/Local/Programs`);
  }
  return dirs;
}
