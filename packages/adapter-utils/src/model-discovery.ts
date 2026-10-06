import type { AdapterModel } from "./types.js";
import { normalizeModelDisplayName } from "./model-labels.js";

/**
 * Provider-native model discovery.
 *
 * Model catalogs are always pulled live from each provider's own models
 * endpoint — never shipped as a hardcoded list. Each spec knows where to ask,
 * how to authenticate, how to read the response, and how to turn a raw id into
 * the id the harness actually accepts.
 *
 * A discovery that fails (no key, network error, non-2xx, malformed body)
 * returns an empty list rather than a stale fallback, so the picker reflects
 * real availability instead of a catalog that may name dead models.
 */

interface ProviderModelDiscovery {
  /** Env vars that may hold the credential; the first non-empty one wins. */
  envKeys: string[];
  url: string;
  headers: (apiKey: string) => Record<string, string>;
  /** Pull raw model ids out of the provider's response body. */
  extract: (body: unknown) => string[];
  /** Map a raw id to the id the harness expects. Defaults to identity. */
  toId?: (raw: string) => string;
  /** Optional fixed prefix for the display label (e.g. "Gemini"). */
  labelPrefix?: string;
}

const DISCOVERY_TIMEOUT_MS = 8_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function openAiCompatibleExtract(body: unknown): string[] {
  const data = asRecord(body)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => {
      const id = asRecord(entry)?.id;
      return typeof id === "string" ? id.trim() : "";
    })
    .filter((id) => id.length > 0);
}

/** OpenAI-compatible `/v1/models` discovery (OpenAI, xAI, Moonshot, ...). */
function openAiCompatible(url: string): Pick<ProviderModelDiscovery, "url" | "headers" | "extract"> {
  return {
    url,
    headers: (apiKey) => ({ authorization: `Bearer ${apiKey}`, "content-type": "application/json" }),
    extract: openAiCompatibleExtract,
  };
}

export const PROVIDER_MODEL_DISCOVERY: Record<string, ProviderModelDiscovery> = {
  codex_local: {
    envKeys: ["OPENAI_API_KEY"],
    ...openAiCompatible("https://api.openai.com/v1/models"),
  },
  grok_local: {
    envKeys: ["XAI_API_KEY"],
    ...openAiCompatible("https://api.x.ai/v1/models"),
  },
  kimi_local: {
    envKeys: ["KIMI_MODEL_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY"],
    ...openAiCompatible("https://api.moonshot.ai/v1/models"),
  },
  gemini_local: {
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
    headers: (apiKey) => ({ "x-goog-api-key": apiKey, "content-type": "application/json" }),
    extract: (body) => {
      const models = asRecord(body)?.models;
      if (!Array.isArray(models)) return [];
      return models
        .filter((entry) => {
          const methods = asRecord(entry)?.supportedGenerationMethods;
          // Keep only models a coding agent can actually call.
          return !Array.isArray(methods) || methods.includes("generateContent");
        })
        .map((entry) => {
          const name = asRecord(entry)?.name;
          if (typeof name !== "string") return "";
          // `models/gemini-3.8-flash` → `gemini-3.8-flash`
          return name.startsWith("models/") ? name.slice("models/".length) : name;
        })
        .filter((id) => id.length > 0);
    },
  },
};

function resolveApiKey(envKeys: string[]): string {
  for (const key of envKeys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return "";
}

export function hasProviderModelDiscovery(adapterType: string): boolean {
  return adapterType in PROVIDER_MODEL_DISCOVERY;
}

/**
 * Discover a harness's models from its provider's live endpoint. Returns `[]`
 * on any failure — never a hardcoded fallback.
 */
export async function discoverProviderModels(adapterType: string): Promise<AdapterModel[]> {
  const spec = PROVIDER_MODEL_DISCOVERY[adapterType];
  if (!spec) return [];
  const apiKey = resolveApiKey(spec.envKeys);
  if (!apiKey) return [];

  let rawIds: string[];
  try {
    const response = await fetch(spec.url, {
      headers: spec.headers(apiKey),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    rawIds = spec.extract(await response.json());
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const models: AdapterModel[] = [];
  for (const raw of rawIds) {
    const id = (spec.toId ? spec.toId(raw) : raw).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const display = normalizeModelDisplayName(id);
    models.push({
      id,
      label: spec.labelPrefix ? `${spec.labelPrefix} / ${display}` : display,
    });
  }
  return models.sort((a, b) =>
    a.label.localeCompare(b.label, "en", { numeric: true, sensitivity: "base" }),
  );
}
