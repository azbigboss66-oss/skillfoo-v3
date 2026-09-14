/**
 * One explicit configuration contract for every live OpenAI-compatible
 * endpoint. The adapter never guesses a vendor, endpoint, model, or auth mode.
 */

export type LlmAuthMode = "bearer" | "none";
export type LlmRequestPreset = "portable" | "deepseek";
export type LlmJsonMode = "json_object" | "omitted";
export type LlmMaxTokensField = "max_tokens" | "max_completion_tokens";
export type LlmReasoningMode =
  | "provider-default"
  | "thinking-enabled"
  | "thinking-disabled"
  | "effort-none"
  | "effort-minimal"
  | "effort-low"
  | "effort-medium"
  | "effort-high"
  | "effort-xhigh";

export interface LlmRequestProfile {
  readonly preset: LlmRequestPreset;
  readonly jsonMode: LlmJsonMode;
  readonly reasoningMode: LlmReasoningMode;
  readonly maxTokensField: LlmMaxTokensField;
}

export interface LlmConfig {
  /** Present only for bearer auth. It is never part of persisted identity. */
  readonly apiKey?: string;
  readonly authMode: LlmAuthMode;
  /** Normalized operator-supplied base path, without trailing slash. */
  readonly baseUrl: string;
  /** Normalized Chat Completions endpoint; `/chat/completions` appears once. */
  readonly endpoint: string;
  readonly model: string;
  readonly requestProfile: LlmRequestProfile;
}

export class LlmConfigError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "LlmConfigError";
  }
}

const LEGACY_KEYS = ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL"] as const;

function required(env: NodeJS.ProcessEnv, key: "LLM_BASE_URL" | "LLM_MODEL" | "LLM_AUTH_MODE"): string {
  const value = env[key]?.trim();
  if (value) return value;
  const legacyPresent = LEGACY_KEYS.some((legacyKey) => Boolean(env[legacyKey]?.trim()));
  if (legacyPresent) {
    throw new LlmConfigError(
      "LLM_LEGACY_ENV_UNSUPPORTED",
      "LLM_LEGACY_ENV_UNSUPPORTED: migrate DEEPSEEK_* to explicit LLM_BASE_URL, LLM_MODEL, LLM_AUTH_MODE and LLM_API_KEY; legacy variables are never loaded as a fallback",
    );
  }
  throw new LlmConfigError(`${key}_MISSING`, `${key}_MISSING: ${key} must be set explicitly`);
}

export function normalizeChatCompletionsEndpoint(rawBaseUrl: string): {
  baseUrl: string;
  endpoint: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl.trim());
  } catch {
    throw new LlmConfigError("LLM_BASE_URL_INVALID", "LLM_BASE_URL_INVALID: expected an absolute HTTP or HTTPS URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new LlmConfigError("LLM_BASE_URL_INVALID", "LLM_BASE_URL_INVALID: only HTTP and HTTPS endpoints are supported");
  }
  if (parsed.username || parsed.password) {
    throw new LlmConfigError("LLM_BASE_URL_CREDENTIALS_FORBIDDEN", "LLM_BASE_URL_CREDENTIALS_FORBIDDEN: URL credentials are not allowed");
  }
  if (parsed.search || parsed.hash) {
    throw new LlmConfigError("LLM_BASE_URL_INVALID", "LLM_BASE_URL_INVALID: query strings and fragments are not valid endpoint identity");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  const baseUrl = `${parsed.origin}${pathname}`;
  const endpoint = pathname.endsWith("/chat/completions")
    ? baseUrl
    : `${baseUrl}/chat/completions`;
  return { baseUrl, endpoint };
}

function enumValue<T extends string>(
  raw: string | undefined,
  fallback: T,
  allowed: readonly T[],
  code: string,
): T {
  const value = (raw?.trim() || fallback) as T;
  if (!allowed.includes(value)) {
    throw new LlmConfigError(code, `${code}: expected one of ${allowed.join(", ")}`);
  }
  return value;
}

export function getLlmConfig(options: {
  env?: NodeJS.ProcessEnv;
  preset?: LlmRequestPreset;
} = {}): LlmConfig {
  const env = options.env ?? process.env;
  const preset = options.preset ?? "portable";
  const rawBaseUrl = required(env, "LLM_BASE_URL");
  const model = required(env, "LLM_MODEL");
  const authMode = enumValue(
    required(env, "LLM_AUTH_MODE").toLowerCase(),
    "none",
    ["bearer", "none"] as const,
    "LLM_AUTH_MODE_INVALID",
  );
  const rawKey = env.LLM_API_KEY ?? "";
  if (authMode === "bearer" && !rawKey.trim()) {
    throw new LlmConfigError("LLM_API_KEY_MISSING", "LLM_API_KEY_MISSING: bearer auth requires a non-empty LLM_API_KEY");
  }
  const normalized = normalizeChatCompletionsEndpoint(rawBaseUrl);
  const jsonMode = enumValue(
    env.LLM_JSON_MODE,
    preset === "deepseek" ? "json_object" : "omitted",
    ["json_object", "omitted"] as const,
    "LLM_JSON_MODE_INVALID",
  );
  const reasoningMode = enumValue(
    env.LLM_REASONING_MODE,
    preset === "deepseek" ? "thinking-disabled" : "provider-default",
    [
      "provider-default",
      "thinking-enabled",
      "thinking-disabled",
      "effort-none",
      "effort-minimal",
      "effort-low",
      "effort-medium",
      "effort-high",
      "effort-xhigh",
    ] as const,
    "LLM_REASONING_MODE_INVALID",
  );
  const maxTokensField = enumValue(
    env.LLM_MAX_TOKENS_FIELD,
    "max_tokens",
    ["max_tokens", "max_completion_tokens"] as const,
    "LLM_MAX_TOKENS_FIELD_INVALID",
  );
  return Object.freeze({
    ...(authMode === "bearer" ? { apiKey: rawKey.trim() } : {}),
    authMode,
    ...normalized,
    model,
    requestProfile: Object.freeze({ preset, jsonMode, reasoningMode, maxTokensField }),
  });
}

export function isLlmConfigured(options: {
  env?: NodeJS.ProcessEnv;
  preset?: LlmRequestPreset;
} = {}): boolean {
  try {
    getLlmConfig(options);
    return true;
  } catch {
    return false;
  }
}
