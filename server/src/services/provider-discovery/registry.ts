/**
 * Provider discovery signatures.
 *
 * One entry per provider/service Paperclip knows how to recognise. Adding a
 * provider is a data change here; the scanner never needs new code. Entries
 * describe *where to look* and *how to classify a hit* — never how to spend
 * money: no signature carries a billable endpoint, and the scanner only performs
 * unauthenticated GETs against local/compatible endpoints.
 *
 * @module server/services/provider-discovery/registry
 */

export type ProviderCategory = "hosted" | "local" | "gateway" | "compatible";

export type ProviderAuthScheme = "bearer" | "x-api-key" | "none" | "aws";

export interface LocalEndpointHint {
  port: number;
  /** Model discovery path. Empty string means "no model listing". */
  modelsPath: string;
  /** `openai` uses `{data:[{id}]}`, `ollama` uses `{models:[{name}]}`. */
  modelsFormat: "openai" | "ollama" | "none";
  basePath?: string;
}

export interface ProviderSignature {
  id: string;
  label: string;
  category: ProviderCategory;
  /** Credential environment variables, most canonical first. */
  envKeys: string[];
  /** Environment variables that only point at a base URL. */
  baseUrlEnvKeys?: string[];
  defaultBaseUrl?: string;
  auth: ProviderAuthScheme;
  /** Set when the provider is known to be reachable at fixed local ports. */
  localEndpoints?: LocalEndpointHint[];
  /** Image/name fragments that identify a container running this service. */
  containerHints?: string[];
  /** Existing Paperclip setup provider key when one exists (`providerKeys` in the UI). */
  setupProviderKey?: string;
  /** Paperclip AI-connection provider id when this maps to one. */
  aiConnectionProvider?: "openai" | "anthropic" | "openrouter" | "xai";
  /** Non-billable public endpoint used only for documentation, never probed. */
  docsUrl?: string;
  notes?: string;
}

export const PROVIDER_SIGNATURES: ProviderSignature[] = [
  {
    id: "openai",
    label: "OpenAI",
    category: "hosted",
    envKeys: ["OPENAI_API_KEY", "OPENAI_KEY"],
    baseUrlEnvKeys: ["OPENAI_BASE_URL", "OPENAI_API_BASE"],
    defaultBaseUrl: "https://api.openai.com/v1",
    auth: "bearer",
    setupProviderKey: "openai",
    aiConnectionProvider: "openai",
    docsUrl: "https://platform.openai.com",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    category: "hosted",
    envKeys: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
    baseUrlEnvKeys: ["ANTHROPIC_BASE_URL"],
    defaultBaseUrl: "https://api.anthropic.com",
    auth: "x-api-key",
    setupProviderKey: "anthropic",
    aiConnectionProvider: "anthropic",
  },
  {
    id: "google",
    label: "Google Gemini",
    category: "hosted",
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"],
    baseUrlEnvKeys: ["GEMINI_BASE_URL", "GOOGLE_GENAI_BASE_URL"],
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    auth: "x-api-key",
    setupProviderKey: "google",
  },
  {
    id: "azure-openai",
    label: "Azure OpenAI",
    category: "hosted",
    envKeys: ["AZURE_OPENAI_API_KEY"],
    baseUrlEnvKeys: ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_BASE_URL"],
    auth: "x-api-key",
    notes: "Deployment names are configured per agent; the endpoint is the resource URL.",
  },
  {
    id: "aws-bedrock",
    label: "AWS Bedrock",
    category: "hosted",
    envKeys: ["AWS_ACCESS_KEY_ID", "AWS_PROFILE"],
    baseUrlEnvKeys: ["AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "AWS_REGION"],
    auth: "aws",
    notes: "Credentials are AWS IAM; model ids are region-specific.",
  },
  {
    id: "mistral",
    label: "Mistral AI",
    category: "hosted",
    envKeys: ["MISTRAL_API_KEY"],
    baseUrlEnvKeys: ["MISTRAL_BASE_URL"],
    defaultBaseUrl: "https://api.mistral.ai/v1",
    auth: "bearer",
  },
  {
    id: "cohere",
    label: "Cohere",
    category: "hosted",
    envKeys: ["COHERE_API_KEY", "CO_API_KEY"],
    defaultBaseUrl: "https://api.cohere.com",
    auth: "bearer",
  },
  {
    id: "groq",
    label: "Groq",
    category: "hosted",
    envKeys: ["GROQ_API_KEY"],
    baseUrlEnvKeys: ["GROQ_BASE_URL"],
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    auth: "bearer",
    setupProviderKey: "groq",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    category: "hosted",
    envKeys: ["DEEPSEEK_API_KEY"],
    baseUrlEnvKeys: ["DEEPSEEK_BASE_URL"],
    defaultBaseUrl: "https://api.deepseek.com/v1",
    auth: "bearer",
  },
  {
    id: "xai",
    label: "xAI",
    category: "hosted",
    envKeys: ["XAI_API_KEY", "GROK_API_KEY"],
    baseUrlEnvKeys: ["XAI_BASE_URL"],
    defaultBaseUrl: "https://api.x.ai/v1",
    auth: "bearer",
    setupProviderKey: "xai",
    aiConnectionProvider: "xai",
  },
  {
    id: "together",
    label: "Together AI",
    category: "hosted",
    envKeys: ["TOGETHER_API_KEY", "TOGETHER_AI_API_KEY"],
    defaultBaseUrl: "https://api.together.xyz/v1",
    auth: "bearer",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    category: "hosted",
    envKeys: ["FIREWORKS_API_KEY"],
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    auth: "bearer",
  },
  {
    id: "perplexity",
    label: "Perplexity",
    category: "hosted",
    envKeys: ["PERPLEXITY_API_KEY", "PPLX_API_KEY"],
    defaultBaseUrl: "https://api.perplexity.ai",
    auth: "bearer",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    category: "gateway",
    envKeys: ["OPENROUTER_API_KEY"],
    baseUrlEnvKeys: ["OPENROUTER_BASE_URL"],
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    auth: "bearer",
    setupProviderKey: "openrouter",
    aiConnectionProvider: "openrouter",
  },
  {
    id: "opencode",
    label: "OpenCode Zen",
    category: "gateway",
    envKeys: ["OPENCODE_API_KEY"],
    defaultBaseUrl: "https://opencode.ai/zen/v1",
    auth: "bearer",
    setupProviderKey: "opencode",
  },
  {
    id: "zai",
    label: "Z.AI",
    category: "hosted",
    envKeys: ["ZAI_API_KEY", "ZHIPU_API_KEY"],
    auth: "bearer",
    setupProviderKey: "zai",
  },
  {
    id: "kimi",
    label: "Kimi / Moonshot",
    category: "hosted",
    envKeys: ["KIMI_API_KEY", "KIMI_MODEL_API_KEY", "MOONSHOT_API_KEY"],
    baseUrlEnvKeys: ["KIMI_BASE_URL", "MOONSHOT_BASE_URL"],
    auth: "bearer",
    setupProviderKey: "kimi-coding",
  },
  {
    id: "minimax",
    label: "MiniMax",
    category: "hosted",
    envKeys: ["MINIMAX_API_KEY"],
    auth: "bearer",
    setupProviderKey: "minimax",
  },
  {
    id: "ollama",
    label: "Ollama",
    category: "local",
    envKeys: ["OLLAMA_API_KEY"],
    baseUrlEnvKeys: ["OLLAMA_HOST", "OLLAMA_BASE_URL"],
    defaultBaseUrl: "http://127.0.0.1:11434",
    auth: "none",
    localEndpoints: [{ port: 11434, modelsPath: "/api/tags", modelsFormat: "ollama" }],
    containerHints: ["ollama"],
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    category: "local",
    envKeys: ["LMSTUDIO_API_KEY", "LM_STUDIO_API_KEY"],
    baseUrlEnvKeys: ["LMSTUDIO_BASE_URL", "LM_STUDIO_BASE_URL"],
    defaultBaseUrl: "http://127.0.0.1:1234/v1",
    auth: "none",
    localEndpoints: [{ port: 1234, modelsPath: "/v1/models", modelsFormat: "openai" }],
    containerHints: ["lmstudio", "lm-studio"],
  },
  {
    id: "localai",
    label: "LocalAI",
    category: "local",
    envKeys: ["LOCALAI_API_KEY"],
    baseUrlEnvKeys: ["LOCALAI_BASE_URL"],
    defaultBaseUrl: "http://127.0.0.1:8080/v1",
    auth: "none",
    localEndpoints: [{ port: 8080, modelsPath: "/v1/models", modelsFormat: "openai" }],
    containerHints: ["localai"],
  },
  {
    id: "vllm",
    label: "vLLM",
    category: "local",
    envKeys: ["VLLM_API_KEY"],
    baseUrlEnvKeys: ["VLLM_BASE_URL", "VLLM_API_BASE"],
    defaultBaseUrl: "http://127.0.0.1:8000/v1",
    auth: "none",
    localEndpoints: [{ port: 8000, modelsPath: "/v1/models", modelsFormat: "openai" }],
    containerHints: ["vllm"],
  },
  {
    id: "litellm",
    label: "LiteLLM proxy",
    category: "gateway",
    envKeys: ["LITELLM_API_KEY", "LITELLM_MASTER_KEY"],
    baseUrlEnvKeys: ["LITELLM_BASE_URL"],
    defaultBaseUrl: "http://127.0.0.1:4000",
    auth: "bearer",
    localEndpoints: [{ port: 4000, modelsPath: "/v1/models", modelsFormat: "openai" }],
    containerHints: ["litellm"],
  },
];

const BY_ID = new Map(PROVIDER_SIGNATURES.map((signature) => [signature.id, signature]));

export function getProviderSignature(id: string): ProviderSignature | undefined {
  return BY_ID.get(id);
}

/**
 * Generic OpenAI-compatible base-URL variables.
 *
 * These do not prove which provider is behind the URL, so they always produce a
 * `compatible` candidate that must be verified by probing its model list.
 */
export const GENERIC_BASE_URL_ENV_KEYS = [
  "OPENAI_COMPATIBLE_BASE_URL",
  "AI_BASE_URL",
  "LLM_BASE_URL",
  "LLM_API_BASE",
  "API_BASE_URL",
] as const;

/** Placeholder values that mean "not configured" rather than "credential present". */
export const PLACEHOLDER_CREDENTIAL_VALUES = new Set([
  "changeme",
  "change-me",
  "your-api-key",
  "your_api_key",
  "sk-xxx",
  "sk-your-key",
  "xxx",
  "test",
  "dummy",
  "example",
  "none",
  "null",
  "undefined",
]);

/** Bounded allowlist of config files that may carry provider settings. */
export interface ConfigFileRule {
  /** Path relative to the user's home directory; `*` expands the platform app-data roots. */
  relativePath: string;
  format: "json" | "text";
  /** provider id → how to read it out of the parsed JSON. */
  jsonProviderKeys?: Record<string, { credentialKeys?: string[]; baseUrlKeys?: string[] }>;
  /** Regexes for text formats; capture group 1 is the value. */
  textPatterns?: Array<{ providerId: string; baseUrl?: RegExp; credential?: RegExp }>;
}

export const CONFIG_FILE_RULES: ConfigFileRule[] = [
  {
    relativePath: ".config/opencode/auth.json",
    format: "json",
    jsonProviderKeys: {
      openai: { credentialKeys: ["key", "access"] },
      anthropic: { credentialKeys: ["key"] },
      openrouter: { credentialKeys: ["key"] },
      deepseek: { credentialKeys: ["key"] },
      groq: { credentialKeys: ["key"] },
      google: { credentialKeys: ["key"] },
      xai: { credentialKeys: ["key"] },
      opencode: { credentialKeys: ["key"] },
    },
  },
  {
    relativePath: ".local/share/opencode/auth.json",
    format: "json",
    jsonProviderKeys: {
      openai: { credentialKeys: ["key", "access"] },
      anthropic: { credentialKeys: ["key"] },
      openrouter: { credentialKeys: ["key"] },
      deepseek: { credentialKeys: ["key"] },
      groq: { credentialKeys: ["key"] },
      google: { credentialKeys: ["key"] },
      xai: { credentialKeys: ["key"] },
      opencode: { credentialKeys: ["key"] },
    },
  },
  {
    relativePath: ".config/litellm/config.yaml",
    format: "text",
    textPatterns: [
      {
        providerId: "litellm",
        baseUrl: /^\s*api_base:\s*["']?([^"'\s]+)["']?\s*$/im,
        credential: /^\s*api_key:\s*["']?([^"'\s]+)["']?\s*$/im,
      },
    ],
  },
  {
    relativePath: ".continue/config.json",
    format: "json",
    jsonProviderKeys: {
      openai: { credentialKeys: ["apiKey"], baseUrlKeys: ["apiBase"] },
      anthropic: { credentialKeys: ["apiKey"] },
      ollama: { baseUrlKeys: ["apiBase"] },
    },
  },
];
