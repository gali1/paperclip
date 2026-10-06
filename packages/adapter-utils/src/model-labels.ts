/**
 * Human-facing labels for OpenCode model ids.
 *
 * Raw model ids are tuned for APIs, not people (`claude-opus-5-5`,
 * `gpt-5.2-codex`, `deepseek-v4.1-flash`). This module turns an id into a
 * display name without ever changing the canonical id, and derives the model
 * family so a label can read `OpenCode Zen / DeepSeek V4.1 Flash`.
 *
 * The rules are generic on purpose: a brand-new model id normalizes sensibly
 * without a new table entry. Only token *capitalization* is table-driven.
 */

/** Canonical capitalization for the tokens that make up model ids. */
const TOKEN_LABELS: Record<string, string> = {
  // Anthropic
  claude: "Claude",
  anthropic: "Anthropic",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
  // OpenAI
  gpt: "GPT",
  openai: "OpenAI",
  codex: "Codex",
  sol: "Sol",
  luna: "Luna",
  terra: "Terra",
  astra: "Astra",
  spark: "Spark",
  mini: "Mini",
  nano: "Nano",
  pro: "Pro",
  max: "Max",
  o: "o",
  // Google
  gemini: "Gemini",
  google: "Google",
  flash: "Flash",
  lite: "Lite",
  // xAI
  grok: "Grok",
  xai: "xAI",
  build: "Build",
  // Moonshot / Kimi
  kimi: "Kimi",
  moonshot: "Moonshot",
  // DeepSeek
  deepseek: "DeepSeek",
  vision: "Vision",
  // Qwen
  qwen: "Qwen",
  plus: "Plus",
  // Zhipu
  glm: "GLM",
  zhipu: "Zhipu",
  // Others
  minimax: "MiniMax",
  mimo: "Mimo",
  omni: "Omni",
  muse: "Muse",
  contributor: "Contributor",
  longcat: "LongCat",
  preview: "Preview",
  space: "Space",
  bunny: "Bunny",
  big: "Big",
  pickle: "Pickle",
  hy: "Hy",
  omen: "Omen",
  jev: "JEV",
  nemotron: "Nemotron",
  ling: "Ling",
  fledge: "Fledge",
  ultra: "Ultra",
  lightning: "Lightning",
  // Qualifiers
  exp: "Experimental",
  experimental: "Experimental",
  free: "Free",
  code: "Code",
  coder: "Coder",
  instruct: "Instruct",
  chat: "Chat",
  turbo: "Turbo",
  // Version single-letter prefixes (joined to the following number)
  v: "V",
  k: "K",
  m: "M",
};

/** A single-letter version prefix such as `v4`, `k2.7`, `m3` — joined tight. */
const VERSION_PREFIXES = new Set(["V", "K", "M"]);

const NUMERIC_RE = /^\d+(?:\.\d+)*$/;

/** Split `qwen3.8` → ["qwen", "3.8"], `m3` → ["m", "3"], `gpt` → ["gpt"]. */
function expandToken(token: string): string[] {
  const match = token.match(/^([A-Za-z]+)(.*)$/);
  if (!match) return [token];
  const [, alpha, rest] = match;
  return rest ? [alpha, rest] : [alpha];
}

function labelFor(token: string): string {
  const known = TOKEN_LABELS[token.toLowerCase()];
  if (known) return known;
  return token.length > 0 ? token[0]!.toUpperCase() + token.slice(1) : token;
}

/**
 * Normalize a raw model id into a human display name. The canonical id is
 * never mutated — this is presentation only.
 */
export function normalizeModelDisplayName(id: string): string {
  const parts = id
    .split("-")
    .flatMap(expandToken)
    .filter((part) => part.length > 0);

  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i]!;
    if (NUMERIC_RE.test(token)) {
      // Collapse `5 - 5` → `5.5`, `4 - 6` → `4.6`.
      let number = token;
      while (i + 1 < parts.length && NUMERIC_RE.test(parts[i + 1]!)) {
        number += `.${parts[++i]!}`;
      }
      const previous = out[out.length - 1];
      if (previous === "GPT") {
        // `gpt-5.2` reads as GPT-5.2, not GPT 5.2.
        out[out.length - 1] = `GPT-${number}`;
      } else if (previous && VERSION_PREFIXES.has(previous)) {
        // `v4.1` → V4.1, `k2.7` → K2.7, `m3` → M3.
        out[out.length - 1] = `${previous}${number}`;
      } else {
        out.push(number);
      }
      continue;
    }
    out.push(labelFor(token));
  }

  return out
    .join(" ")
    .replace(/ Free$/, " — Free")
    .replace(/ Experimental$/, " — Experimental");
}

interface ModelFamily {
  name: string;
  /** Lowercased tokens whose presence in the display name implies the family. */
  tokens: string[];
}

const FAMILIES: ModelFamily[] = [
  { name: "Anthropic", tokens: ["anthropic", "claude", "opus", "sonnet", "haiku"] },
  { name: "OpenAI", tokens: ["openai", "gpt", "codex", "sol", "luna", "terra", "astra"] },
  { name: "Google Gemini", tokens: ["google", "gemini"] },
  { name: "xAI Grok", tokens: ["xai", "grok"] },
  { name: "Kimi", tokens: ["kimi", "moonshot"] },
  { name: "DeepSeek", tokens: ["deepseek"] },
  { name: "Qwen", tokens: ["qwen", "alibaba"] },
  { name: "GLM", tokens: ["glm", "zhipu"] },
  { name: "MiniMax", tokens: ["minimax"] },
  { name: "Mimo", tokens: ["mimo"] },
  { name: "Muse", tokens: ["muse"] },
  { name: "Nemotron", tokens: ["nemotron"] },
  { name: "LongCat", tokens: ["longcat"] },
  { name: "Ling", tokens: ["ling"] },
  { name: "Fledge", tokens: ["fledge"] },
  { name: "JEV", tokens: ["jev"] },
  { name: "Hy", tokens: ["hy"] },
  { name: "Omen", tokens: ["omen"] },
];

function familyForModel(id: string): ModelFamily | undefined {
  const lower = id.toLowerCase();
  return FAMILIES.find((family) =>
    family.tokens.some((token) => lower.includes(token)),
  );
}

/**
 * Build the display label for one model id under a given OpenCode tier
 * (`OpenCode Zen`, `OpenCode Zen Go`, `OpenCode Interface`).
 *
 * When the normalized name already names the family (`DeepSeek V4.1 Flash`)
 * the family is not repeated; when it does not (`GPT-5.2 Codex`) the family is
 * inserted so the label still says which provider the model belongs to.
 */
export function buildOpenCodeModelLabel(tier: string, id: string): string {
  const display = normalizeModelDisplayName(id);
  const family = familyForModel(id);
  const displayLower = display.toLowerCase();
  const familyNamed = family
    ? family.tokens.some((token) => displayLower.includes(token))
    : false;
  const prefix = family && !familyNamed ? `${family.name} / ` : "";
  return `${tier} / ${prefix}${display}`;
}
