import type {
  Provider,
  ProviderMessage,
  ProviderResponse,
  ProviderRequestOptions,
  ProviderResponseDiagnostics,
  ProviderTokenUsageSample,
  ProviderUsageTags,
} from "./types.js";
import type { DeepSeekConfig } from "../config/deepseekConfig.js";
import type { RunCallBudget } from "./runBudget.js";
import { sha256Hex } from "../runtime/capabilityAdapter.js";

/**
 * Stable provider failure codes (P1 任务 1). Every 2xx anomaly gets a
 * deterministic code; only transport-level failures (network, timeout,
 * HTTP 429/5xx) stay retryable.
 */
export type OpenAICompatibleErrorCode =
  | "PROVIDER_NETWORK_ERROR"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_NON_JSON_BODY"
  | "PROVIDER_NO_CHOICES"
  | "PROVIDER_UNSUPPORTED_SCHEMA"
  | "PROVIDER_EMPTY_RESPONSE"
  | "PROVIDER_TRUNCATED_OUTPUT";

/**
 * Named error thrown by {@link OpenAICompatibleProvider}. The adapter never
 * silently switches to scripted mode: a missing key or an anomalous
 * response is surfaced as this error so callers can fail loudly.
 *
 * The message, the code and the diagnostics carry at most the HTTP status
 * code, the provider name, and safe counters/flags. They NEVER include
 * the API key, the Authorization header, the full request body, the
 * response body, reasoning content, or the full baseUrl.
 */
export class OpenAICompatibleProviderError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: OpenAICompatibleErrorCode;
  /**
   * Transport-level retryability: ONLY network failures, timeouts and
   * HTTP 429/5xx are retryable. Every 2xx anomaly (empty content, length
   * truncation, schema deviation, non-JSON body) is deterministic for the
   * identical request, so retrying would only waste spend.
   */
  readonly retryable: boolean;
  /** HTTP status when a response was received; undefined on network errors. */
  readonly httpStatus?: number;
  /** Safe response diagnostics when a body was parsed or a status read. */
  readonly diagnostics?: ProviderResponseDiagnostics;

  constructor(
    code: OpenAICompatibleErrorCode,
    message: string,
    options: { retryable?: boolean; httpStatus?: number; diagnostics?: ProviderResponseDiagnostics } = {},
  ) {
    super(message);
    this.name = "OpenAICompatibleProviderError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus;
    this.diagnostics = options.diagnostics;
  }
}

/** Bounded transport-retry policy for one logical chat call. */
export interface ProviderRetryOptions {
  /** Retries after the first attempt (default 2 → at most 3 HTTP attempts). */
  maxRetries?: number;
  /** Sleep between attempts; injectable so tests never wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Shared run-wide accounting + caps. When present, every HTTP attempt is
   * counted and each retry must spend from the separately authorized
   * transport-retry budget. Current U1 supplies a dynamic logical H; legacy
   * callers retain their own explicit limits.
   */
  budget?: RunCallBudget;
  /**
   * Per-response output ceiling forwarded as the Chat Completions
   * `max_tokens` parameter. This is a per-response cap, NOT a total-run
   * token budget — the run-level total is observed via token telemetry.
   */
  maxOutputTokens?: number;
  /**
   * Billing role (P1 任务 2): every HTTP attempt and retry this provider
   * spends is tagged with it in the shared budget, so reports can tell
   * evaluator traffic apart from bootstrap/mutation/repair/direct-refine
   * traffic without splitting the ledger.
   */
  role?: string;
  /**
   * Provider-level telemetry identity. It is copied on construction and never
   * sent over the wire; per-call tags may refine it without shared mutation.
   * The configured model and explicit billing role remain authoritative.
   */
  usageTags?: Readonly<ProviderUsageTags>;
  /**
   * Optional DeepSeek thinking-mode override. Omit it to preserve the
   * provider default; strict-JSON writer roles may explicitly disable it so
   * the billed completion is the final document rather than reasoning only.
   */
  thinking?: "enabled" | "disabled";
}

/** Minimal subset of a Chat Completions response that this adapter reads. */
interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: unknown; reasoning_content?: unknown };
    finish_reason?: unknown;
  }>;
  usage?: {
    prompt_tokens?: unknown;
    prompt_cache_hit_tokens?: unknown;
    prompt_cache_miss_tokens?: unknown;
    completion_tokens?: unknown;
  };
}

function tokenCountOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function usageOf(data: ChatCompletionResponse): ProviderTokenUsageSample {
  const usagePresent =
    data.usage !== undefined &&
    data.usage !== null &&
    typeof data.usage === "object" &&
    !Array.isArray(data.usage);
  if (!usagePresent) {
    return {
      usagePresent: false,
      promptTokens: null,
      promptCacheHitTokens: null,
      promptCacheMissTokens: null,
      completionTokens: null,
    };
  }
  return {
    usagePresent: true,
    promptTokens: tokenCountOrNull(data.usage?.prompt_tokens),
    promptCacheHitTokens: tokenCountOrNull(data.usage?.prompt_cache_hit_tokens),
    promptCacheMissTokens: tokenCountOrNull(data.usage?.prompt_cache_miss_tokens),
    completionTokens: tokenCountOrNull(data.usage?.completion_tokens),
  };
}

/**
 * Build the safe diagnostics block for one parsed 2xx response. Counters
 * and flags only — safe to print anywhere.
 */
function diagnosticsOf(
  data: ChatCompletionResponse,
  usage: ProviderTokenUsageSample,
): ProviderResponseDiagnostics {
  const first = Array.isArray(data.choices) ? data.choices[0] : undefined;
  const content = first?.message?.content;
  return {
    httpStatus: 200,
    choiceCount: Array.isArray(data.choices) ? data.choices.length : 0,
    contentLength: typeof content === "string" ? content.length : 0,
    finishReason: typeof first?.finish_reason === "string" ? first.finish_reason : null,
    usagePresent: usage.usagePresent,
    usage: usage.usagePresent
      ? {
          promptTokens: usage.promptTokens,
          promptCacheHitTokens: usage.promptCacheHitTokens,
          promptCacheMissTokens: usage.promptCacheMissTokens,
          completionTokens: usage.completionTokens,
        }
      : null,
    reasoningContentPresent: typeof first?.message?.reasoning_content === "string",
  };
}

/**
 * An OpenAI-compatible provider adapter that talks to a DeepSeek
 * `/chat/completions` endpoint.
 *
 * - Receives an explicit {@link DeepSeekConfig} — does NOT read any environment
 *   variable directly.
 * - Posts to `${baseUrl}/chat/completions` (baseUrl trailing slashes are stripped
 *   to prevent double slashes).
 * - When `options.responseFormat === "json_object"`, includes
 *   `response_format: { type: "json_object" }` in the request body.
 * - Returns `choices[0].message.content`.
 * - Throws {@link OpenAICompatibleProviderError} for a network failure, a
 *   non-2xx status, or a malformed response body. Error messages never include
 *   the API key.
 */
export class OpenAICompatibleProvider implements Provider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly budget?: RunCallBudget;
  private readonly maxOutputTokens?: number;
  private readonly role?: string;
  private readonly usageTags: Readonly<ProviderUsageTags>;
  private readonly thinking?: "enabled" | "disabled";

  constructor(config: DeepSeekConfig, requestTimeoutMs = 60_000, retry: ProviderRetryOptions = {}) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.model = config.model;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxRetries = retry.maxRetries ?? 2;
    this.sleep = retry.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.budget = retry.budget;
    this.maxOutputTokens = retry.maxOutputTokens;
    this.role = retry.role;
    this.usageTags = Object.freeze({
      ...retry.usageTags,
      role: retry.role ?? retry.usageTags?.role,
      model: config.model,
    });
    this.thinking = retry.thinking;
  }

  /**
   * Desensitized provider-configuration fingerprint for cache keys: a hash
   * of baseUrl + model + request timeout + max-output behavior + thinking mode. The API key NEVER participates —
   * rotating a credential must not invalidate cached answers, and the
   * fingerprint must never leak the secret.
   */
  configFingerprint(): string {
    return sha256Hex(
      `${this.baseUrl}\u0000${this.model}\u0000${this.requestTimeoutMs}\u0000${this.maxOutputTokens ?? "provider-default"}\u0000${this.thinking ?? "provider-default"}`,
    ).slice(0, 24);
  }

  /** Safe base-URL identity for request/cache evidence; the URL itself is never returned. */
  endpointIdentity(): string {
    return sha256Hex(this.baseUrl).slice(0, 24);
  }

  /**
   * One logical chat call with bounded transport-level retries (429/5xx,
   * network, timeout, malformed body). A retry re-sends the SAME request; it
   * never alters prompts, gates, or evolution semantics. Non-retryable errors
   * (4xx other than 429) fail immediately. The last error is rethrown
   * unchanged so callers and messages stay exactly as before.
   */
  async chat(
    messages: ProviderMessage[],
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        // Global run budget gate: throws ProviderBudgetError when the shared
        // retry budget is spent — before any further HTTP request is sent.
        this.budget?.enterRetry(this.role);
        await this.sleep(500 * 2 ** (attempt - 1));
      }
      this.budget?.enterHttpAttempt(this.role);
      try {
        return await this.attemptChat(messages, options);
      } catch (e) {
        // Budget violations and unexpected errors are fatal, never retried.
        if (!(e instanceof OpenAICompatibleProviderError)) throw e;
        if (!e.retryable) throw e;
        lastError = e;
      }
    }
    throw lastError;
  }

  /**
   * A single HTTP attempt of {@link chat}.
   */
  private async attemptChat(
    messages: ProviderMessage[],
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const usageTags: Readonly<ProviderUsageTags> = Object.freeze({
      ...this.usageTags,
      ...options?.usageTags,
      role: this.role ?? options?.usageTags?.role ?? this.usageTags.role,
      model: this.model,
    });
    const fail = (
      code: OpenAICompatibleErrorCode,
      message: string,
      errorOptions: { retryable?: boolean; httpStatus?: number; diagnostics?: ProviderResponseDiagnostics } = {},
    ): OpenAICompatibleProviderError =>
      new OpenAICompatibleProviderError(
        code,
        `${code}: ${message}${this.role === undefined ? "" : ` [role=${this.role}]`}`,
        errorOptions,
      );
    const url = `${this.baseUrl}/chat/completions`;

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
    };

    if (options?.responseFormat === "json_object") {
      body.response_format = { type: "json_object" };
    }
    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (this.maxOutputTokens !== undefined) {
      body.max_tokens = this.maxOutputTokens;
    }
    if (this.thinking !== undefined) {
      body.thinking = { type: this.thinking };
    }

    const controller = new AbortController();
    const timeoutFailure = (): OpenAICompatibleProviderError =>
      fail(
        "PROVIDER_TIMEOUT",
        `Request timed out after ${this.requestTimeoutMs}ms calling provider (deepseek).`,
        { retryable: true },
      );
    let rejectTimeout!: (reason?: unknown) => void;
    // AbortSignal is advisory at the transport boundary: some proxies can
    // leave fetch pending after it is aborted. Race every awaited response
    // phase against an independent rejection so the configured cap is an
    // actual caller-visible deadline, not merely a cancellation request.
    const timeoutPromise: Promise<never> = new Promise((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timeout = setTimeout(() => {
      rejectTimeout(timeoutFailure());
      controller.abort();
    }, this.requestTimeoutMs);
    const withinTimeout = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, timeoutPromise]);
    try {
      let res: Response;
      try {
        res = await withinTimeout(fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }));
      } catch (e) {
        if (e instanceof OpenAICompatibleProviderError) throw e;
        if (controller.signal.aborted) {
          throw timeoutFailure();
        }
        throw fail(
          "PROVIDER_NETWORK_ERROR",
          `Network error calling provider (deepseek): ${errMsg(e)}`,
          { retryable: true },
        );
      }

      if (!res.ok) {
        const safeSummary = await withinTimeout(safeResponseSummary(res));
        if (controller.signal.aborted) {
          throw timeoutFailure();
        }
        const retryable = res.status === 429 || res.status >= 500;
        throw fail(
          "PROVIDER_HTTP_ERROR",
          `HTTP ${res.status} from provider (deepseek): ${safeSummary}`,
          { retryable, httpStatus: res.status },
        );
      }

      let data: ChatCompletionResponse;
      try {
        data = (await withinTimeout(res.json() as Promise<ChatCompletionResponse>)) as ChatCompletionResponse;
      } catch (e) {
        if (e instanceof OpenAICompatibleProviderError) throw e;
        if (controller.signal.aborted) {
          throw timeoutFailure();
        }
        throw fail(
          "PROVIDER_NON_JSON_BODY",
          "Provider (deepseek) returned HTTP 200 but the body is not valid JSON; refusing to guess a response.",
          { httpStatus: res.status },
        );
      }

      const usage = usageOf(data);
      const diagnostics = diagnosticsOf(data, usage);
      // A failing parsed response is billable only when the provider actually
      // supplied a usage block. Successful responses without usage are still
      // sampled below as explicitly missing/unknown.
      if (usage.usagePresent) {
        this.budget?.recordTokenUsage(usage, usageTags);
      }
      const first = Array.isArray(data.choices) ? data.choices[0] : undefined;

      if (!Array.isArray(data.choices) || data.choices.length === 0) {
        throw fail(
          "PROVIDER_NO_CHOICES",
          `Provider (deepseek) returned HTTP 200 with no choices (choiceCount=${diagnostics.choiceCount}, finishReason=${diagnostics.finishReason ?? "absent"}, usagePresent=${diagnostics.usagePresent}).`,
          { httpStatus: res.status, diagnostics },
        );
      }

      const content = first?.message?.content;
      if (typeof content !== "string") {
        throw fail(
          "PROVIDER_UNSUPPORTED_SCHEMA",
          `Provider (deepseek) returned HTTP 200 but choices[0].message.content is ${content === undefined ? "absent" : `of type ${typeof content}`}; the adapter only reads string content and never substitutes reasoning_content.`,
          { httpStatus: res.status, diagnostics },
        );
      }

      if (diagnostics.finishReason === "length") {
      // A length-finished response is truncated: even non-empty content is
      // an unusable partial document (strict JSON cannot parse). This is
      // deterministic for the identical request — no retry.
        throw fail(
        "PROVIDER_TRUNCATED_OUTPUT",
        `Provider (deepseek) truncated the response at the max_tokens ceiling (finishReason=length, contentLength=${diagnostics.contentLength}); the strict full-replacement JSON contract cannot be satisfied by a truncated answer, so the call fails deterministically without retry. Raise the explicitly authorized max output tokens if the operator approves.`,
        { httpStatus: res.status, diagnostics },
      );
      }

      if (content.length === 0) {
        throw fail(
        "PROVIDER_EMPTY_RESPONSE",
        `Provider (deepseek) returned HTTP 200 with empty content (finishReason=${diagnostics.finishReason ?? "absent"}, choiceCount=${diagnostics.choiceCount}, usagePresent=${diagnostics.usagePresent}, reasoningContentPresent=${diagnostics.reasoningContentPresent}); reasoning_content is never substituted for the answer.`,
        { httpStatus: res.status, diagnostics },
      );
      }

      if (!usage.usagePresent) {
        this.budget?.recordTokenUsage(usage, usageTags);
      }

      return {
        content,
        promptTokens: usage.promptTokens ?? undefined,
        completionTokens: usage.completionTokens ?? undefined,
        promptCacheHitTokens: usage.promptCacheHitTokens,
        promptCacheMissTokens: usage.promptCacheMissTokens,
        diagnostics,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Best-effort error-message extraction for unknown caught values. */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Size-only summary of a non-OK HTTP response body. The body TEXT is
 * never surfaced — not even truncated — because an error body may echo
 * request material; only its byte length is reported.
 */
async function safeResponseSummary(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return text.length === 0 ? "(empty response body)" : `(response body: ${text.length} bytes, content withheld)`;
}
