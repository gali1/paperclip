import { createHash } from "node:crypto";
import os from "node:os";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import {
  asString,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { isValidOpenCodeModelId } from "../index.js";
import { buildOpenCodeModelLabel } from "@paperclipai/adapter-utils/model-labels";

const MODELS_CACHE_TTL_MS = 60_000;
const MODELS_DISCOVERY_TIMEOUT_MS = 20_000;
// `opencode models` is a lightweight metadata call, but on a shared ollama
// daemon it can queue behind an in-flight `opencode run` generation on the
// same host and either time out or fail with an opaque error. Retry a few
// times with backoff before surfacing a hard failure (SAG-6326/SAG-6336).
const MODELS_DISCOVERY_RETRY_DELAYS_MS = [2_000, 4_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveOpenCodeCommand(input: unknown): string {
  const envOverride =
    typeof process.env.PAPERCLIP_OPENCODE_COMMAND === "string" &&
    process.env.PAPERCLIP_OPENCODE_COMMAND.trim().length > 0
      ? process.env.PAPERCLIP_OPENCODE_COMMAND.trim()
      : "opencode";
  return asString(input, envOverride);
}

const discoveryCache = new Map<
  string,
  { expiresAt: number; models: AdapterModel[] }
>();
const VOLATILE_ENV_KEY_PREFIXES = ["PAPERCLIP_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set([
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "TERM_SESSION_ID",
  "HOME",
]);

export function requireOpenCodeModelId(input: unknown): string {
  const model = asString(input, "").trim();
  if (!isValidOpenCodeModelId(model)) {
    throw new Error(
      "OpenCode requires `adapterConfig.model` in provider/model format.",
    );
  }
  return model;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function sortModels(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

export function parseOpenCodeModelsOutput(stdout: string): AdapterModel[] {
  const parsed: AdapterModel[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const firstToken = line.split(/\s+/)[0]?.trim() ?? "";
    if (!firstToken.includes("/")) continue;
    const provider = firstToken.slice(0, firstToken.indexOf("/")).trim();
    const model = firstToken.slice(firstToken.indexOf("/") + 1).trim();
    if (!provider || !model) continue;
    parsed.push({ id: `${provider}/${model}`, label: `${provider}/${model}` });
  }
  return dedupeModels(parsed);
}

function normalizeEnv(input: unknown): Record<string, string> {
  const envInput =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envInput)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function isVolatileEnvKey(key: string): boolean {
  if (VOLATILE_ENV_KEY_EXACT.has(key)) return true;
  return VOLATILE_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function discoveryCacheKey(
  command: string,
  cwd: string,
  env: Record<string, string>,
) {
  const envKey = Object.entries(env)
    .filter(([key]) => !isVolatileEnvKey(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${hashValue(value)}`)
    .join("\n");
  return `${command}\n${cwd}\n${envKey}`;
}

function pruneExpiredDiscoveryCache(now: number) {
  for (const [key, value] of discoveryCache.entries()) {
    if (value.expiresAt <= now) discoveryCache.delete(key);
  }
}

export async function discoverOpenCodeModels(
  input: {
    command?: unknown;
    cwd?: unknown;
    env?: unknown;
    refresh?: boolean;
  } = {},
): Promise<AdapterModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  // Ensure HOME points to the actual running user's home directory.
  // When the server is started via `runuser -u <user>`, HOME may still
  // reflect the parent process (e.g. /root), causing OpenCode to miss
  // provider auth credentials stored under the target user's home.
  let resolvedHome: string | undefined;
  try {
    resolvedHome = os.userInfo().homedir || undefined;
  } catch {
    // os.userInfo() throws a SystemError when the current UID has no
    // /etc/passwd entry (e.g. `docker run --user 1234` with a minimal
    // image). Fall back to process.env.HOME.
  }
  // Prevent OpenCode from writing an opencode.json into the working directory.
  const runtimeEnv = normalizeEnv(
    ensurePathInEnv({
      ...process.env,
      ...env,
      ...(resolvedHome ? { HOME: resolvedHome } : {}),
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    }),
  );

  const maxAttempts = MODELS_DISCOVERY_RETRY_DELAYS_MS.length + 1;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await runChildProcess(
      `opencode-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command,
      ["models", ...(input.refresh ? ["--refresh"] : [])],
      {
        cwd,
        env: runtimeEnv,
        timeoutSec: MODELS_DISCOVERY_TIMEOUT_MS / 1000,
        graceSec: 3,
        onLog: async () => {},
      },
    );

    if (result.timedOut) {
      lastError = new Error(
        `\`opencode models\` timed out after ${MODELS_DISCOVERY_TIMEOUT_MS / 1000}s.`,
      );
    } else if ((result.exitCode ?? 1) !== 0) {
      const detail =
        firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
      lastError = new Error(
        detail
          ? `\`opencode models\` failed: ${detail}`
          : "`opencode models` failed.",
      );
    } else {
      return sortModels(parseOpenCodeModelsOutput(result.stdout));
    }

    const delayMs = MODELS_DISCOVERY_RETRY_DELAYS_MS[attempt - 1];
    if (delayMs === undefined) break;
    await sleep(delayMs);
  }

  throw lastError ?? new Error("`opencode models` failed.");
}

export async function discoverOpenCodeModelsCached(
  input: {
    command?: unknown;
    cwd?: unknown;
    env?: unknown;
  } = {},
): Promise<AdapterModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverOpenCodeModels({ command, cwd, env });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

async function refreshOpenCodeModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AdapterModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  // OpenCode 1.18.17 uses `models --refresh` only to update its on-disk
  // models.dev cache. Its stdout is a confirmation message, not the refreshed
  // catalog, so enumerate once more after the refresh under the exact same
  // command/cwd/env before deciding whether the configured model exists.
  await discoverOpenCodeModels({
    command,
    cwd,
    env,
    refresh: true,
  });
  const models = await discoverOpenCodeModels({ command, cwd, env });
  if (models.length > 0) {
    discoveryCache.set(discoveryCacheKey(command, cwd, env), {
      expiresAt: Date.now() + MODELS_CACHE_TTL_MS,
      models,
    });
  }
  return models;
}

export function isTruthyEnvFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

export async function ensureOpenCodeModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AdapterModel[]> {
  const model = requireOpenCodeModelId(input.model);

  // When the caller opts into OPENCODE_ALLOW_ALL_MODELS, OpenCode accepts any
  // provider/model at run time (e.g. gateway-routed models that never appear in
  // `opencode models` output). Honour that by skipping the availability probe;
  // we still enforce the provider/model format above and do not second-guess
  // the configured model. Prefer the explicit run env, then the process env.
  const env = normalizeEnv(input.env);
  if (
    isTruthyEnvFlag(
      env.OPENCODE_ALLOW_ALL_MODELS ?? process.env.OPENCODE_ALLOW_ALL_MODELS,
    )
  ) {
    return [{ id: model, label: model }];
  }

  let models: AdapterModel[];
  try {
    models = await discoverOpenCodeModelsCached({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
    });
  } catch (err) {
    // The availability probe is a best-effort pre-flight guard, not a gate. If
    // `opencode models` itself cannot run — a transient CLI error, a timeout, a
    // provider hiccup — do NOT abort the run. The real invocation is
    // authoritative, so a probe that can't execute must never be fatal.
    // (Previously this threw and crashed runs mid-flight, discarding the agent's
    // completed work and its terminal disposition, which then reopened the issue.)
    console.warn(
      `[opencode-local] Model availability probe could not run for "${model}" (${
        err instanceof Error ? err.message : String(err)
      }); proceeding with the configured model.`,
    );
    return [{ id: model, label: model }];
  }

  if (models.length === 0) {
    // The probe ran but returned nothing (e.g. a transient provider-auth blip).
    // Same reasoning as above: warn, don't block the run.
    console.warn(
      `[opencode-local] \`opencode models\` returned no models; proceeding with the configured model "${model}".`,
    );
    return [{ id: model, label: model }];
  }

  if (!models.some((entry) => entry.id === model)) {
    // `opencode models` reads a persistent models.dev cache. Long-lived runner
    // hosts can therefore report a stale non-empty catalog even while the
    // configured provider serves the model. Refresh once before treating a
    // cached miss as authoritative; a successful refresh that still omits the
    // model retains the strict availability rejection below.
    try {
      const refreshedModels = await refreshOpenCodeModelsCached({
        command: input.command,
        cwd: input.cwd,
        env: input.env,
      });
      if (refreshedModels.some((entry) => entry.id === model)) {
        return refreshedModels;
      }
      if (refreshedModels.length > 0) models = refreshedModels;
    } catch (err) {
      console.warn(
        `[opencode-local] Model availability refresh failed for "${model}" (${
          err instanceof Error ? err.message : String(err)
        }); preserving the cached availability rejection.`,
      );
    }

    const sample = models
      .slice(0, 12)
      .map((entry) => entry.id)
      .join(", ");
    throw new Error(
      `Configured OpenCode model is unavailable: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }

  return models;
}

export async function listOpenCodeModels(): Promise<AdapterModel[]> {
  // 1. The CLI is the authority for which model ids `opencode run --model`
  //    actually accepts, so prefer its catalog and only decorate the labels.
  try {
    const cliModels = await discoverOpenCodeModelsCached();
    if (cliModels.length > 0) return sortModelsByLabel(decorateOpenCodeModels(cliModels));
  } catch {
    // Fall through to the provider endpoints below.
  }

  // 2. OpenCode's OpenAI-compatible discovery endpoints (Zen, Zen Go,
  //    Interface/Inference) — used when the CLI is unavailable or empty. The
  //    tier prefix maps to the same `provider/model` ids the CLI emits.
  try {
    const httpModels = await discoverOpenCodeHttpModels();
    if (httpModels.length > 0) return sortModelsByLabel(httpModels);
  } catch {
    // Fall through: discovery failed.
  }

  // No hardcoded fallback. Model catalogs are always pulled from the provider
  // (the OpenCode CLI or its HTTP endpoints); an empty result is surfaced as a
  // discovery failure rather than a stale seed list that may name dead models.
  return [];
}

/** The tier/plan a canonical `provider/model` id belongs to. */
export function tierForOpenCodeModel(id: string): string {
  if (id.startsWith("opencode-go/")) return "OpenCode Zen Go";
  if (id.startsWith("opencode/")) return "OpenCode Zen";
  if (id.startsWith("anthropic/")) return "Anthropic (subscription)";
  if (id.startsWith("github-copilot/")) return "GitHub Copilot (subscription)";
  const slash = id.indexOf("/");
  return slash > 0 ? `${id.slice(0, slash)} (subscription)` : "OpenCode";
}

/** Human display label for a canonical id (never changes the id itself). */
export function labelOpenCodeModel(id: string): string {
  const slash = id.indexOf("/");
  const modelPart = slash >= 0 ? id.slice(slash + 1) : id;
  return buildOpenCodeModelLabel(tierForOpenCodeModel(id), modelPart);
}

function decorateOpenCodeModels(models: AdapterModel[]): AdapterModel[] {
  return models.map((model) => ({ id: model.id, label: labelOpenCodeModel(model.id) }));
}

/** Group the picker by tier, then alphabetically, using the display label. */
function sortModelsByLabel(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) =>
    a.label.localeCompare(b.label, "en", { numeric: true, sensitivity: "base" }),
  );
}

/**
 * OpenCode's unified, OpenAI-compatible model-discovery endpoints. One query
 * covers every downstream provider (Anthropic, OpenAI, Google, xAI, DeepSeek,
 * Kimi, Qwen, GLM, MiniMax, ...), so we never enumerate providers individually.
 */
export const OPENCODE_MODEL_ENDPOINTS = [
  { tier: "OpenCode Zen", providerPrefix: "opencode", url: "https://opencode.ai/zen/v1/models" },
  { tier: "OpenCode Zen Go", providerPrefix: "opencode-go", url: "https://opencode.ai/zen/go/v1/models" },
  { tier: "OpenCode Interface", providerPrefix: "opencode", url: "https://opencode.ai/inference/v1/models" },
] as const;

const OPENCODE_HTTP_DISCOVERY_TIMEOUT_MS = 8_000;

async function fetchOpenCodeTierModelIds(url: string, apiKey: string): Promise<string[]> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(OPENCODE_HTTP_DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
  return (body.data ?? [])
    .map((entry) => (typeof entry?.id === "string" ? entry.id.trim() : ""))
    .filter((id) => id.length > 0);
}

/**
 * Discover models straight from the OpenCode HTTP tiers. Returns canonical
 * `provider/model` ids with normalized, tier-labelled display names. A tier
 * that fails to answer is skipped rather than failing the whole call.
 */
export async function discoverOpenCodeHttpModels(
  env: Record<string, string> = {},
): Promise<AdapterModel[]> {
  const apiKey = (env.OPENCODE_API_KEY ?? process.env.OPENCODE_API_KEY ?? "").trim();
  const byId = new Map<string, AdapterModel>();
  for (const tier of OPENCODE_MODEL_ENDPOINTS) {
    let ids: string[];
    try {
      ids = await fetchOpenCodeTierModelIds(tier.url, apiKey);
    } catch {
      continue;
    }
    for (const raw of ids) {
      const id = `${tier.providerPrefix}/${raw}`;
      if (byId.has(id)) continue;
      byId.set(id, { id, label: buildOpenCodeModelLabel(tier.tier, raw) });
    }
  }
  return [...byId.values()];
}

export function resetOpenCodeModelsCacheForTests() {
  discoveryCache.clear();
}
