/**
 * DeepSeek API configuration.
 *
 * Reads three environment variables:
 * - `DEEPSEEK_API_KEY` (required) — the API key for DeepSeek
 * - `DEEPSEEK_BASE_URL` (optional, default `https://api.deepseek.com`)
 * - `DEEPSEEK_MODEL` (optional, default `deepseek-v4-flash`)
 *
 * The key is checked with `trim()` for emptiness, but the original (untrimmed)
 * value is returned for use in requests. Error messages never include the key
 * value or any prefix of it.
 */

export interface DeepSeekConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** Stable error code thrown when the API key is missing or blank. */
export class DeepSeekConfigError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "DeepSeekConfigError";
  }
}

/**
 * Read and validate DeepSeek configuration from the environment.
 *
 * @param env — optional environment object (defaults to `process.env`)
 * @throws {DeepSeekConfigError} with code `DEEPSEEK_API_KEY_MISSING` if the key
 *   is empty, whitespace-only, or absent.
 */
export function getDeepSeekConfig(env?: NodeJS.ProcessEnv): DeepSeekConfig {
  const e = env ?? process.env;

  const rawKey = e.DEEPSEEK_API_KEY ?? "";
  if (!rawKey.trim()) {
    throw new DeepSeekConfigError("DEEPSEEK_API_KEY_MISSING");
  }

  const baseUrl = (e.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(
    /\/+$/,
    "",
  );
  const model = e.DEEPSEEK_MODEL ?? "deepseek-v4-flash";

  return { apiKey: rawKey, baseUrl, model };
}

/**
 * Safely check whether a DeepSeek API key is configured, without throwing.
 * Returns `true` only if the key exists and is non-blank.
 */
export function isDeepSeekConfigured(env?: NodeJS.ProcessEnv): boolean {
  try {
    getDeepSeekConfig(env);
    return true;
  } catch {
    return false;
  }
}
